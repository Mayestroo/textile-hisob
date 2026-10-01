#!/usr/bin/env python3
"""Novda worker Telegram bot backed only by the authenticated V2 API."""

import hashlib
import hmac
import html
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


PORT = int(os.environ.get("PORT", "8081"))
API_BASE_URL = os.environ.get("NOVDA_WORKER_API_URL", "").strip().rstrip("/")
WORKER_WEBAPP_URL = os.environ.get("WORKER_WEBAPP_URL", "").strip()
DEFAULT_COMPANY_ID = os.environ.get("DEFAULT_COMPANY_ID", "").strip()
BOT_TOKEN = ""
WORKER_API_TOKEN = ""
WORKER_AUTH_HMAC_SECRET = ""
CONFIGURATION_READY = False
TELEGRAM_CONNECTED = False
USER_STATES = {}


def read_secret(name, file_name=None):
    file_path = os.environ.get(file_name or f"{name}_FILE", "").strip()
    if file_path:
        try:
            with open(file_path, "r", encoding="utf-8") as secret_file:
                return secret_file.read().strip()
        except OSError:
            return ""
    return os.environ.get(name, "").strip()


def escape(value):
    return html.escape(str(value if value is not None else ""), quote=True)


def worker_web_token(company_id, worker_id, telegram_id, expires_at=None, secret=None):
    key = WORKER_AUTH_HMAC_SECRET if secret is None else secret
    if not key:
        raise RuntimeError("WORKER_AUTH_NOT_CONFIGURED")
    expires = int(expires_at if expires_at is not None else time.time() + 15 * 60)
    message = f"v1:{company_id}:{int(worker_id)}:{str(telegram_id)}:{expires}"
    return expires, hmac.new(key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def get_webapp_full_url(company_id, worker_id, telegram_id):
    if not WORKER_WEBAPP_URL:
        return ""
    expires, token = worker_web_token(company_id, worker_id, telegram_id)
    params = urllib.parse.urlencode({
        "companyId": company_id,
        "workerId": int(worker_id),
        "telegramId": str(telegram_id),
        "expiresAt": expires,
        "authToken": token,
    })
    return f"{WORKER_WEBAPP_URL}{'&' if '?' in WORKER_WEBAPP_URL else '?'}{params}"


def api_request(method, route, payload=None, query=None):
    if not API_BASE_URL or not WORKER_API_TOKEN:
        raise RuntimeError("WORKER_API_CONFIGURATION_BLOCKED")
    url = f"{API_BASE_URL}/{route.lstrip('/')}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Accept": "application/json", "x-novda-worker-token": WORKER_API_TOKEN}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            result = json.loads(response.read(128 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            parsed = json.loads(error.read(64 * 1024).decode("utf-8"))
            code = parsed.get("error", {}).get("code", "WORKER_API_REJECTED")
        except Exception:
            code = "WORKER_API_REJECTED"
        raise RuntimeError(code) from None
    except Exception:
        raise RuntimeError("WORKER_API_UNAVAILABLE") from None
    if not isinstance(result, dict) or result.get("success") is not True:
        code = result.get("error", {}).get("code", "WORKER_API_RESPONSE_INVALID") if isinstance(result, dict) else "WORKER_API_RESPONSE_INVALID"
        raise RuntimeError(code)
    return result


def get_worker_binding(telegram_id):
    return api_request("GET", f"/v2/worker/bindings/by-telegram/{urllib.parse.quote(str(telegram_id), safe='')}").get("binding")


def get_worker_id_binding(company_id, worker_id):
    return api_request("GET", "/v2/worker/bindings/by-worker", query={"companyId": company_id, "workerId": worker_id}).get("binding")


def get_worker_enrollment(company_id, worker_id):
    return api_request("GET", "/v2/worker/enrollment", query={"companyId": company_id, "workerId": worker_id}).get("worker")


def save_worker_binding(telegram_id, worker_id, company_id, username="", pin=None):
    return api_request("POST", "/v2/worker/bindings", {
        "telegramId": str(telegram_id),
        "workerId": int(worker_id),
        "companyId": company_id,
        "username": str(username or "")[:64],
        "pin": pin,
    }).get("binding")


def get_worker_profile_and_stats(company_id, worker_id, telegram_id):
    return api_request("GET", "/v2/worker/profile", query={
        "companyId": company_id,
        "workerId": worker_id,
        "telegramId": telegram_id,
    }).get("profile")


def get_worker_recent_tickets(company_id, worker_id, telegram_id, limit=8):
    result = api_request("GET", "/v2/worker/tickets", query={
        "companyId": company_id,
        "workerId": worker_id,
        "telegramId": telegram_id,
        "limit": limit,
    })
    return result.get("tickets", [])


def format_money(amount):
    try:
        return f"{int(round(float(amount or 0))):,}".replace(",", " ") + " so'm"
    except (TypeError, ValueError, OverflowError):
        return "0 so'm"


def format_number(amount):
    try:
        return f"{int(round(float(amount or 0))):,}".replace(",", " ")
    except (TypeError, ValueError, OverflowError):
        return "0"


def telegram_api(method, payload):
    if not BOT_TOKEN:
        raise RuntimeError("WORKER_BOT_TOKEN_BLOCKED")
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
    return telegram_api("sendMessage", payload)


def main_keyboard(binding, telegram_id):
    company_id = binding["company_id"]
    worker_id = binding["worker_id"]
    keyboard = []
    webapp_url = get_webapp_full_url(company_id, worker_id, telegram_id)
    if webapp_url:
        keyboard.append([{"text": "📱 Mening hisobim (Web App)", "web_app": {"url": webapp_url}}])
    keyboard.extend([
        [{"text": "💰 Sof foyda va oylik"}, {"text": "📋 Bajargan ishlarim"}],
        [{"text": "🎫 Oxirgi pattalarim"}, {"text": "🔄 Yangilash"}],
        [{"text": "ℹ️ Yordam"}],
    ])
    return {"keyboard": keyboard, "resize_keyboard": True, "is_persistent": True}


def send_profile(chat_id, telegram_id, binding):
    profile = get_worker_profile_and_stats(binding["company_id"], binding["worker_id"], telegram_id)
    text = (
        f"📊 <b>SHAXSIY HISOB-KITOB</b>\n"
        f"👤 {escape(profile['worker_name'])} (ID: #{profile['worker_id']})\n"
        f"📅 Davr: {escape(profile['period_name'])}\n\n"
        f"💵 Jami ishlangan: {format_money(profile['gross'])}\n"
        f"➖ Avans: {format_money(profile['avans'])}\n"
        f"➖ Jarima: {format_money(profile['jarima'])}\n"
        f"✅ <b>Sof foyda: {format_money(profile['net'])}</b>\n"
        f"🏷 Bajarilgan ish: {format_number(profile['pieces'])} dona"
    )
    send_message(chat_id, text, main_keyboard(binding, telegram_id))


def send_operations(chat_id, telegram_id, binding):
    profile = get_worker_profile_and_stats(binding["company_id"], binding["worker_id"], telegram_id)
    breakdown = profile.get("models_breakdown") or {}
    if not breakdown:
        send_message(chat_id, "Joriy davrda sizga operatsiyalar kiritilmagan.", main_keyboard(binding, telegram_id))
        return
    lines = ["<b>BAJARILGAN ISHLAR</b>"]
    for model in breakdown.values():
        lines.append(f"\n👗 <b>{escape(model['name'])}</b>: {format_money(model['earnings'])}")
        for operation in model.get("operations", []):
            lines.append(
                f"  • {escape(operation['name'])}: {format_number(operation['qty'])} dona × "
                f"{format_number(operation['rate'])} so'm = <b>{format_money(operation['amount'])}</b>"
            )
    lines.append(f"\nJami: <b>{format_money(profile['gross'])}</b>")
    send_message(chat_id, "\n".join(lines), main_keyboard(binding, telegram_id))


def send_tickets(chat_id, telegram_id, binding):
    tickets = get_worker_recent_tickets(binding["company_id"], binding["worker_id"], telegram_id, 8)
    if not tickets:
        send_message(chat_id, "Hozircha sizga tegishli topshirilgan pattalar topilmadi.", main_keyboard(binding, telegram_id))
        return
    lines = ["<b>OXIRGI PATTALAR</b>"]
    for ticket in tickets:
        lines.append(
            f"\n🏷 {escape(ticket.get('model_id'))} · Patta #{escape(ticket.get('patta_number'))}"
            f"\nPartiya: {escape(ticket.get('party_number'))} · Razmer: {escape(ticket.get('size') or '-')} · Rang: {escape(ticket.get('color') or '-')}"
            f"\nChok: {escape(ticket.get('my_operations') or '')} · Soni: {escape(ticket.get('qty'))} dona"
            f"\n{escape(ticket.get('submitted_at'))}"
        )
    send_message(chat_id, "".join(lines), main_keyboard(binding, telegram_id))


def begin_registration(chat_id, user):
    telegram_id = str(user.get("id", ""))
    binding = get_worker_binding(telegram_id)
    if binding:
        state = {"step": "BOUND", "binding": binding}
        USER_STATES[telegram_id] = state
        send_message(chat_id, f"Xush kelibsiz, <b>{escape(binding['worker_name'])}</b>!", main_keyboard(binding, telegram_id))
        send_profile(chat_id, telegram_id, binding)
        return
    if DEFAULT_COMPANY_ID:
        USER_STATES[telegram_id] = {"step": "WAITING_WORKER_ID", "company_id": DEFAULT_COMPANY_ID}
        prompt = f"Ishchi ID raqamingizni yuboring (korxona kodi: <code>{escape(DEFAULT_COMPANY_ID)}</code>)."
    else:
        USER_STATES[telegram_id] = {"step": "WAITING_COMPANY_ID"}
        prompt = "Korxona ID kodini yuboring. Uni korxona ma'muriyatidan oling."
    send_message(chat_id, prompt, {"remove_keyboard": True})


def start_worker_id_check(chat_id, user, telegram_id, state, text):
    if not re.fullmatch(r"\d{1,9}", text.strip()):
        send_message(chat_id, "Faqat o'zingizning raqamli Ishchi ID raqamingizni yuboring.")
        return
    worker_id = int(text.strip())
    company_id = state["company_id"]
    claimed = get_worker_id_binding(company_id, worker_id)
    if claimed and str(claimed.get("telegram_id")) != telegram_id:
        send_message(chat_id, "Ushbu ishchi hisob boshqa Telegram akkauntiga biriktirilgan. Korxona ma'muriyatiga murojaat qiling.")
        return
    worker = get_worker_enrollment(company_id, worker_id)
    if not worker.get("pin_required"):
        send_message(chat_id, "Ushbu ishchi hisob uchun PIN-kod sozlanmagan. Xavfsiz ulash uchun korxona ma'muriyatiga murojaat qiling.")
        return
    state.update({"worker_id": worker_id, "worker_name": worker["worker_name"]})
    state["step"] = "WAITING_PIN"
    send_message(chat_id, f"Xodim topildi: <b>{escape(worker['worker_name'])}</b>. Himoyalangan shaxsiy PIN-kodingizni yuboring.")


def finish_registration(chat_id, user, telegram_id, state, pin=None):
    binding = save_worker_binding(
        telegram_id,
        state["worker_id"],
        state["company_id"],
        user.get("username", ""),
        pin,
    )
    USER_STATES[telegram_id] = {"step": "BOUND", "binding": binding}
    send_message(chat_id, f"Profil muvaffaqiyatli bog'landi: <b>{escape(binding['worker_name'])}</b>.", main_keyboard(binding, telegram_id))
    send_profile(chat_id, telegram_id, binding)


def handle_text(chat_id, user, text, message_id=None):
    telegram_id = str(user.get("id", ""))
    state = USER_STATES.get(telegram_id, {})
    binding = state.get("binding") if state.get("step") == "BOUND" else get_worker_binding(telegram_id)
    if binding:
        USER_STATES[telegram_id] = {"step": "BOUND", "binding": binding}
        lowered = text.strip().lower()
        if lowered in ("💰 sof foyda va oylik", "/hisob", "/start", "🔄 yangilash", "/refresh"):
            send_profile(chat_id, telegram_id, binding)
        elif lowered in ("📋 bajargan ishlarim", "/operatsiyalar"):
            send_operations(chat_id, telegram_id, binding)
        elif lowered in ("🎫 oxirgi pattalarim", "/pattalar"):
            send_tickets(chat_id, telegram_id, binding)
        elif lowered in ("ℹ️ yordam", "/help"):
            send_message(chat_id, "Siz faqat o'zingizning hisob-kitobingiz va ishlaringizni ko'rishingiz mumkin.", main_keyboard(binding, telegram_id))
        else:
            send_message(chat_id, "Kerakli bo'limni menyudan tanlang.", main_keyboard(binding, telegram_id))
        return

    if not state:
        begin_registration(chat_id, user)
        return
    if state.get("step") == "WAITING_COMPANY_ID":
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", text.strip()):
            send_message(chat_id, "Korxona ID formati noto'g'ri.")
            return
        state.update({"step": "WAITING_WORKER_ID", "company_id": text.strip()})
        send_message(chat_id, "Endi Ishchi ID raqamingizni yuboring.")
        return
    if state.get("step") == "WAITING_WORKER_ID":
        try:
            start_worker_id_check(chat_id, user, telegram_id, state, text)
        except RuntimeError as error:
            send_message(chat_id, f"Tekshirib bo'lmadi: <code>{escape(error)}</code>")
        return
    if state.get("step") == "WAITING_PIN":
        if message_id:
            try:
                telegram_api("deleteMessage", {"chat_id": chat_id, "message_id": message_id})
            except Exception:
                pass
        try:
            finish_registration(chat_id, user, telegram_id, state, text.strip())
        except RuntimeError as error:
            send_message(chat_id, f"Bog'lab bo'lmadi: <code>{escape(error)}</code>. Qayta urinib ko'ring yoki ma'muriyatga murojaat qiling.")
            state["step"] = "WAITING_PIN"
        return
def process_update(update):
    message = update.get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    user = message.get("from") or {}
    text = message.get("text")
    if chat_id and text:
        try:
            handle_text(chat_id, user, text, message.get("message_id"))
        except RuntimeError as error:
            send_message(chat_id, f"Xizmat vaqtincha mavjud emas: <code>{escape(error)}</code>")


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        healthy = CONFIGURATION_READY and TELEGRAM_CONNECTED
        body = json.dumps({"status": "ok" if healthy else "blocked", "service": "novda-worker-bot"}).encode("utf-8")
        self.send_response(200 if healthy else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


def run_health_server():
    ThreadingHTTPServer(("0.0.0.0", PORT), HealthHandler).serve_forever()


def configure():
    global BOT_TOKEN, WORKER_API_TOKEN, WORKER_AUTH_HMAC_SECRET, CONFIGURATION_READY
    BOT_TOKEN = read_secret("WORKER_BOT_TOKEN", "WORKER_BOT_TOKEN_FILE")
    WORKER_API_TOKEN = read_secret("NOVDA_WORKER_API_TOKEN")
    WORKER_AUTH_HMAC_SECRET = read_secret("WORKER_AUTH_HMAC_SECRET")
    CONFIGURATION_READY = bool(BOT_TOKEN and WORKER_API_TOKEN and WORKER_AUTH_HMAC_SECRET and API_BASE_URL)
    if not BOT_TOKEN:
        print("WORKER_BOT_TOKEN_BLOCKED", flush=True)
    if not WORKER_API_TOKEN or not API_BASE_URL:
        print("WORKER_API_CONFIGURATION_BLOCKED", flush=True)
    if not WORKER_AUTH_HMAC_SECRET:
        print("WORKER_AUTH_HMAC_SECRET_BLOCKED", flush=True)
    return CONFIGURATION_READY


def run_polling():
    global TELEGRAM_CONNECTED
    offset = 0
    while True:
        try:
            if not TELEGRAM_CONNECTED:
                telegram_api("getMe", {})
                TELEGRAM_CONNECTED = True
            result = telegram_api("getUpdates", {"offset": offset, "timeout": 20, "allowed_updates": ["message"]})
            for update in result.get("result", []):
                offset = max(offset, int(update.get("update_id", 0)) + 1)
                process_update(update)
        except Exception as error:
            TELEGRAM_CONNECTED = False
            print(f"WORKER_BOT_POLL_RETRY code={escape(error)}", flush=True)
            time.sleep(5)


def main():
    configure()
    threading.Thread(target=run_health_server, daemon=True).start()
    if not CONFIGURATION_READY:
        while True:
            time.sleep(60)
    run_polling()


if __name__ == "__main__":
    main()
