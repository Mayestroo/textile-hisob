"""Subprocess acceptance driver (not a pytest module): local API, no bot polling."""
import importlib.util
import json
from pathlib import Path
import sys
import urllib.parse
import urllib.request

spec = importlib.util.spec_from_file_location("worker_acceptance_bot", Path(__file__).resolve().parent.parent / "src" / "worker_bot.py")
bot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bot)

config = json.load(sys.stdin)
base = config["base"]
parsed_base = urllib.parse.urlparse(base)
assert parsed_base.scheme == "http" and parsed_base.hostname == "127.0.0.1" and parsed_base.port > 1
original_urlopen = urllib.request.urlopen
requests = []
replies = []


def local_only(request, *args, **kwargs):
    url = request.full_url if isinstance(request, urllib.request.Request) else str(request)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "http" or parsed.netloc != parsed_base.netloc or not parsed.path.startswith("/api/worker/"):
        raise AssertionError("OUTBOUND_NETWORK_BLOCKED")
    requests.append(parsed.path)
    return original_urlopen(request, *args, **kwargs)


def capture(method, payload):
    if method not in ("sendMessage", "deleteMessage"):
        raise AssertionError("TELEGRAM_METHOD_BLOCKED")
    replies.append({"method": method, "payload": payload})
    return {"ok": True}


urllib.request.urlopen = local_only
bot.telegram_api = capture
bot.API_BASE_URL = base
bot.BOT_TOKEN = "000000:synthetic-only"
bot.WORKER_API_TOKEN = config["token"]
bot.WORKER_AUTH_HMAC_SECRET = config["hmac"]
bot.WORKER_WEBAPP_URL = base + "/worker-app"
bot.DEFAULT_COMPANY_ID = ""
bot.USER_STATES.clear()
if config.get("stale_binding"):
    bot.USER_STATES[str(config["updates"][0]["user_id"])] = {
        "step": "BOUND", "binding": config["stale_binding"]
    }

for item in config["updates"]:
    bot.process_update({"message": {
        "chat": {"id": item.get("chat_id", item["user_id"]), "type": item.get("type", "private")},
        "from": {"id": item["user_id"], "username": "synthetic"},
        "text": item["text"], "message_id": 17,
    }})

print(json.dumps({"requests": requests, "replies": replies}))
