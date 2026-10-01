#!/usr/bin/env python3
"""Novda  activation administrator bot.

The bot owns the Ed25519 private key. All persistent activation state is read
and written through the  API; it has no database client.
"""

import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from license_payload import canonical_activation_payload


PINNED_PUBLIC_KEY_FINGERPRINT = "8b563c50537fc5b44852626f8da69bb69c1ce4a72d3dec3ae0af20a557bf314c"
ADMIN_WEBAPP_CANONICAL_URL = "https://sync.novdatextile.uz/admin-app"
ACTIVATION_ROLES = {"admin", "type", "print"}
BOT_TOKEN = ""
ADMIN_API_TOKEN = ""
ADMIN_IDS = set()
LICENSE_PRIVATE_KEY = None
API_BASE_URL = ""
ADMIN_WEBAPP_URL = ""
ADMIN_WEBAPP_SESSION_SECRET = ""
PORT = int(os.environ.get("PORT", "8080"))
LAST_TELEGRAM_SUCCESS = 0.0
CONFIGURATION_READY = False
TELEGRAM_CONNECTED = False
ADMIN_WEBAPP_READY = False
NOTIFIED_REQUEST_IDS = set()
PENDING_NOTIFICATION_WARMED = False
ADMIN_WEBAPP_AUTH_MAX_AGE_SECONDS = 5 * 60
ADMIN_WEBAPP_FUTURE_SKEW_SECONDS = 60
ADMIN_WEBAPP_SESSION_SECONDS = 15 * 60


def read_secret(env_name, file_env_name=None):
    file_path = os.environ.get(file_env_name or f"{env_name}_FILE", "").strip()
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as secret_file:
                return secret_file.read().strip()
        except OSError:
            return ""
    return os.environ.get(env_name, "").strip()


def load_admin_ids(raw=None):
    value = read_secret("NOVDA_ADMIN_TELEGRAM_IDS") if raw is None else str(raw)
    return {item for item in value.replace(",", " ").split() if item.isdigit() and len(item) <= 24}


def _auth_error(code):
    return ValueError(code)


def _normalized_admin_ids(allowed_ids):
    values = allowed_ids if isinstance(allowed_ids, (set, list, tuple)) else ()
    return {str(value).strip() for value in values if str(value).strip().isdigit() and len(str(value).strip()) <= 24}


def _urlsafe_encode(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _urlsafe_decode(value):
    if not isinstance(value, str) or not value or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for char in value):
        raise _auth_error("ADMIN_SESSION_INVALID")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _urlsafe_encode(decoded) != value:
        raise _auth_error("ADMIN_SESSION_INVALID")
    return decoded


def validate_webapp_init_data(init_data, bot_token, allowed_ids, now=None):
    """Verify Telegram WebApp initData and enforce the configured admin allowlist."""
    if not isinstance(init_data, str) or not init_data or len(init_data) > 8192 or not bot_token:
        raise _auth_error("WEBAPP_AUTH_INVALID")
    try:
        pairs = urllib.parse.parse_qsl(init_data, keep_blank_values=True, strict_parsing=True, max_num_fields=64)
        fields = {}
        for key, value in pairs:
            if key in fields:
                raise _auth_error("WEBAPP_AUTH_INVALID")
            fields[key] = value
        supplied_hash = fields.pop("hash", "")
        if not re.fullmatch(r"[a-f0-9]{64}", supplied_hash):
            raise _auth_error("WEBAPP_AUTH_INVALID")
        auth_date = int(fields.get("auth_date", ""))
        user = json.loads(fields.get("user", ""))
        if not isinstance(user, dict) or isinstance(user.get("id"), bool):
            raise _auth_error("WEBAPP_AUTH_INVALID")
        telegram_id = str(user.get("id", ""))
        if not re.fullmatch(r"\d{1,24}", telegram_id):
            raise _auth_error("WEBAPP_AUTH_INVALID")

        data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
        secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
        expected_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_hash, supplied_hash):
            raise _auth_error("WEBAPP_AUTH_INVALID")

        current_time = int(time.time()) if now is None else int(now)
        if auth_date <= 0 or auth_date > current_time + ADMIN_WEBAPP_FUTURE_SKEW_SECONDS:
            raise _auth_error("WEBAPP_AUTH_INVALID")
        if current_time - auth_date > ADMIN_WEBAPP_AUTH_MAX_AGE_SECONDS:
            raise _auth_error("WEBAPP_AUTH_EXPIRED")
        if telegram_id not in _normalized_admin_ids(allowed_ids):
            raise _auth_error("ADMIN_TELEGRAM_ID_NOT_AUTHORIZED")

        safe_user = {key: user[key] for key in ("id", "first_name", "last_name", "username", "language_code") if key in user}
        return {"telegramId": telegram_id, "user": safe_user, "authDate": auth_date}
    except ValueError as error:
        if str(error) in {
            "WEBAPP_AUTH_INVALID",
            "WEBAPP_AUTH_EXPIRED",
            "ADMIN_TELEGRAM_ID_NOT_AUTHORIZED",
        }:
            raise
        raise _auth_error("WEBAPP_AUTH_INVALID") from None
    except (TypeError, KeyError, json.JSONDecodeError):
        raise _auth_error("WEBAPP_AUTH_INVALID") from None


def create_admin_web_session(telegram_id, session_secret, now=None):
    normalized_id = str(telegram_id or "").strip()
    secret = str(session_secret or "")
    if not re.fullmatch(r"\d{1,24}", normalized_id) or len(secret.encode("utf-8")) < 32:
        raise _auth_error("ADMIN_SESSION_CONFIGURATION_BLOCKED")
    issued_at = int(time.time()) if now is None else int(now)
    claims = {
        "exp": issued_at + ADMIN_WEBAPP_SESSION_SECONDS,
        "iat": issued_at,
        "nonce": secrets.token_urlsafe(18),
        "sub": normalized_id,
    }
    encoded_claims = _urlsafe_encode(json.dumps(claims, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(secret.encode("utf-8"), encoded_claims.encode("ascii"), hashlib.sha256).digest()
    return {
        "token": f"{encoded_claims}.{_urlsafe_encode(signature)}",
        "expiresAt": claims["exp"],
    }


def verify_admin_web_session(token, session_secret, allowed_ids, now=None):
    secret = str(session_secret or "")
    if not isinstance(token, str) or len(token) > 4096 or len(secret.encode("utf-8")) < 32:
        raise _auth_error("ADMIN_SESSION_INVALID")
    try:
        encoded_claims, encoded_signature = token.split(".")
        supplied_signature = _urlsafe_decode(encoded_signature)
        expected_signature = hmac.new(secret.encode("utf-8"), encoded_claims.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected_signature, supplied_signature):
            raise _auth_error("ADMIN_SESSION_INVALID")
        claims = json.loads(_urlsafe_decode(encoded_claims).decode("utf-8"))
        telegram_id = str(claims.get("sub", ""))
        issued_at = claims.get("iat")
        expires_at = claims.get("exp")
        if (not re.fullmatch(r"\d{1,24}", telegram_id)
                or not isinstance(issued_at, int) or isinstance(issued_at, bool)
                or not isinstance(expires_at, int) or isinstance(expires_at, bool)
                or expires_at - issued_at != ADMIN_WEBAPP_SESSION_SECONDS
                or not isinstance(claims.get("nonce"), str) or len(claims["nonce"]) < 16):
            raise _auth_error("ADMIN_SESSION_INVALID")
        current_time = int(time.time()) if now is None else int(now)
        if issued_at > current_time + ADMIN_WEBAPP_FUTURE_SKEW_SECONDS:
            raise _auth_error("ADMIN_SESSION_INVALID")
        if current_time >= expires_at:
            raise _auth_error("ADMIN_SESSION_EXPIRED")
        if telegram_id not in _normalized_admin_ids(allowed_ids):
            raise _auth_error("ADMIN_SESSION_NOT_AUTHORIZED")
        return {"telegramId": telegram_id, "expiresAt": expires_at}
    except ValueError as error:
        if str(error) in {
            "ADMIN_SESSION_INVALID",
            "ADMIN_SESSION_EXPIRED",
            "ADMIN_SESSION_NOT_AUTHORIZED",
        }:
            raise
        raise _auth_error("ADMIN_SESSION_INVALID") from None
    except (TypeError, KeyError, UnicodeDecodeError, json.JSONDecodeError):
        raise _auth_error("ADMIN_SESSION_INVALID") from None


def is_authorized_admin(telegram_id, allowed_ids=None):
    ids = ADMIN_IDS if allowed_ids is None else allowed_ids
    return str(telegram_id or "").strip() in ids


def load_signer(private_key_pem=None):
    pem = private_key_pem if private_key_pem is not None else read_secret(
        "NOVDA_LICENSE_ED25519_PRIVATE_KEY",
        "NOVDA_LICENSE_ED25519_PRIVATE_KEY_FILE",
    )
    if not pem:
        return None, "SIGNER_NOT_CONFIGURED"
    try:
        key = serialization.load_pem_private_key(pem.replace("\\n", "\n").encode("utf-8"), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            return None, "SIGNER_KEY_TYPE_INVALID"
        public_bytes = key.public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        fingerprint = hashlib.sha256(public_bytes).hexdigest()
        if fingerprint != PINNED_PUBLIC_KEY_FINGERPRINT:
            return None, "SIGNER_FINGERPRINT_MISMATCH_NEW_CLIENT_RC_REQUIRED"
        return key, None
    except Exception:
        return None, "SIGNER_KEY_INVALID"


def create_activation(payload, private_key=None):
    key = private_key or LICENSE_PRIVATE_KEY
    if key is None:
        raise RuntimeError("SIGNER_NOT_CONFIGURED")
    signature = key.sign(canonical_activation_payload(payload))
    return {"payload": payload, "signature": base64.b64encode(signature).decode("ascii")}


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def api_request(method, route, payload=None):
    if not API_BASE_URL or not ADMIN_API_TOKEN:
        raise RuntimeError("ADMIN_API_NOT_CONFIGURED")
    url = urllib.parse.urljoin(API_BASE_URL.rstrip("/") + "/", route.lstrip("/"))
    data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json", "x-novda-admin-token": ADMIN_API_TOKEN}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            result = json.loads(response.read(128 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            result = json.loads(error.read(64 * 1024).decode("utf-8"))
            detail = result.get("error", {}).get("code", "ADMIN_API_REJECTED")
        except Exception:
            detail = "ADMIN_API_REJECTED"
        raise RuntimeError(detail) from None
    except Exception:
        raise RuntimeError("ADMIN_API_UNAVAILABLE") from None
    if not isinstance(result, dict) or result.get("success") is not True:
        raise RuntimeError(result.get("error", {}).get("code", "ADMIN_API_REJECTED") if isinstance(result, dict) else "ADMIN_API_RESPONSE_INVALID")
    return result


def list_pending_text():
    result = api_request("GET", "/api/admin/activation/requests")
    requests = result.get("requests", [])
    if not requests:
        return "Kutilayotgan aktivatsiya so'rovlari yo'q."
    lines = ["<b>KUTILAYOTGAN AKTIVATSIYALAR</b>"]
    for item in requests:
        context = item.get("client_context") or {}
        lines.append(
            f"\nID: <code>{html.escape(str(item.get('request_id', '')))}</code>"
            f"\nQurilma: <code>{html.escape(str(item.get('machine_id', '')))}</code>"
            f"\nVersiya: {html.escape(str(context.get('appVersion', 'unknown')))}"
            f"\nSo'rov: {html.escape(str(item.get('requested_at', '')))}"
        )
    lines.append("\nTasdiqlash: <code>/approve REQUEST_ID COMPANY_ID admin|type|print</code>")
    lines.append("\nRad etish: <code>/reject REQUEST_ID SABAB</code>")
    return "".join(lines)


def handle_approve(telegram_id, arguments):
    if len(arguments) != 3:
        raise ValueError("Foydalanish: /approve REQUEST_ID COMPANY_ID admin|type|print")
    request_id, company_id, role = arguments
    role = role.strip().lower()
    if role not in ACTIVATION_ROLES:
        raise ValueError("Rol admin, type yoki print bo'lishi kerak.")
    detail = api_request("GET", f"/api/admin/activation/requests/{urllib.parse.quote(request_id, safe='')}")["request"]
    company = next(
        (item for item in api_request("GET", "/api/admin/activation/companies").get("companies", [])
         if item.get("company_id") == company_id),
        None,
    )
    if company is None:
        raise ValueError("Korxona  bazasida topilmadi. Avval /company ID NOMI orqali ro'yxatdan o'tkazing.")
    if role not in company.get("allowed_roles", []):
        raise ValueError("Bu rol tanlangan korxona uchun ruxsat etilmagan.")
    payload = {
        "activationId": str(uuid.uuid4()),
        "companyId": company["company_id"],
        "companyName": company["company_name"],
        "expiresAt": None,
        "issuedAt": utc_now_iso(),
        "machineId": detail["machine_id"],
        "requireTicketValidation": company["require_ticket_validation"],
        "role": role,
        "schema": "novda-license-v1",
        "status": "active",
    }
    signed = create_activation(payload)
    api_request(
        "POST",
        f"/api/admin/activation/requests/{urllib.parse.quote(request_id, safe='')}/approve",
        {"adminTelegramId": str(telegram_id), "companyId": company_id, "role": role, "signedActivation": signed},
    )
    return f"Tasdiqlandi: <code>{html.escape(request_id)}</code> · <b>{html.escape(company['company_name'])}</b> · <b>{role}</b>"


def handle_reject(telegram_id, arguments):
    if len(arguments) < 2:
        raise ValueError("Foydalanish: /reject REQUEST_ID SABAB")
    request_id = arguments[0]
    reason = " ".join(arguments[1:]).strip()
    api_request(
        "POST",
        f"/api/admin/activation/requests/{urllib.parse.quote(request_id, safe='')}/reject",
        {"adminTelegramId": str(telegram_id), "reason": reason},
    )
    return f"So'rov rad etildi: <code>{html.escape(request_id)}</code>"


def handle_revoke(telegram_id, arguments):
    if len(arguments) != 1:
        raise ValueError("Foydalanish: /revoke REQUEST_ID")
    request_id = arguments[0]
    detail = api_request("GET", f"/api/admin/activation/requests/{urllib.parse.quote(request_id, safe='')}")["request"]
    activation = detail.get("activation")
    if detail.get("status") != "APPROVED" or not activation:
        raise ValueError("Faqat faol tasdiqlangan aktivatsiyani bekor qilish mumkin.")
    payload = dict(activation["payload"])
    next_issued_at = max(int(time.time() * 1000), int(datetime.fromisoformat(payload["issuedAt"].replace("Z", "+00:00")).timestamp() * 1000) + 1)
    payload["issuedAt"] = datetime.fromtimestamp(next_issued_at / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    payload["status"] = "revoked"
    signed = create_activation(payload)
    api_request(
        "POST",
        f"/api/admin/activation/requests/{urllib.parse.quote(request_id, safe='')}/revoke",
        {"adminTelegramId": str(telegram_id), "signedActivation": signed},
    )
    return f"Aktivatsiya bekor qilindi: <code>{html.escape(request_id)}</code>"


def handle_company(telegram_id, arguments):
    if len(arguments) < 2:
        raise ValueError("Foydalanish: /company COMPANY_ID KORXONA_NOMI")
    company_id = arguments[0]
    company_name = " ".join(arguments[1:]).strip()
    result = api_request(
        "POST",
        "/api/admin/activation/companies",
        {"adminTelegramId": str(telegram_id), "companyId": company_id, "companyName": company_name},
    )
    company = result["company"]
    return f"Korxona saqlandi: <b>{html.escape(company['company_name'])}</b> (<code>{html.escape(company['company_id'])}</code>)"


def list_companies_text():
    companies = api_request("GET", "/api/admin/activation/companies").get("companies", [])
    if not companies:
        return "Aktivatsiya uchun korxonalar kiritilmagan. /company ID NOMI buyrug'idan foydalaning."
    lines = ["<b>AKTIV KORXONALAR</b>"]
    for company in companies:
        roles = ", ".join(company.get("allowed_roles", []))
        lines.append(
            f"\n{html.escape(str(company.get('company_name', '')))} "
            f"(<code>{html.escape(str(company.get('company_id', '')))}</code>) · "
            f"rollar: {html.escape(roles)}"
        )
    return "".join(lines)


def handle_admin_command(telegram_id, text):
    if not is_authorized_admin(telegram_id):
        return None
    parts = str(text or "").strip().split()
    if not parts:
        return None
    command = parts[0].split("@", 1)[0].lower()
    arguments = parts[1:]
    if command in ("/start", "/help"):
        return (
            "Novda  aktivatsiya boshqaruvi.\n"
            "/pending — kutayotgan qurilmalar\n"
            "/companies — aktiv korxonalar\n"
            "/approve REQUEST_ID COMPANY_ID admin|type|print\n"
            "/reject REQUEST_ID SABAB\n"
            "/revoke REQUEST_ID\n"
            "/company ID NOMI"
        )
    if command == "/pending":
        return list_pending_text()
    if command == "/companies":
        return list_companies_text()
    if command == "/approve":
        return handle_approve(telegram_id, arguments)
    if command == "/reject":
        return handle_reject(telegram_id, arguments)
    if command == "/revoke":
        return handle_revoke(telegram_id, arguments)
    if command == "/company":
        return handle_company(telegram_id, arguments)
    return "Noma'lum buyruq. /help buyrug'ini yuboring."


def telegram_request(method, payload):
    if not BOT_TOKEN:
        raise RuntimeError("ADMIN_BOT_TOKEN_BLOCKED")
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read(256 * 1024).decode("utf-8"))
    except Exception:
        raise RuntimeError("TELEGRAM_API_UNAVAILABLE") from None
    if not result.get("ok"):
        raise RuntimeError("TELEGRAM_API_REJECTED")
    return result


def send_message(chat_id, text, reply_markup=None):
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return telegram_request("sendMessage", payload)


def admin_webapp_keyboard():
    if not ADMIN_WEBAPP_READY or not ADMIN_WEBAPP_URL:
        return None
    return {
        "inline_keyboard": [[{
            "text": "📊 Boshqaruv panelini ochish",
            "web_app": {"url": ADMIN_WEBAPP_URL},
        }]],
    }


def process_update(update):
    message = update.get("message") or update.get("edited_message") or {}
    sender = message.get("from") or {}
    chat_id = (message.get("chat") or {}).get("id")
    telegram_id = sender.get("id")
    text = message.get("text")
    if not chat_id or not text:
        return
    if not is_authorized_admin(telegram_id):
        send_message(chat_id, "Ruxsat berilmagan.")
        return
    try:
        response = handle_admin_command(telegram_id, text)
        if response:
            command = str(text).strip().split(maxsplit=1)[0].split("@", 1)[0].lower()
            reply_markup = admin_webapp_keyboard() if command == "/start" else None
            send_message(chat_id, response, reply_markup)
    except ValueError as error:
        send_message(chat_id, html.escape(str(error)))
    except RuntimeError as error:
        # API errors are stable codes; exception text and request URLs never contain credentials.
        send_message(chat_id, f"Amal bajarilmadi: <code>{html.escape(str(error))}</code>")
    except Exception:
        send_message(chat_id, "Amal bajarilmadi. Xavfsizlik uchun tafsilotlar bot jurnaliga yozilmadi.")


def notify_new_pending_requests():
    global PENDING_NOTIFICATION_WARMED
    try:
        pending = api_request("GET", "/api/admin/activation/requests").get("requests", [])
    except Exception as error:
        print(f"ADMIN_PENDING_POLL_RETRY code={html.escape(str(error))}", flush=True)
        return
    current_ids = {str(item.get("request_id")) for item in pending if item.get("request_id")}
    if not PENDING_NOTIFICATION_WARMED:
        NOTIFIED_REQUEST_IDS.update(current_ids)
        PENDING_NOTIFICATION_WARMED = True
        return
    new_items = [item for item in pending if str(item.get("request_id")) not in NOTIFIED_REQUEST_IDS]
    for item in new_items:
        context = item.get("client_context") or {}
        message = (
            "<b>Yangi PC aktivatsiya so'rovi</b>\n"
            f"So'rov: <code>{html.escape(str(item.get('request_id')))}</code>\n"
            f"Qurilma: <code>{html.escape(str(item.get('machine_id')))}</code>\n"
            f"Versiya: {html.escape(str(context.get('appVersion', 'unknown')))}\n\n"
            "Tafsilot va buyruqlar: /pending"
        )
        delivered = False
        for admin_id in ADMIN_IDS:
            try:
                send_message(admin_id, message)
                delivered = True
            except Exception:
                continue
        if delivered:
            NOTIFIED_REQUEST_IDS.add(str(item.get("request_id")))


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        healthy = CONFIGURATION_READY and TELEGRAM_CONNECTED
        body = json.dumps({"status": "ok" if healthy else "blocked", "service": "novda-admin-bot"}).encode("utf-8")
        self.send_response(200 if healthy else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        request_path = urllib.parse.urlparse(self.path).path
        supplied_token = self.headers.get("x-novda-admin-token", "")
        if not ADMIN_API_TOKEN or not hmac.compare_digest(ADMIN_API_TOKEN, supplied_token):
            self._send_json(401, {"success": False, "error": {"code": "ADMIN_SERVICE_AUTH_REQUIRED"}})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length < 1 or content_length > 32 * 1024:
                raise ValueError("INVALID_REQUEST_BODY")
            request_body = json.loads(self.rfile.read(content_length).decode("utf-8"))
            if not isinstance(request_body, dict):
                raise ValueError("INVALID_REQUEST_BODY")
            if request_path == "/internal/admin/webapp/session":
                result = issue_admin_webapp_session(request_body.get("initData"))
                self._send_json(200, {"success": True, **result})
                return
            if request_path == "/internal/admin/webapp/sign-activation":
                result = sign_activation_for_admin_session(
                    request_body.get("sessionToken"), request_body.get("payload")
                )
                self._send_json(200, {"success": True, **result})
                return
            self._send_json(404, {"success": False, "error": {"code": "INTERNAL_ROUTE_NOT_FOUND"}})
        except ValueError as error:
            code = str(error) if str(error).isupper() and len(str(error)) <= 80 else "ADMIN_WEBAPP_REQUEST_REJECTED"
            if code in {"ADMIN_TELEGRAM_ID_NOT_AUTHORIZED", "ADMIN_SESSION_NOT_AUTHORIZED"}:
                status = 403
            elif code == "INVALID_REQUEST_BODY":
                status = 400
            else:
                status = 401
            self._send_json(status, {"success": False, "error": {"code": code}})
        except Exception:
            self._send_json(503, {"success": False, "error": {"code": "ADMIN_WEBAPP_AUTH_UNAVAILABLE"}})

    def _send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


def run_health_server():
    ThreadingHTTPServer(("0.0.0.0", PORT), HealthHandler).serve_forever()


def issue_admin_webapp_session(init_data):
    claims = validate_webapp_init_data(init_data, BOT_TOKEN, ADMIN_IDS)
    session = create_admin_web_session(claims["telegramId"], ADMIN_WEBAPP_SESSION_SECRET)
    return {"session": session, "user": claims["user"]}


def sign_activation_for_admin_session(session_token, payload):
    claims = verify_admin_web_session(session_token, ADMIN_WEBAPP_SESSION_SECRET, ADMIN_IDS)
    signed = create_activation(payload)
    return {"telegramId": claims["telegramId"], "signedActivation": signed}


def admin_webapp_is_healthy():
    if not ADMIN_WEBAPP_URL or not API_BASE_URL:
        return False
    api_origin = API_BASE_URL.rstrip("/")
    try:
        page_request = urllib.request.Request(
            f"{api_origin}/admin-app",
            headers={"Accept": "text/html", "Cache-Control": "no-cache"},
        )
        with urllib.request.urlopen(page_request, timeout=5) as response:
            if response.status != 200:
                return False
            page = response.read(256 * 1024)
        if b'name="novda-admin-webapp-version"' not in page or b'/admin-app/admin.js' not in page:
            return False

        script_request = urllib.request.Request(
            f"{api_origin}/admin-app/admin.js",
            headers={"Accept": "application/javascript", "Cache-Control": "no-cache"},
        )
        with urllib.request.urlopen(script_request, timeout=5) as response:
            if response.status != 200:
                return False
            script = response.read(256 * 1024)
        if b"const API = '/api/admin/webapp'" not in script or b"telegram.initData" not in script:
            return False

        session_request = urllib.request.Request(
            f"{api_origin}/api/admin/webapp/session",
            headers={"Accept": "application/json", "Cache-Control": "no-cache"},
        )
        try:
            with urllib.request.urlopen(session_request, timeout=5) as response:
                return False
        except urllib.error.HTTPError as error:
            if error.code != 401:
                return False
            try:
                probe = json.loads(error.read(4096).decode("utf-8"))
            finally:
                error.close()
            return probe.get("error", {}).get("code") == "ADMIN_SESSION_REQUIRED"
    except Exception:
        return False


def is_canonical_admin_webapp_url(value):
    parsed = urllib.parse.urlparse(str(value or "").strip())
    return (
        parsed.scheme == "https"
        and parsed.netloc == "sync.novdatextile.uz"
        and parsed.path == "/admin-app"
        and not parsed.query
        and not parsed.fragment
    )


def configure_admin_webapp_menu():
    global ADMIN_WEBAPP_READY
    if not admin_webapp_is_healthy():
        ADMIN_WEBAPP_READY = False
        return False
    try:
        telegram_request("setChatMenuButton", {
            "menu_button": {
                "type": "web_app",
                "text": "📱 Boshqaruv Paneli",
                "web_app": {"url": ADMIN_WEBAPP_URL},
            }
        })
        ADMIN_WEBAPP_READY = True
        return True
    except Exception:
        ADMIN_WEBAPP_READY = False
        return False


def run_polling():
    global LAST_TELEGRAM_SUCCESS, TELEGRAM_CONNECTED
    offset = 0
    last_pending_poll = 0.0
    while True:
        try:
            if not TELEGRAM_CONNECTED:
                telegram_request("getMe", {})
                TELEGRAM_CONNECTED = True
            if not ADMIN_WEBAPP_READY:
                configure_admin_webapp_menu()
            result = telegram_request("getUpdates", {"offset": offset, "timeout": 20, "allowed_updates": ["message"]})
            LAST_TELEGRAM_SUCCESS = time.time()
            for update in result.get("result", []):
                offset = max(offset, int(update.get("update_id", 0)) + 1)
                process_update(update)
            if time.time() - last_pending_poll >= 20:
                notify_new_pending_requests()
                last_pending_poll = time.time()
        except Exception as error:
            TELEGRAM_CONNECTED = False
            print(f"ADMIN_BOT_POLL_RETRY code={html.escape(str(error))}", flush=True)
            time.sleep(5)


def configure():
    global BOT_TOKEN, ADMIN_API_TOKEN, ADMIN_IDS, LICENSE_PRIVATE_KEY, API_BASE_URL
    global ADMIN_WEBAPP_URL, ADMIN_WEBAPP_SESSION_SECRET, CONFIGURATION_READY
    BOT_TOKEN = read_secret("ADMIN_BOT_TOKEN", "ADMIN_BOT_TOKEN_FILE")
    ADMIN_API_TOKEN = read_secret("NOVDA_ADMIN_API_TOKEN")
    ADMIN_IDS = load_admin_ids()
    API_BASE_URL = os.environ.get("NOVDA_ADMIN_API_URL", "").strip()
    ADMIN_WEBAPP_URL = os.environ.get("ADMIN_WEBAPP_URL", "").strip()
    ADMIN_WEBAPP_SESSION_SECRET = read_secret("NOVDA_ADMIN_WEBAPP_SESSION_SECRET")
    LICENSE_PRIVATE_KEY, signer_error = load_signer()
    webapp_url_ready = is_canonical_admin_webapp_url(ADMIN_WEBAPP_URL)
    CONFIGURATION_READY = bool(
        BOT_TOKEN and ADMIN_API_TOKEN and ADMIN_IDS and LICENSE_PRIVATE_KEY and API_BASE_URL
        and webapp_url_ready and len(ADMIN_WEBAPP_SESSION_SECRET.encode("utf-8")) >= 32
    )
    if not BOT_TOKEN:
        print("ADMIN_BOT_TOKEN_BLOCKED", flush=True)
    if not ADMIN_API_TOKEN or not API_BASE_URL:
        print("ADMIN_API_CONFIGURATION_BLOCKED", flush=True)
    if not ADMIN_IDS:
        print("ADMIN_TELEGRAM_ALLOWLIST_BLOCKED", flush=True)
    if not webapp_url_ready:
        print("ADMIN_WEBAPP_URL_BLOCKED", flush=True)
    if len(ADMIN_WEBAPP_SESSION_SECRET.encode("utf-8")) < 32:
        print("ADMIN_WEBAPP_SESSION_SECRET_BLOCKED", flush=True)
    if signer_error:
        print(signer_error, flush=True)
    return CONFIGURATION_READY


def main():
    configure()
    threading.Thread(target=run_health_server, daemon=True).start()
    if not CONFIGURATION_READY:
        while True:
            time.sleep(60)
    run_polling()


if __name__ == "__main__":
    main()
