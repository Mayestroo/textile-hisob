import hashlib
import hmac
import io
import json
import time
import threading
import unittest
import urllib.error
import urllib.request
from urllib.parse import urlencode
from unittest.mock import patch
from http.server import ThreadingHTTPServer

import admin_bot
from admin_bot import (
    create_admin_web_session,
    issue_admin_webapp_session,
    sign_activation_for_admin_session,
    validate_webapp_init_data,
    verify_admin_web_session,
)


BOT_TOKEN = "123456:unit-test-bot-token"
SESSION_SECRET = "test-session-secret-with-enough-entropy"
ADMIN_ID = "1526974123"
NODE_SESSION_FIXTURE = "eyJleHAiOjE4MDAwMDA5MDAsImlhdCI6MTgwMDAwMDAwMCwibm9uY2UiOiIwMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW4iLCJzdWIiOiIxNTI2OTc0MTIzIn0.Flm2YbufUhxd9saAtRVYQQfeS0yLMgHoHOA78xD0kfY"


def signed_init_data(telegram_id=ADMIN_ID, auth_date=None):
    now = int(time.time()) if auth_date is None else int(auth_date)
    fields = {
        "auth_date": str(now),
        "query_id": "AAE-test-query",
        "user": json.dumps({"id": int(telegram_id), "first_name": "Test Admin"}, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode("utf-8"), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    return urlencode(fields)


class AdminWebAppAuthTests(unittest.TestCase):
    def test_accepts_valid_telegram_init_data_for_allowlisted_admin(self):
        claims = validate_webapp_init_data(signed_init_data(), BOT_TOKEN, {ADMIN_ID})

        self.assertEqual(claims["telegramId"], ADMIN_ID)
        self.assertEqual(claims["user"]["first_name"], "Test Admin")

    def test_validates_company_scoped_user_telegram_signature_before_server_authorization(self):
        claims = validate_webapp_init_data(signed_init_data(telegram_id="274466315"), BOT_TOKEN, None)
        self.assertEqual(claims["telegramId"], "274466315")

    def test_rejects_modified_init_data_hash(self):
        init_data = signed_init_data().replace("Test+Admin", "Other+Admin")

        with self.assertRaisesRegex(ValueError, "WEBAPP_AUTH_INVALID"):
            validate_webapp_init_data(init_data, BOT_TOKEN, {ADMIN_ID})

    def test_rejects_stale_auth_date(self):
        now = int(time.time())
        init_data = signed_init_data(auth_date=now - 301)

        with self.assertRaisesRegex(ValueError, "WEBAPP_AUTH_EXPIRED"):
            validate_webapp_init_data(init_data, BOT_TOKEN, {ADMIN_ID}, now=now)

    def test_rejects_auth_date_too_far_in_future(self):
        now = int(time.time())
        init_data = signed_init_data(auth_date=now + 61)

        with self.assertRaisesRegex(ValueError, "WEBAPP_AUTH_INVALID"):
            validate_webapp_init_data(init_data, BOT_TOKEN, {ADMIN_ID}, now=now)

    def test_rejects_malformed_user_and_non_allowlisted_admin(self):
        fields = {"auth_date": str(int(time.time())), "user": "not-json"}
        check = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        malformed = urlencode(fields)

        with self.assertRaisesRegex(ValueError, "WEBAPP_AUTH_INVALID"):
            validate_webapp_init_data(malformed, BOT_TOKEN, {ADMIN_ID})
        with self.assertRaisesRegex(ValueError, "ADMIN_TELEGRAM_ID_NOT_AUTHORIZED"):
            validate_webapp_init_data(signed_init_data(telegram_id="99887766"), BOT_TOKEN, {ADMIN_ID})

    def test_rejects_duplicate_parameters(self):
        init_data = signed_init_data() + "&auth_date=1"

        with self.assertRaisesRegex(ValueError, "WEBAPP_AUTH_INVALID"):
            validate_webapp_init_data(init_data, BOT_TOKEN, {ADMIN_ID})

    def test_short_lived_session_is_signed_and_allowlist_is_rechecked(self):
        issued = create_admin_web_session(ADMIN_ID, SESSION_SECRET, now=1_800_000_000)
        claims = verify_admin_web_session(issued["token"], SESSION_SECRET, {ADMIN_ID}, now=1_800_000_100)

        self.assertEqual(claims["telegramId"], ADMIN_ID)
        self.assertEqual(claims["expiresAt"], 1_800_000_900)
        with self.assertRaisesRegex(ValueError, "ADMIN_SESSION_NOT_AUTHORIZED"):
            verify_admin_web_session(issued["token"], SESSION_SECRET, set(), now=1_800_000_100)

    def test_rejects_expired_and_tampered_sessions(self):
        issued = create_admin_web_session(ADMIN_ID, SESSION_SECRET, now=1_800_000_000)

        with self.assertRaisesRegex(ValueError, "ADMIN_SESSION_EXPIRED"):
            verify_admin_web_session(issued["token"], SESSION_SECRET, {ADMIN_ID}, now=1_800_000_901)
        tampered = issued["token"][:-1] + ("A" if issued["token"][-1] != "A" else "B")
        with self.assertRaisesRegex(ValueError, "ADMIN_SESSION_INVALID"):
            verify_admin_web_session(tampered, SESSION_SECRET, {ADMIN_ID}, now=1_800_000_100)

    def test_accepts_the_session_encoding_emitted_by_the_node_sync_api(self):
        claims = verify_admin_web_session(NODE_SESSION_FIXTURE, SESSION_SECRET, {ADMIN_ID}, now=1_800_000_000)
        self.assertEqual(claims, {"telegramId": ADMIN_ID, "expiresAt": 1_800_000_900})

    def test_internal_session_exchange_uses_authoritative_server_company_scope(self):
        authorize = lambda method, route, payload: {
            "success": True,
            "access": {"isGlobalAdmin": False, "companyIds": ["comp_novda"]},
        }
        with patch.object(admin_bot, "BOT_TOKEN", BOT_TOKEN), \
                patch.object(admin_bot, "ADMIN_WEBAPP_SESSION_SECRET", SESSION_SECRET), \
                patch.object(admin_bot, "api_request", side_effect=authorize) as api_request:
            result = issue_admin_webapp_session(signed_init_data())

        self.assertEqual(result["user"]["id"], int(ADMIN_ID))
        self.assertEqual(result["session"]["expiresAt"] - int(time.time()), 900)
        self.assertEqual(result["access"], {"isGlobalAdmin": False, "companyIds": ["comp_novda"]})
        api_request.assert_called_once_with("POST", "/internal/admin/webapp/authorize", {"telegramId": ADMIN_ID})

        with patch.object(admin_bot, "BOT_TOKEN", BOT_TOKEN), \
                patch.object(admin_bot, "ADMIN_WEBAPP_SESSION_SECRET", SESSION_SECRET), \
                patch.object(admin_bot, "api_request", side_effect=RuntimeError("ADMIN_TELEGRAM_ID_NOT_AUTHORIZED")):
            with self.assertRaisesRegex(ValueError, "ADMIN_TELEGRAM_ID_NOT_AUTHORIZED"):
                issue_admin_webapp_session(signed_init_data())

    def test_signer_requires_current_allowlisted_session(self):
        session = create_admin_web_session(ADMIN_ID, SESSION_SECRET, now=int(time.time()))
        payload = {
            "activationId": "00000000-0000-4000-8000-000000000001",
            "companyId": "comp_novda",
            "companyName": "Novda",
            "expiresAt": None,
            "issuedAt": "2026-09-24T00:00:00Z",
            "machineId": "1111-2222-3333-4444",
            "requireTicketValidation": True,
            "role": "admin",
            "schema": "novda-license-v1",
            "status": "active",
        }
        signer = admin_bot.Ed25519PrivateKey.generate()
        with patch.object(admin_bot, "ADMIN_WEBAPP_SESSION_SECRET", SESSION_SECRET), \
                patch.object(admin_bot, "LICENSE_PRIVATE_KEY", signer), \
                patch.object(admin_bot, "api_request", return_value={"access": {"isGlobalAdmin": False, "companyIds": ["comp_novda"]}}) as api_request:
            signed = sign_activation_for_admin_session(session["token"], payload)
        self.assertEqual(signed["telegramId"], ADMIN_ID)
        self.assertTrue(signed["signedActivation"]["signature"])
        api_request.assert_called_once_with("POST", "/internal/admin/webapp/authorize", {"telegramId": ADMIN_ID, "companyId": "comp_novda"})

        with patch.object(admin_bot, "ADMIN_WEBAPP_SESSION_SECRET", SESSION_SECRET), \
                patch.object(admin_bot, "LICENSE_PRIVATE_KEY", signer), \
                patch.object(admin_bot, "api_request", side_effect=RuntimeError("ADMIN_COMPANY_SCOPE_REQUIRED")):
            with self.assertRaisesRegex(ValueError, "ADMIN_SESSION_NOT_AUTHORIZED"):
                sign_activation_for_admin_session(session["token"], payload)

    def test_telegram_menu_is_unchanged_until_the_admin_webapp_health_marker_passes(self):
        with patch.object(admin_bot, "ADMIN_WEBAPP_URL", admin_bot.ADMIN_WEBAPP_CANONICAL_URL), \
                patch.object(admin_bot, "ADMIN_WEBAPP_READY", False), \
                patch.object(admin_bot, "admin_webapp_is_healthy", return_value=False), \
                patch.object(admin_bot, "telegram_request") as telegram_request:
            self.assertFalse(admin_bot.configure_admin_webapp_menu())
            telegram_request.assert_not_called()
            self.assertIsNone(admin_bot.admin_webapp_keyboard())

        with patch.object(admin_bot, "ADMIN_WEBAPP_URL", admin_bot.ADMIN_WEBAPP_CANONICAL_URL), \
                patch.object(admin_bot, "ADMIN_WEBAPP_READY", False), \
                patch.object(admin_bot, "admin_webapp_is_healthy", return_value=True), \
                patch.object(admin_bot, "telegram_request") as telegram_request:
            self.assertTrue(admin_bot.configure_admin_webapp_menu())
            telegram_request.assert_called_once_with("setChatMenuButton", {
                "menu_button": {
                    "type": "web_app",
                    "text": "📱 Boshqaruv Paneli",
                    "web_app": {"url": admin_bot.ADMIN_WEBAPP_CANONICAL_URL},
                }
            })
            keyboard = admin_bot.admin_webapp_keyboard()
            self.assertEqual(keyboard["inline_keyboard"][0][0]["web_app"]["url"], admin_bot.ADMIN_WEBAPP_CANONICAL_URL)

    def test_webapp_health_probe_requires_page_assets_and_protected_api_route(self):
        class FakeResponse:
            status = 200

            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit=-1):
                return self.body

        unauthorized_body = json.dumps({"success": False, "error": {"code": "ADMIN_SESSION_REQUIRED"}}).encode()
        auth_error = urllib.error.HTTPError(
            "http://novda-api:3474/api/admin/webapp/session", 401, "Unauthorized", {}, io.BytesIO(unauthorized_body)
        )
        with patch.object(admin_bot, "ADMIN_WEBAPP_URL", admin_bot.ADMIN_WEBAPP_CANONICAL_URL), \
                patch.object(admin_bot, "API_BASE_URL", "http://novda-api:3474"), \
                patch.object(admin_bot.urllib.request, "urlopen", side_effect=[
                    FakeResponse(b'<meta name="novda-admin-webapp-version"><script src="/admin-app/admin.js"></script>'),
                    FakeResponse(b"const API = '/api/admin/webapp'; telegram.initData"),
                    auth_error,
                ]) as urlopen:
            self.assertTrue(admin_bot.admin_webapp_is_healthy())
            self.assertEqual(urlopen.call_count, 3)

        with patch.object(admin_bot, "ADMIN_WEBAPP_URL", admin_bot.ADMIN_WEBAPP_CANONICAL_URL), \
                patch.object(admin_bot, "API_BASE_URL", "http://novda-api:3474"), \
                patch.object(admin_bot.urllib.request, "urlopen", return_value=FakeResponse(b"legacy page")):
            self.assertFalse(admin_bot.admin_webapp_is_healthy())

    def test_configured_admin_webapp_url_rejects_noncanonical_hosts(self):
        self.assertTrue(admin_bot.is_canonical_admin_webapp_url(admin_bot.ADMIN_WEBAPP_CANONICAL_URL))
        self.assertFalse(admin_bot.is_canonical_admin_webapp_url("https://legacy.invalid/webapp"))
        self.assertFalse(admin_bot.is_canonical_admin_webapp_url("https://sync.novdatextile.uz/other"))
        self.assertFalse(admin_bot.is_canonical_admin_webapp_url("https://sync.novdatextile.uz/admin-app?debug=1"))

    def test_internal_http_routes_require_service_auth_and_server_authorized_signed_identity(self):
        signer = admin_bot.Ed25519PrivateKey.generate()
        def authorize(method, route, payload):
            if payload.get("telegramId") != ADMIN_ID:
                raise RuntimeError("ADMIN_TELEGRAM_ID_NOT_AUTHORIZED")
            if payload.get("companyId") not in (None, "comp_novda"):
                raise RuntimeError("ADMIN_COMPANY_SCOPE_REQUIRED")
            return {"access": {"isGlobalAdmin": False, "companyIds": ["comp_novda"]}}
        with patch.object(admin_bot, "BOT_TOKEN", BOT_TOKEN), \
                patch.object(admin_bot, "ADMIN_API_TOKEN", "internal-service-token"), \
                patch.object(admin_bot, "ADMIN_IDS", {ADMIN_ID}), \
                patch.object(admin_bot, "ADMIN_WEBAPP_SESSION_SECRET", SESSION_SECRET), \
                patch.object(admin_bot, "LICENSE_PRIVATE_KEY", signer), \
                patch.object(admin_bot, "api_request", side_effect=authorize):
            server = ThreadingHTTPServer(("127.0.0.1", 0), admin_bot.HealthHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_address[1]}"
                unauthenticated = urllib.request.Request(
                    f"{base}/internal/admin/webapp/session",
                    data=json.dumps({"initData": signed_init_data()}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    urllib.request.urlopen(unauthenticated, timeout=3)
                self.assertEqual(denied.exception.code, 401)
                self.assertEqual(json.loads(denied.exception.read())["error"]["code"], "ADMIN_SERVICE_AUTH_REQUIRED")
                denied.exception.close()

                def post(route, body):
                    request = urllib.request.Request(
                        f"{base}{route}",
                        data=json.dumps(body).encode("utf-8"),
                        headers={"Content-Type": "application/json", "x-novda-admin-token": "internal-service-token"},
                        method="POST",
                    )
                    with urllib.request.urlopen(request, timeout=3) as response:
                        return response.status, json.loads(response.read())

                status, result = post("/internal/admin/webapp/session", {"initData": signed_init_data()})
                self.assertEqual(status, 200)
                session = result["session"]["token"]
                payload = {
                    "activationId": "00000000-0000-4000-8000-000000000001",
                    "companyId": "comp_novda",
                    "companyName": "Novda",
                    "expiresAt": None,
                    "issuedAt": "2026-09-24T00:00:00Z",
                    "machineId": "1111-2222-3333-4444",
                    "requireTicketValidation": True,
                    "role": "admin",
                    "schema": "novda-license-v1",
                    "status": "active",
                }
                sign_status, signed = post("/internal/admin/webapp/sign-activation", {
                    "sessionToken": session, "payload": payload
                })
                self.assertEqual(sign_status, 200)
                self.assertEqual(signed["telegramId"], ADMIN_ID)
                self.assertTrue(signed["signedActivation"]["signature"])
                try:
                    post("/internal/admin/webapp/session", {"initData": signed_init_data("99887766")})
                    self.fail("non-allowlisted Telegram ID unexpectedly received a session")
                except urllib.error.HTTPError as unauthorized:
                    self.assertEqual(unauthorized.code, 403)
                    unauthorized.read()
                    unauthorized.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
