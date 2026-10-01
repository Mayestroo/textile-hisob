#!/usr/bin/env python3
"""
Novda Hisob-Kitob — Ishchilar Uchun Alohida Telegram Boti
Papka: worker-bot/

Har bir ishchi FAQAT o'zining shaxsiy hisob-kitobini ko'ra oladi:
- Sof foyda (qo'lga tegishi)
- Olingan avans va jarimalar
- Modellar va operatsiyalar kesimidagi ishbay hisob
- Skanerlangan pattalar tarixi
Boshqa ishchilar va korxona ma'lumotlari mutlaqo ko'rinmaydi.
"""

import sys
import os
import json
import time
import re
import html
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime
import urllib.request
import urllib.parse

# Fix Windows console encoding
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(CURRENT_DIR, 'config.json')
BINDINGS_FILE = os.path.join(CURRENT_DIR, 'bindings.json')
ENV_FILE = os.path.join(CURRENT_DIR, '.env')

def load_env_file():
    """Load key-value pairs from .env if present without external dependencies."""
    if os.path.exists(ENV_FILE):
        try:
            with open(ENV_FILE, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    if k and k not in os.environ:
                        os.environ[k] = v
        except Exception as e:
            print(f"[Env Loader Note]: {e}")

load_env_file()

def load_config():
    cfg = {
        "bot_token": os.environ.get("WORKER_BOT_TOKEN", "").strip(),
        "company_id": os.environ.get("DEFAULT_COMPANY_ID", "comp_novda").strip(),
        "webapp_url": os.environ.get("WORKER_WEBAPP_URL", "").strip()
    }
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                saved = json.load(f)
                if isinstance(saved, dict):
                    if not cfg["bot_token"] and saved.get("bot_token"):
                        cfg["bot_token"] = saved["bot_token"].strip()
                    if saved.get("company_id"):
                        cfg["company_id"] = saved["company_id"].strip()
                    if not cfg["webapp_url"] and saved.get("webapp_url"):
                        cfg["webapp_url"] = saved["webapp_url"].strip()
        except Exception as e:
            print(f"[Config Error]: {e}")
    return cfg

config = load_config()
BOT_TOKEN = config.get("bot_token", "")
DEFAULT_COMPANY_ID = config.get("company_id", "comp_novda")
PORT = int(os.environ.get("PORT", "8081"))
FIREBASE_RTDB_URL = os.environ.get(
    "FIREBASE_DATABASE_URL",
    "https://hisobchi-c930c-default-rtdb.asia-southeast1.firebasedatabase.app"
).rstrip('/')

# In-memory user states for registration flow
user_states = {}

import hmac
import hashlib

WORKER_AUTH_HMAC_SECRET = os.environ.get("WORKER_AUTH_HMAC_SECRET", "").strip()

def generate_worker_token(company_id, worker_id, tg_id):
    if not WORKER_AUTH_HMAC_SECRET:
        raise RuntimeError("CONFIGURATION_ERROR: WORKER_AUTH_HMAC_SECRET is not configured.")
    raw = f"{company_id}:{worker_id}:{tg_id}"
    return hmac.new(WORKER_AUTH_HMAC_SECRET.encode('utf-8'), raw.encode('utf-8'), hashlib.sha256).hexdigest()

def verify_worker_token(company_id, worker_id, tg_id, token):
    if not token or not company_id or not worker_id or not tg_id:
        return False
    expected = generate_worker_token(company_id, worker_id, tg_id)
    return hmac.compare_digest(expected, token)

def get_base_webapp_url():
    configured_url = os.environ.get("WORKER_WEBAPP_URL", "").strip()
    if not configured_url:
        configured_url = str(config.get("webapp_url") or "").strip()
    if configured_url != "https://sync.novdatextile.uz/worker-app":
        raise RuntimeError("WORKER_WEBAPP_URL_REQUIRED")
    return configured_url

def generate_v2_worker_webapp_token(company_id, worker_id, tg_id, expires_at):
    if not WORKER_AUTH_HMAC_SECRET:
        raise RuntimeError("CONFIGURATION_ERROR: WORKER_AUTH_HMAC_SECRET is not configured.")
    message = f"v1:{company_id}:{int(worker_id)}:{str(tg_id)}:{int(expires_at)}"
    return hmac.new(WORKER_AUTH_HMAC_SECRET.encode('utf-8'), message.encode('utf-8'), hashlib.sha256).hexdigest()

def get_webapp_full_url(company_id, worker_id, tg_id=None):
    if not tg_id and worker_id:
        try:
            b = get_worker_id_binding(company_id, worker_id)
            if isinstance(b, dict) and b.get("tg_id"):
                tg_id = b["tg_id"]
        except Exception:
            pass
    base = get_base_webapp_url()
    if tg_id:
        expires_at = int(time.time()) + 15 * 60
        token = generate_v2_worker_webapp_token(company_id, worker_id, tg_id, expires_at)
        return f"{base}?{urllib.parse.urlencode({'companyId': company_id, 'workerId': int(worker_id), 'telegramId': str(tg_id), 'expiresAt': expires_at, 'authToken': token})}"
    return f"{base}?{urllib.parse.urlencode({'companyId': company_id, 'workerId': int(worker_id)})}"

# ─────────────────────────────────────────────────────────────────────────────
# BINDINGS (Telegram ID <-> Worker ID)
# ─────────────────────────────────────────────────────────────────────────────

def get_local_bindings():
    if os.path.exists(BINDINGS_FILE):
        try:
            with open(BINDINGS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_local_binding(tg_id, binding_data):
    bindings = get_local_bindings()
    if binding_data is None:
        bindings.pop(str(tg_id), None)
    else:
        bindings[str(tg_id)] = binding_data
    try:
        with open(BINDINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(bindings, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Binding Save Error] {e}")

def get_worker_binding(tg_id):
    """Checks Firebase RTDB, falls back to local bindings."""
    try:
        url = f"{FIREBASE_RTDB_URL}/worker_telegram_bindings/{tg_id}.json"
        req = urllib.request.Request(url, headers={'User-Agent': 'NovdaWorkerBot/1.0'})
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if isinstance(data, dict) and data.get("worker_id"):
                save_local_binding(tg_id, data)
                return data
    except Exception as e:
        print(f"[Firebase Binding Check Warn]: {e}")

    local = get_local_bindings()
    return local.get(str(tg_id))

def get_worker_id_binding(company_id, worker_id):
    """Checks if a worker ID is already claimed by any Telegram user."""
    try:
        url = f"{FIREBASE_RTDB_URL}/companies/{company_id}/worker_bindings/{worker_id}.json"
        req = urllib.request.Request(url, headers={'User-Agent': 'NovdaWorkerBot/1.0'})
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if isinstance(data, dict) and data.get("tg_id"):
                return data
    except Exception:
        pass
    return None

def save_worker_binding(tg_id, worker_id, worker_name, company_id=DEFAULT_COMPANY_ID, username=""):
    payload = {
        "tg_id": tg_id,
        "worker_id": int(worker_id),
        "worker_name": worker_name,
        "company_id": company_id,
        "username": username or "",
        "linked_at": datetime.now().isoformat()
    }
    save_local_binding(tg_id, payload)
    try:
        url = f"{FIREBASE_RTDB_URL}/worker_telegram_bindings/{tg_id}.json"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='PUT'
        )
        with urllib.request.urlopen(req, timeout=8):
            pass
    except Exception as e:
        print(f"[Firebase Binding Save Error]: {e}")

    # Reverse binding: prevents anyone else from claiming this worker ID
    try:
        rev_url = f"{FIREBASE_RTDB_URL}/companies/{company_id}/worker_bindings/{worker_id}.json"
        rev_payload = {
            "tg_id": tg_id,
            "worker_name": worker_name,
            "linked_at": datetime.now().isoformat()
        }
        req_rev = urllib.request.Request(
            rev_url,
            data=json.dumps(rev_payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='PUT'
        )
        with urllib.request.urlopen(req_rev, timeout=8):
            pass
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Doimiy bog'landi: tg={tg_id} <-> worker #{worker_id} ({worker_name})")
    except Exception as e:
        print(f"[Firebase Reverse Binding Error]: {e}")

    return payload

# ─────────────────────────────────────────────────────────────────────────────
# FIREBASE WORKER CALCULATIONS
# ─────────────────────────────────────────────────────────────────────────────

def fetch_json(endpoint, timeout=12):
    try:
        url = f"{FIREBASE_RTDB_URL}/{endpoint.lstrip('/')}"
        req = urllib.request.Request(url, headers={'User-Agent': 'NovdaWorkerBot/1.0'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"[Firebase Fetch Warn] {endpoint}: {e}")
        return None

def get_worker_profile_and_stats(company_id, worker_id):
    """
    Fetches worker data and calculates exact earnings, advances, fines, and net profit.
    Calculates exclusively for this worker. Returns None if worker not found.
    """
    workers = fetch_json(f"companies/{company_id}/syncData/workers.json")
    if not isinstance(workers, list):
        return None

    worker = next((w for w in workers if isinstance(w, dict) and int(w.get('id', -1)) == int(worker_id)), None)
    if not worker:
        return None

    models = fetch_json(f"companies/{company_id}/syncData/models.json")
    if not isinstance(models, list):
        models = []

    current_period = fetch_json(f"companies/{company_id}/syncData/currentPeriod.json")
    period_name = current_period.get("name") if isinstance(current_period, dict) else "Joriy Oylik Davr"

    total_gross = 0.0
    total_pieces = 0.0
    models_breakdown = {}

    wid_str = str(worker_id)
    for model in models:
        if not isinstance(model, dict):
            continue
        m_id = model.get("id")
        m_name = model.get("name") or f"Model #{m_id}"
        ops = model.get("operations") or []
        op_rates = {op.get("name"): float(op.get("rate", 0)) for op in ops if isinstance(op, dict)}
        
        hq = model.get("hisobQuantities")
        w_ops = {}
        wid_int = int(worker_id)
        if isinstance(hq, dict):
            w_ops = hq.get(wid_str) or hq.get(wid_int) or {}
        elif isinstance(hq, list):
            if 0 <= wid_int < len(hq) and hq[wid_int]:
                w_ops = hq[wid_int]
        if not isinstance(w_ops, dict):
            w_ops = {}

        m_gross = 0.0
        m_pieces = 0.0
        done_ops = []

        for op_name, qty in w_ops.items():
            try:
                num_qty = float(qty)
            except (ValueError, TypeError):
                num_qty = 0.0

            if num_qty > 0:
                rate = op_rates.get(op_name, 0.0)
                amount = num_qty * rate
                m_gross += amount
                m_pieces += num_qty
                done_ops.append({
                    "name": op_name,
                    "rate": rate,
                    "qty": num_qty,
                    "amount": amount
                })

        if m_gross > 0 or m_pieces > 0:
            models_breakdown[m_id] = {
                "name": m_name,
                "earnings": m_gross,
                "pieces": m_pieces,
                "operations": done_ops
            }
            total_gross += m_gross
            total_pieces += m_pieces

    import math
    def safe_num(val):
        try:
            f = float(val or 0.0)
            return f if math.isfinite(f) else 0.0
        except (ValueError, TypeError):
            return 0.0

    avans = max(0.0, safe_num(worker.get("avans")))
    jarima = max(0.0, safe_num(worker.get("jarima")))
    staj = max(0.0, safe_num(worker.get("staj")))
    net_pay = total_gross - avans - jarima - staj

    return {
        "worker_id": int(worker_id),
        "worker_name": worker.get("name") or f"Ishchi #{worker_id}",
        "company_id": company_id,
        "period_name": period_name,
        "gross": total_gross,
        "avans": avans,
        "jarima": jarima,
        "staj": staj,
        "net": net_pay,
        "pieces": total_pieces,
        "models_breakdown": models_breakdown
    }

def get_worker_recent_tickets(company_id, worker_id, limit=6):
    """Fetches recently scanned tickets where this worker had an operation."""
    tickets = fetch_json(f"companies/{company_id}/syncData/submittedTickets.json", timeout=15)
    if not tickets:
        return []

    ticket_list = tickets if isinstance(tickets, list) else list(tickets.values())
    my_tickets = []
    wid_int = int(worker_id)

    for t in reversed(ticket_list):
        if not isinstance(t, dict):
            continue
        entries = t.get("entries") or []
        def safe_wid(val):
            try:
                return int(val)
            except (ValueError, TypeError):
                return -1
        my_ops = [e.get("opName") for e in entries if isinstance(e, dict) and safe_wid(e.get("workerId")) == wid_int]
        if my_ops:
            my_tickets.append({
                "model_id": t.get("modelId") or "Model",
                "patta_number": t.get("pattaNumber") or 1,
                "party_number": t.get("partyNumber") or "-",
                "size": t.get("size") or "-",
                "color": t.get("color") or "-",
                "qty": t.get("qty") or 0,
                "submitted_at": t.get("submittedAt") or "",
                "my_operations": ", ".join(my_ops)
            })
            if len(my_tickets) >= limit:
                break

    return my_tickets

# ─────────────────────────────────────────────────────────────────────────────
# TELEGRAM BOT API HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def send_api(method, payload):
    if not BOT_TOKEN:
        print("[Warn] BOT_TOKEN sozlanmagan!")
        return None
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data_bytes = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data_bytes,
        headers={'Content-Type': 'application/json'}
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f"[Telegram API Error] {method}: {e}")
        return None


def build_main_reply_keyboard(company_id, worker_id, tg_id=None):
    app_url = get_webapp_full_url(company_id, worker_id, tg_id)
    return {
        "keyboard": [
            [
                {"text": "📱 Mening Hisobim (Web App)", "web_app": {"url": app_url}}
            ],
            [
                {"text": "💰 Sof Foyda va Oylik"},
                {"text": "📋 Bajargan Ishlarim"}
            ],
            [
                {"text": "🎫 Oxirgi Pattalarim"},
                {"text": "🔄 Yangilash"}
            ],
            [
                {"text": "ℹ️ Yordam & Qoidalar"}
            ]
        ],
        "resize_keyboard": True,
        "is_persistent": True
    }

def format_money(amt):
    return f"{int(round(amt)):,}".replace(",", " ") + " so'm"

def format_number(amt):
    return f"{int(round(amt)):,}".replace(",", " ")

def escape_html(value):
    return html.escape(str(value), quote=True)

# ─────────────────────────────────────────────────────────────────────────────
# BOT MESSAGE & CALLBACK HANDLERS
# ─────────────────────────────────────────────────────────────────────────────

def handle_start(chat_id, user):
    tg_id = user.get("id")
    binding = get_worker_binding(tg_id)

    if binding and binding.get("worker_id"):
        wid = binding["worker_id"]
        comp = binding.get("company_id", DEFAULT_COMPANY_ID)
        name = binding.get("worker_name", f"Ishchi #{wid}")

        stats = get_worker_profile_and_stats(comp, wid)
        app_url = get_webapp_full_url(comp, wid, tg_id)
        net_text = format_money(stats["net"]) if stats else "Hisoblanmoqda..."

        msg = (
            f"👋 <b>Assalomu alaykum, {escape_html(name)}!</b>\n\n"
            f"🆔 <b>Sizning ID:</b> #{wid}\n"
            f"💵 <b>Qo'lga tegadigan Sof Foyda:</b> <code>{net_text}</code>\n\n"
            f"🔒 <i>Ushbu bot sizning ID #{wid} hisobingizga doimiy biriktirilgan. "
            f"Boshqalar siznikini, siz esa birovnikini ko'ra olmaysiz.</i>\n\n"
            f"👇 Quyidagi tugmalar orqali hisobotlaringiz bilan tanishing:"
        )

        reply_markup = build_main_reply_keyboard(comp, wid, tg_id)
        inline_markup = {
            "inline_keyboard": [
                [
                    {"text": "🚀 Mening Shaxsiy Hisobim (Web App)", "web_app": {"url": app_url}}
                ]
            ]
        }
        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": msg,
            "parse_mode": "HTML",
            "reply_markup": reply_markup
        })
        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": "📱 Web App ko'rinishida to'liq hisobotni ochish:",
            "reply_markup": inline_markup
        })
    else:
        user_states[tg_id] = {"step": "WAITING_WORKER_ID"}
        msg = (
            f"👋 <b>Assalomu alaykum!</b>\n\n"
            f"Novda xodimlarining shaxsiy hisob-kitob botiga xush kelibsiz.\n\n"
            f"Tizimdan foydalanish uchun korxonadagi <b>Ishchi ID</b> raqamingizni kiriting:\n"
            f"<i>(Masalan: <code>27</code>)</i>\n\n"
            f"⚠️ <b>Eslatma:</b> Kiritilgan ID raqam profilingizga doimiy biriktiriladi va keyinchalik o'zboshimchalik bilan o'zgartirib bo'lmaydi."
        )
        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": msg,
            "parse_mode": "HTML",
            "reply_markup": {"remove_keyboard": True}
        })

def handle_text_input(chat_id, user, text):
    tg_id = user.get("id")
    binding = get_worker_binding(tg_id)

    # If worker is ALREADY BOUND -> strictly locked to their own ID
    if binding and binding.get("worker_id"):
        wid = binding["worker_id"]
        wname = binding.get("worker_name", f"Ishchi #{wid}")

        if text in ("💰 Sof Foyda va Oylik", "/hisob"):
            handle_finances(chat_id, tg_id)
            return

        if text in ("📋 Bajargan Ishlarim", "/operatsiyalar"):
            handle_operations(chat_id, tg_id)
            return

        if text in ("🎫 Oxirgi Pattalarim", "/pattalar"):
            handle_tickets(chat_id, tg_id)
            return

        if text in ("🔄 Yangilash", "/refresh"):
            handle_start(chat_id, user)
            return

        if text in ("ℹ️ Yordam & Qoidalar", "/help"):
            handle_help(chat_id, tg_id)
            return

        # Attempt to exit, unbind, or enter another worker's number is BLOCKED
        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": (
                f"🔒 <b>Xavfsizlik qoidasi:</b>\n\n"
                f"Siz allaqachon <b>#{wid} ({escape_html(wname)})</b> hisobiga doimiy biriktirilgansiz.\n"
                f"Boshqa xodimlar hisob-kitobini ko'rish yoki hisobdan chiqish taqiqlangan.\n\n"
                f"<i>Agar hisobni o'zgartirish zarur bo'lsa, korxona ustasi yoki ma'muriyatiga murojaat qiling.</i>"
            ),
            "parse_mode": "HTML",
            "reply_markup": build_main_reply_keyboard(binding.get("company_id", DEFAULT_COMPANY_ID), wid, tg_id)
        })
        return

    # If NOT bound yet:
    state = user_states.get(tg_id, {})
    step = state.get("step")

    if step == "AWAITING_PIN":
        expected_pin = state.get("expected_pin", "")
        entered_pin = text.strip()
        if entered_pin != expected_pin:
            send_api("sendMessage", {
                "chat_id": chat_id,
                "text": "❌ <b>Noto'g'ri PIN-kod!</b> Iltimos qaytadan urinib ko'ring yoki /start bosib boshidan boshlang:",
                "parse_mode": "HTML"
            })
            return
        cid = state.get("candidate_id")
        wname = state.get("candidate_name")
        save_worker_binding(tg_id, cid, wname, DEFAULT_COMPANY_ID, user.get("username", ""))
        user_states.pop(tg_id, None)
        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": (
                f"🎉 <b>Tabriklaymiz, profilingiz muvaffaqiyatli bog'landi!</b>\n━━━━━━━━━━━━━━━━━━━━\n"
                f"🆔 <b>Ishchi ID:</b> #{cid}\n"
                f"👤 <b>F.I.O:</b> {escape_html(wname)}\n\n"
                f"Quyidagi tugmalar orqali o'z oylik hisob-kitoblaringizni ko'rishingiz mumkin:"
            ),
            "parse_mode": "HTML",
            "reply_markup": build_main_reply_keyboard(DEFAULT_COMPANY_ID, cid, tg_id)
        })
        return

    if step == "WAITING_WORKER_ID" or not binding:
        digits = re.findall(r'\d+', text)
        if not digits:
            send_api("sendMessage", {
                "chat_id": chat_id,
                "text": "⚠️ Iltimos, faqat o'zingizning ID raqamingizni kiriting (Masalan: <code>27</code>):",
                "parse_mode": "HTML"
            })
            return

        candidate_id = int(digits[0])

        # Security check: verify if this worker ID is already claimed by another Telegram user
        claimed = get_worker_id_binding(DEFAULT_COMPANY_ID, candidate_id)
        if claimed and claimed.get("tg_id") and str(claimed["tg_id"]) != str(tg_id):
            send_api("sendMessage", {
                "chat_id": chat_id,
                "text": (
                    f"⛔ <b>Xavfsizlik cheklovi:</b>\n\n"
                    f"<b>ID #{candidate_id}</b> allaqachon boshqa Telegram akkauntiga biriktirilgan!\n"
                    f"Birovning shaxsiy hisobiga kirish qat'iyan taqiqlangan.\n\n"
                    f"<i>Agar bu sizning raqamingiz bo'lsa, korxona ustasi yoki ma'muriyatiga murojaat qiling.</i>"
                ),
                "parse_mode": "HTML"
            })
            return

        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": f"🔍 ID #{candidate_id} tekshirilmoqda, iltimos kuting..."
        })

        workers = fetch_json(f"companies/{DEFAULT_COMPANY_ID}/syncData/workers.json")
        if not isinstance(workers, list):
            send_api("sendMessage", {
                "chat_id": chat_id,
                "text": "❌ Baza bilan ulanishda xatolik yuz berdi. Birozdan so'ng qayta urinib ko'ring."
            })
            return

        worker = next((w for w in workers if isinstance(w, dict) and int(w.get('id', -1)) == candidate_id), None)
        if not worker:
            send_api("sendMessage", {
                "chat_id": chat_id,
                "text": (
                    f"❌ <b>ID #{candidate_id}</b> raqamli ishchi topilmadi.\n"
                    f"Iltimos, ID raqamingizni to'g'ri kiriting yoki ustangizdan aniqlang:"
                ),
                "parse_mode": "HTML"
            })
            return

        w_name = worker.get("name", f"Ishchi #{candidate_id}")
        worker_pin = str(worker.get("pin") or worker.get("code") or "").strip()
        if worker_pin:
            user_states[tg_id] = {
                "step": "AWAITING_PIN",
                "candidate_id": candidate_id,
                "candidate_name": w_name,
                "expected_pin": worker_pin
            }
            send_api("sendMessage", {
                "chat_id": chat_id,
                "text": (
                    f"👤 <b>Xodim:</b> {escape_html(w_name)} (#{candidate_id})\n\n"
                    f"🔒 Ushbu hisobni biriktirish uchun ustangiz yoki ma'muriyat tomonidan berilgan <b>maxfiy PIN-kodni</b> kiriting:"
                ),
                "parse_mode": "HTML"
            })
            return

        user_states[tg_id] = {
            "step": "CONFIRMING",
            "candidate_id": candidate_id,
            "candidate_name": w_name
        }

        msg = (
            f"👤 <b>Xodim topildi:</b>\n\n"
            f"🆔 <b>Ishchi ID:</b> #{candidate_id}\n"
            f"📝 <b>F.I.O:</b> {escape_html(w_name)}\n\n"
            f"Ushbu hisob-kitob <b>rostdan ham sizga tegishlimi?</b>\n"
            f"<i>Tasdiqlaganingizdan so'ng hisob profilingizga doimiy bog'lanadi.</i>"
        )
        inline_kb = {
            "inline_keyboard": [
                [
                    {"text": "✅ Ha, bu men (Doimiy bog'lash)", "callback_data": f"confirm_worker:{candidate_id}"},
                    {"text": "❌ Boshqa raqam", "callback_data": "cancel_worker"}
                ]
            ]
        }
        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": msg,
            "parse_mode": "HTML",
            "reply_markup": inline_kb
        })
        return

    send_api("sendMessage", {
        "chat_id": chat_id,
        "text": "Kerakli bo'limni pastdagi menyudan tanlang 👇"
    })

def handle_finances(chat_id, tg_id):
    binding = get_worker_binding(tg_id)
    if not binding:
        send_api("sendMessage", {"chat_id": chat_id, "text": "Avval /start buyrug'i orqali tizimga kiring."})
        return

    wid = binding["worker_id"]
    comp = binding.get("company_id", DEFAULT_COMPANY_ID)
    stats = get_worker_profile_and_stats(comp, wid)
    if not stats:
        send_api("sendMessage", {"chat_id": chat_id, "text": "Hisob-kitob ma'lumotlarini yuklab bo'lmadi."})
        return

    app_url = get_webapp_full_url(comp, wid, tg_id)
    msg = (
        f"📊 <b>SHAXSIY HISOB-KITOB</b>\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"👤 <b>Xodim:</b> {escape_html(stats['worker_name'])} (ID: #{wid})\n"
        f"📅 <b>Davr:</b> {escape_html(stats['period_name'])}\n\n"
        f"💵 <b>Jami ishlangan:</b> {format_money(stats['gross'])}\n"
        f"➖ <b>Olingan avans:</b> {format_money(stats['avans'])}\n"
        f"➖ <b>Jarima / Ushlanma:</b> {format_money(stats['jarima'])}\n"
        f"➖ <b>Staj / Chegirma:</b> {format_money(stats['staj'])}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"✅ <b>SOF FOYDA (Qo'lga tegishi):</b> <code>{format_money(stats['net'])}</code>\n"
        f"🏷 <b>Bajarilgan ish soni:</b> {format_number(stats['pieces'])} dona\n\n"
        f"🔒 <i>Faqat sizning shaxsiy statistikangiz.</i>"
    )
    # Sending main reply keyboard forces phone to clear old Chiqish button
    send_api("sendMessage", {
        "chat_id": chat_id,
        "text": msg,
        "parse_mode": "HTML",
        "reply_markup": build_main_reply_keyboard(comp, wid, tg_id)
    })

def handle_operations(chat_id, tg_id):
    binding = get_worker_binding(tg_id)
    if not binding:
        send_api("sendMessage", {"chat_id": chat_id, "text": "Avval /start buyrug'i orqali tizimga kiring."})
        return

    wid = binding["worker_id"]
    comp = binding.get("company_id", DEFAULT_COMPANY_ID)
    stats = get_worker_profile_and_stats(comp, wid)
    if not stats:
        send_api("sendMessage", {"chat_id": chat_id, "text": "Ma'lumot topilmadi."})
        return

    mb = stats.get("models_breakdown") or {}
    if not mb:
        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": "🧵 Sizga joriy davrda hali operatsiyalar yoki tikilgan choklar kiritilmagan.",
            "reply_markup": build_main_reply_keyboard(comp, wid, tg_id)
        })
        return

    text_parts = [
        f"📋 <b>BAJARILGAN ISHLAR TAFSILOTI</b>\n"
        f"👤 {escape_html(stats['worker_name'])} (ID: #{wid})\n"
        f"━━━━━━━━━━━━━━━━━━"
    ]

    for m_id, m in mb.items():
        text_parts.append(f"\n👗 <b>{escape_html(m['name'])}</b>: <code>{format_money(m['earnings'])}</code>")
        for op in m["operations"]:
            text_parts.append(
                f"  • {escape_html(op['name'])}: {format_number(op['qty'])} dona × {format_number(op['rate'])} so'm = <b>{format_money(op['amount'])}</b>"
            )

    text_parts.append("\n━━━━━━━━━━━━━━━━━━")
    text_parts.append(f"💵 <b>Jami hisoblangan:</b> <code>{format_money(stats['gross'])}</code>")

    send_api("sendMessage", {
        "chat_id": chat_id,
        "text": "\n".join(text_parts),
        "parse_mode": "HTML",
        "reply_markup": build_main_reply_keyboard(comp, wid, tg_id)
    })

def handle_tickets(chat_id, tg_id):
    binding = get_worker_binding(tg_id)
    if not binding:
        send_api("sendMessage", {"chat_id": chat_id, "text": "Avval /start orqali kiring."})
        return

    wid = binding["worker_id"]
    comp = binding.get("company_id", DEFAULT_COMPANY_ID)
    send_api("sendMessage", {"chat_id": chat_id, "text": "⏳ Pattalar yuklanmoqda..."})

    tickets = get_worker_recent_tickets(comp, wid, limit=8)
    if not tickets:
        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": "🎫 Hozircha sizning ID raqamingiz bilan skanerlangan chiptalar (pattalar) topilmadi.",
            "reply_markup": build_main_reply_keyboard(comp, wid, tg_id)
        })
        return

    lines = [
        f"🎫 <b>OXIRGI TOPSHIRILGAN PATTALAR:</b>\n"
        f"━━━━━━━━━━━━━━━━━━"
    ]
    for t in tickets:
        lines.append(
            f"🏷 <b>{escape_html(t['model_id'])}</b> (Patta #{t['patta_number']})\n"
            f"Partiya: {escape_html(t['party_number'])} | Razmer: {escape_html(t['size'])} | Rang: {escape_html(t['color'])}\n"
            f"🧵 Chok: <b>{escape_html(t['my_operations'])}</b>\n"
            f"📦 Soni: <b>{t['qty']} dona</b> | ⏱️ {escape_html(t['submitted_at'])}\n"
        )

    send_api("sendMessage", {
        "chat_id": chat_id,
        "text": "\n".join(lines),
        "parse_mode": "HTML",
        "reply_markup": build_main_reply_keyboard(comp, wid, tg_id)
    })

def handle_help(chat_id, tg_id):
    binding = get_worker_binding(tg_id)
    wid_text = f"#{binding['worker_id']}" if binding else "Bog'lanmagan"
    comp = binding.get("company_id", DEFAULT_COMPANY_ID) if binding else DEFAULT_COMPANY_ID
    wid = binding["worker_id"] if binding else 0
    msg = (
        f"ℹ️ <b>YORDAM VA FOYDALANISH QOIDALARI</b>\n\n"
        f"• <b>Shaxsiy ID:</b> {wid_text}\n"
        f"• <b>Sof Foyda formulasi:</b>\n"
        f"  <code>Sof Foyda = Jami tikilgan summa - Avans - Jarima</code>\n\n"
        f"🔒 <b>Xavfsizlik:</b> Siz faqat o'zingizga tegishli raqamlar va pattalarni ko'rasiz. Hisobdan chiqish yoki boshqa xodim hisobiga kirish taqiqlangan.\n\n"
        f"❓ Agar biror patta chiqmay qolgan bo'lsa yoki avans miqdorida savol bo'lsa, korxona ustasiga murojaat qiling."
    )
    send_api("sendMessage", {
        "chat_id": chat_id,
        "text": msg,
        "parse_mode": "HTML",
        "reply_markup": build_main_reply_keyboard(comp, wid, tg_id) if wid else {"remove_keyboard": True}
    })

def handle_callback_query(callback):
    cb_id = callback.get("id")
    data = callback.get("data", "")
    from_user = callback.get("from", {})
    tg_id = from_user.get("id")
    chat_id = callback.get("message", {}).get("chat", {}).get("id")

    send_api("answerCallbackQuery", {"callback_query_id": cb_id})

    if data.startswith("confirm_worker:"):
        wid = int(data.split(":")[1])

        # Double check if worker ID is already claimed by someone else
        claimed = get_worker_id_binding(DEFAULT_COMPANY_ID, wid)
        if claimed and claimed.get("tg_id") and str(claimed["tg_id"]) != str(tg_id):
            send_api("sendMessage", {
                "chat_id": chat_id,
                "text": (
                    f"⛔ <b>Xavfsizlik cheklovi:</b>\n\n"
                    f"<b>ID #{wid}</b> allaqachon boshqa Telegram akkauntiga biriktirilgan!\n"
                    f"Birovning hisobiga kirish taqiqlangan."
                ),
                "parse_mode": "HTML"
            })
            user_states.pop(tg_id, None)
            return

        st = user_states.get(tg_id, {})
        w_name = st.get("candidate_name")

        if not w_name:
            workers = fetch_json(f"companies/{DEFAULT_COMPANY_ID}/syncData/workers.json") or []
            w_obj = next((w for w in workers if isinstance(w, dict) and int(w.get('id', -1)) == wid), None)
            w_name = w_obj.get('name') if w_obj else f"Ishchi #{wid}"

        save_worker_binding(tg_id, wid, w_name, DEFAULT_COMPANY_ID, from_user.get("username", ""))
        user_states.pop(tg_id, None)

        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": (
                f"🎉 <b>Tabriklaymiz!</b> Siz muvaffaqiyatli biriktirildingiz.\n\n"
                f"👤 <b>Xodim:</b> {escape_html(w_name)}\n"
                f"🆔 <b>ID:</b> #{wid}\n\n"
                f"🔒 <i>Ushbu hisob Telegram profilingizga biriktirildi. Boshqa ishchilar raqamini kiritib ko'rish imkoni yo'q.</i>\n\n"
                f"Endi pastdagi menyu orqali faqat o'zingizning oyligingiz va ishlaringizni ko'rishingiz mumkin 👇"
            ),
            "parse_mode": "HTML",
            "reply_markup": build_main_reply_keyboard(DEFAULT_COMPANY_ID, wid, tg_id)
        })

    elif data == "cancel_worker":
        user_states[tg_id] = {"step": "WAITING_WORKER_ID"}
        send_api("sendMessage", {
            "chat_id": chat_id,
            "text": "Iltimos, o'zingizning to'g'ri Ishchi ID raqamingizni kiriting:"
        })

# ─────────────────────────────────────────────────────────────────────────────
# HTTP SERVER (Health & Standalone Worker Web App)
# ─────────────────────────────────────────────────────────────────────────────

class WorkerHttpHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        req_path = parsed.path

        if req_path in ('/webapp', '/webapp/', '/worker-app', '/worker-app/', '/worker', '/'):
            q = urllib.parse.parse_qs(parsed.query)
            wid = q.get('worker_id', [None])[0] or q.get('id', [None])[0]
            tg_id = q.get('tg_id', [None])[0]
            auth_token = q.get('auth_token', [None])[0]
            comp = q.get('comp', [DEFAULT_COMPANY_ID])[0]

            # Cryptographic token validation:
            # If an auth_token is provided, it MUST match the HMAC for the given parameters.
            # This completely blocks anyone from altering worker_id or tg_id in the URL.
            if auth_token:
                if not verify_worker_token(comp, wid, tg_id, auth_token):
                    self.send_response(403)
                    self.send_header('Content-type', 'text/html; charset=utf-8')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    err_html = """<!DOCTYPE html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Xavfsizlik Cheklovi</title></head>
                    <body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:50px 20px;background:#f8fafc;color:#0f172a;">
                    <div style="font-size:56px;margin-bottom:16px;">⛔</div>
                    <h2 style="color:#dc2626;margin-bottom:8px;">Xavfsizlik Cheklovi</h2>
                    <p style="font-size:15px;line-height:1.5;color:#334155;max-width:400px;margin:0 auto 12px;">Ruxsatsiz yoki o'zgartirilgan parametrlar bilan kirish taqiqlangan.</p>
                    <p style="font-size:13px;color:#64748b;">Iltimos, faqat o'zingizning rasmiy Telegram botingizdagi tugma orqali kiring.</p>
                    </body></html>"""
                    self.wfile.write(err_html.encode('utf-8'))
                    return
            html_candidates = [
                os.path.join(CURRENT_DIR, 'webapp', 'index.html'),
                os.path.join(CURRENT_DIR, 'webapp', 'worker.html'),
                os.path.join(CURRENT_DIR, 'index.html'),
            ]
            content = None
            for p in html_candidates:
                if os.path.exists(p):
                    try:
                        with open(p, 'rb') as f:
                            content = f.read()
                        break
                    except Exception:
                        pass

            if content:
                self.send_response(200)
                self.send_header('Content-type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(content)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(content)
                return

        if req_path == '/health':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'{"status": "ok", "service": "Novda Worker Bot"}')
            return

        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"Not found")

    def do_HEAD(self):
        self.do_GET()

    def log_message(self, format, *args):
        pass

def run_http_server():
    server = HTTPServer(('0.0.0.0', PORT), WorkerHttpHandler)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Worker Bot HTTP server: http://0.0.0.0:{PORT}")
    server.serve_forever()

# ─────────────────────────────────────────────────────────────────────────────
# POLLING LOOP
# ─────────────────────────────────────────────────────────────────────────────

def run_polling():
    global BOT_TOKEN
    if not BOT_TOKEN:
        print("\n=======================================================")
        print("⚠️  DIQQAT: Bot Token kiritilmagan!")
        print("worker-bot/config.json fayliga bot_token ni yozing yoki")
        print("WORKER_BOT_TOKEN muhit o'zgaruvchisini o'rnating.")
        print("=======================================================\n")
        return

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Ishchilar Telegram Boti ishga tushirildi (Polling)...")
    offset = 0
    while True:
        try:
            url = f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates?offset={offset}&timeout=25"
            req = urllib.request.Request(url, headers={'User-Agent': 'NovdaWorkerBot/1.0'})
            with urllib.request.urlopen(req, timeout=35) as resp:
                res = json.loads(resp.read().decode('utf-8'))
                if res.get("ok"):
                    for update in res.get("result", []):
                        offset = update["update_id"] + 1
                        if "message" in update:
                            msg = update["message"]
                            chat_id = msg.get("chat", {}).get("id")
                            user = msg.get("from", {})
                            text = msg.get("text", "").strip()
                            if text == "/start":
                                handle_start(chat_id, user)
                            elif text:
                                handle_text_input(chat_id, user, text)
                        elif "callback_query" in update:
                            handle_callback_query(update["callback_query"])
        except Exception as e:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [Polling Xatosi]: {e}")
            time.sleep(3)

if __name__ == "__main__":
    t_http = threading.Thread(target=run_http_server, daemon=True)
    t_http.start()
    run_polling()
