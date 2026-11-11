"""Subprocess acceptance driver (not a pytest module). Never starts polling."""
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
spec = importlib.util.spec_from_file_location("admin_acceptance_bot", Path(__file__).resolve().parent.parent / "src" / "admin_bot.py")
bot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bot)
config = json.loads(sys.stdin.readline())
api_base = config["api_base"]
parsed = urllib.parse.urlparse(api_base)
assert parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port > 1
original_urlopen = urllib.request.urlopen
api_requests = []
replies = []


def local_only(request, *args, **kwargs):
    url = request.full_url if isinstance(request, urllib.request.Request) else str(request)
    target = urllib.parse.urlparse(url)
    if target.scheme != "http" or target.netloc != parsed.netloc or not target.path.startswith("/"):
        raise AssertionError("OUTBOUND_NETWORK_BLOCKED")
    api_requests.append(target.path)
    return original_urlopen(request, *args, **kwargs)


def capture(method, payload):
    if method != "sendMessage":
        raise AssertionError("TELEGRAM_METHOD_BLOCKED")
    replies.append({"method": method, "payload": payload})
    return {"ok": True}


bot.API_BASE_URL = api_base
bot.ADMIN_API_TOKEN = config["service_token"]
bot.BOT_TOKEN = "123456:synthetic-only"
bot.ADMIN_WEBAPP_URL = api_base + "/admin-app"
bot.ADMIN_WEBAPP_READY = True
bot.ADMIN_WEBAPP_SESSION_SECRET = config["session_secret"]
bot.telegram_request = capture
urllib.request.urlopen = local_only

server = ThreadingHTTPServer(("127.0.0.1", 0), bot.HealthHandler)
server.daemon_threads = True
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
telegram_id = config["telegram_id"]
for item in config.get("updates", [{"chat_id": int(telegram_id), "type": "private", "user_id": int(telegram_id)}]):
    bot.process_update({"message": {
        "chat": {"id": item.get("chat_id", item["user_id"]), "type": item.get("type", "private")},
        "from": {"id": item["user_id"]}, "text": item.get("text", "/start")
    }})

now = int(time.time())
fields = {"auth_date": str(now), "query_id": "AAE-synthetic-admin",
          "user": json.dumps({"id": int(telegram_id), "first_name": "Synthetic Admin"}, separators=(",", ":"))}
check = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
secret = hmac.new(b"WebAppData", bot.BOT_TOKEN.encode(), hashlib.sha256).digest()
fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
expired = bot.create_admin_web_session(telegram_id, config["session_secret"], now=now - 1000)["token"]
print(json.dumps({"admin_http_base": f"http://127.0.0.1:{server.server_address[1]}",
                  "init_data": urlencode(fields), "expired_session": expired,
                  "api_requests": api_requests, "replies": replies}), flush=True)
try:
    sys.stdin.readline()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)
