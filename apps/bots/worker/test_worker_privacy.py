"""Offline update/transport regressions; never configure the bot or open a socket."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("worker_privacy_test", Path(__file__).with_name("worker_bot.py"))
bot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bot)
USER = {"id": 123456789, "username": "fixture"}
BINDING = {"telegram_id": "123456789", "company_id": "company-a", "worker_id": 27,
           "worker_name": "Fixture <Worker>", "username": "fixture"}
PROFILE = {"worker_name": "Fixture <Worker>", "worker_id": 27, "period_name": "Fixture period",
           "gross": 12345, "avans": 100, "jarima": 50, "net": 12195, "pieces": 3,
           "models_breakdown": {"model": {"name": "Fixture model", "earnings": 12345,
               "operations": [{"name": "Sew", "qty": 3, "rate": 4115, "amount": 12345}]}}}


def update(text, chat_type="private", chat_id=123456789, user=None):
    return {"message": {"chat": {"id": chat_id, "type": chat_type}, "from": USER if user is None else user,
                        "text": text, "message_id": 8}}


class WorkerPrivacyTests(unittest.TestCase):
    def setUp(self):
        bot.USER_STATES.clear()
        self.addCleanup(bot.USER_STATES.clear)
        # Catch accidental use of either HTTP transport, even in failure paths.
        self.net = patch.object(bot.urllib.request, "urlopen", side_effect=AssertionError("Network forbidden")).start()
        self.addCleanup(patch.stopall)
        patch.object(bot, "WORKER_WEBAPP_URL", "https://example.invalid/worker-app").start()
        patch.object(bot, "WORKER_AUTH_HMAC_SECRET", "fixture-only-hmac").start()
        self.telegram = patch.object(bot, "telegram_api", return_value={"ok": True}).start()
        self.binding = BINDING
        self.api = patch.object(bot, "api_request", side_effect=self.api_response).start()

    def api_response(self, method, route, payload=None, query=None):
        if route.startswith("/api/worker/bindings/by-telegram/"):
            return {"success": True, "binding": self.binding}
        if route == "/api/worker/profile":
            return {"success": True, "profile": PROFILE}
        if route == "/api/worker/tickets":
            return {"success": True, "tickets": [{"model_id": "Fixture model", "patta_number": 2,
                "party_number": 4, "size": "M", "qty": 3, "my_operations": "Sew"}]}
        if method == "POST" and route == "/api/worker/bindings":
            return {"success": True, "binding": BINDING}
        raise AssertionError(f"Unexpected API call: {method} {route}")

    def test_nonprivate_updates_neither_read_data_nor_change_registration_state(self):
        states = [{}, {"step": "BOUND", "binding": BINDING},
                  {"step": "WAITING_COMPANY_ID"},
                  {"step": "WAITING_WORKER_ID", "company_id": "company-a"},
                  {"step": "WAITING_PIN", "company_id": "company-a", "worker_id": 27}]
        commands = ["/start", "/hisob", "/refresh", "/operatsiyalar", "/pattalar", "/help", "27", "1234"]
        for chat_type in ("group", "supergroup", "channel", None):
            for state in states:
                for command in commands:
                    with self.subTest(chat_type=chat_type, state=state.get("step"), command=command):
                        self.api.reset_mock()
                        self.telegram.reset_mock()
                        self.binding = BINDING if state.get("step") == "BOUND" else None
                        bot.USER_STATES.clear()
                        if state:
                            bot.USER_STATES[str(USER["id"])] = copy.deepcopy(state)
                        before = copy.deepcopy(bot.USER_STATES)
                        bot.process_update(update(command, chat_type, -100123))
                        self.assertEqual(bot.USER_STATES, before)
                        self.api.assert_not_called()
                        self.telegram.assert_not_called()

    def test_group_cannot_receive_bound_workers_finances_or_webapp_credentials(self):
        bot.USER_STATES[str(USER["id"])] = {"step": "BOUND", "binding": BINDING}
        bot.process_update(update("/hisob", "group", -100123))
        messages = [call.args[1] for call in self.telegram.call_args_list]
        self.assertEqual(messages, [], "A group must receive neither the financial profile nor its signed WebApp keyboard")
        self.api.assert_not_called()

    def test_removed_binding_cannot_reuse_cached_worker_name_or_signed_keyboard(self):
        bot.USER_STATES[str(USER["id"])] = {"step": "BOUND", "binding": BINDING}
        self.binding = None
        bot.process_update(update("/help"))
        messages = [call.args[1] for call in self.telegram.call_args_list]
        self.assertFalse(any("Fixture &lt;Worker&gt;" in message["text"] for message in messages))
        self.assertFalse(any("authToken" in json.dumps(message) for message in messages))
        self.assertEqual(bot.USER_STATES[str(USER["id"])]["step"], "WAITING_COMPANY_ID")

    def test_private_identity_must_match_destination(self):
        for user in ({}, {"id": 999}, {"id": USER["id"], "is_bot": True}):
            with self.subTest(user=user):
                self.api.reset_mock()
                self.telegram.reset_mock()
                bot.process_update(update("/hisob", user=user))
                self.api.assert_not_called()
                self.telegram.assert_not_called()
        self.api.reset_mock()
        bot.process_update({"callback_query": {"from": USER, "data": "/hisob"}})
        self.api.assert_not_called()

    def test_private_type_is_required_even_if_chat_and_sender_ids_match(self):
        for chat_type in ("group", "supergroup", "channel", None):
            with self.subTest(chat_type=chat_type):
                bot.process_update(update("/hisob", chat_type))
                self.api.assert_not_called()
                self.telegram.assert_not_called()

    def test_private_bound_commands_render_profile_operations_tickets_and_signed_keyboard(self):
        for command, expected in (("/start", "hisob"), ("/hisob", "12 195"),
                                  ("/refresh", "hisob"), ("/operatsiyalar", "Sew"),
                                  ("/pattalar", "Patta #2"), ("/help", "hisob")):
            with self.subTest(command=command):
                self.telegram.reset_mock()
                bot.process_update(update(command))
                messages = [call.args[1] for call in self.telegram.call_args_list]
                self.assertTrue(any(expected in message["text"] for message in messages))
                for message in messages:
                    self.assertEqual(message["chat_id"], USER["id"])
                    url = message["reply_markup"]["keyboard"][0][0]["web_app"]["url"]
                    self.assertIn("authToken=", url)
                    self.assertIn("telegramId=123456789", url)
        self.assertEqual(bot.USER_STATES[str(USER["id"])]["step"], "BOUND")

    def test_incomplete_unknown_vs_known_zero_and_legacy_profile_render_offline(self):
        for rate, status, expected in ((None, 'INCOMPLETE', 'Hisob to‘liq emas'),
                                       (0, 'COMPLETE', '0 so\'m'),
                                       (5, 'COMPLETE', '5 so\'m')):
            with self.subTest(rate=rate, status=status):
                profile = copy.deepcopy(PROFILE)
                profile.update(accountingStatus=status, unknownEntryCount=int(rate is None))
                profile['models_breakdown']['model']['operations'][0].update(rate=rate, amount=None if rate is None else rate)
                with patch.object(bot, 'get_worker_profile_and_stats', return_value=profile):
                    self.telegram.reset_mock()
                    bot.send_profile(USER['id'], str(USER['id']), BINDING)
                    bot.send_operations(USER['id'], str(USER['id']), BINDING)
                texts = [call.args[1]['text'] for call in self.telegram.call_args_list]
                self.assertIn(expected, texts[1] if rate is not None else '\n'.join(texts))
                self.assertEqual('Hisob to‘liq emas' in '\n'.join(texts), rate is None)
                if rate is None:
                    self.assertIn('narx noma’lum', texts[1])
                    self.assertNotIn('0 so\'m =', texts[1])
        with patch.object(bot, 'get_worker_profile_and_stats', return_value=PROFILE):
            self.telegram.reset_mock()
            bot.send_profile(USER['id'], str(USER['id']), BINDING)
        self.assertIn('Hisob to‘liq emas', self.telegram.call_args.args[1]['text'])

    def test_private_registration_and_pin_submission_still_work(self):
        with patch.object(bot, "get_worker_binding", return_value=None), patch.object(bot, "DEFAULT_COMPANY_ID", ""):
            bot.process_update(update("/start"))
            self.assertEqual(bot.USER_STATES[str(USER["id"])]["step"], "WAITING_COMPANY_ID")
            bot.process_update(update("company-a"))
            self.assertEqual(bot.USER_STATES[str(USER["id"])]["step"], "WAITING_WORKER_ID")
            with patch.object(bot, "get_worker_id_binding", return_value=None), patch.object(bot, "get_worker_enrollment", return_value={
                "worker_name": BINDING["worker_name"], "pin_required": True, "pin_configured": True
            }):
                bot.process_update(update("27"))
            self.assertEqual(bot.USER_STATES[str(USER["id"])]["step"], "WAITING_PIN")
            bot.process_update(update("1234"))
        self.assertEqual(bot.USER_STATES[str(USER["id"])]["step"], "BOUND")
        self.telegram.assert_any_call("deleteMessage", {"chat_id": USER["id"], "message_id": 8})
        self.api.assert_any_call("POST", "/api/worker/bindings", {
            "telegramId": str(USER["id"]), "workerId": 27, "companyId": "company-a", "username": "fixture", "pin": "1234"})


def consume_binding_contract():
    """Consume actual Fastify POST responses supplied by the JS regression test."""
    responses = json.load(sys.stdin)
    for response in responses:
        bot.USER_STATES.clear()
        with patch.object(bot.urllib.request, "urlopen", side_effect=AssertionError("Network forbidden")), \
             patch.object(bot, "WORKER_WEBAPP_URL", ""), \
             patch.object(bot, "api_request", side_effect=[response, {"success": True, "profile": PROFILE}]), \
             patch.object(bot, "telegram_api", return_value={"ok": True}) as telegram:
            bot.finish_registration(USER["id"], USER, str(USER["id"]), {"company_id": "company-a", "worker_id": 27})
            assert bot.USER_STATES[str(USER["id"])]["step"] == "BOUND"
            assert len(telegram.call_args_list) == 2
            assert "Fixture &lt;Worker&gt;" in telegram.call_args_list[0].args[1]["text"]
            assert "12 195" in telegram.call_args_list[1].args[1]["text"]
    print("fresh and retry DTOs consumed by finish_registration")


if __name__ == "__main__":
    if sys.argv[1:] == ["--binding-contract"]:
        consume_binding_contract()
    else:
        unittest.main()
