import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("worker_bot.py")
SPEC = importlib.util.spec_from_file_location("novda_worker_bot_test", MODULE_PATH)
worker_bot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker_bot)


class PinlessWorkerEnrollmentTests(unittest.TestCase):
    def setUp(self):
        worker_bot.USER_STATES.clear()

    def tearDown(self):
        worker_bot.USER_STATES.clear()

    def test_pin_disabled_enrollment_binds_after_worker_id_check(self):
        state = {"step": "WAITING_WORKER_ID", "company_id": "comp_novda"}
        user = {"id": 123456789, "username": "worker190"}
        binding = {"company_id": "comp_novda", "worker_id": 190, "worker_name": "Worker 190"}

        with (
            patch.object(worker_bot, "get_worker_id_binding", return_value=None),
            patch.object(worker_bot, "get_worker_enrollment", return_value={
                "worker_id": 190,
                "worker_name": "Worker 190",
                "pin_required": False,
            }),
            patch.object(worker_bot, "save_worker_binding", return_value=binding) as save_binding,
            patch.object(worker_bot, "main_keyboard", return_value={"keyboard": []}),
            patch.object(worker_bot, "send_message") as send_message,
            patch.object(worker_bot, "send_profile") as send_profile,
        ):
            worker_bot.start_worker_id_check(1, user, "123456789", state, "190")

        self.assertEqual(worker_bot.USER_STATES["123456789"], {"step": "BOUND", "binding": binding})
        save_binding.assert_called_once_with("123456789", 190, "comp_novda", "worker190", None)
        send_message.assert_called_once()
        send_profile.assert_called_once_with(1, "123456789", binding)

    def test_pin_required_enrollment_still_prompts_for_pin(self):
        state = {"step": "WAITING_WORKER_ID", "company_id": "comp_novda"}
        user = {"id": 123456789}

        with (
            patch.object(worker_bot, "get_worker_id_binding", return_value=None),
            patch.object(worker_bot, "get_worker_enrollment", return_value={
                "worker_id": 190,
                "worker_name": "Worker 190",
                "pin_required": True,
            }),
            patch.object(worker_bot, "save_worker_binding") as save_binding,
            patch.object(worker_bot, "send_message") as send_message,
        ):
            worker_bot.start_worker_id_check(1, user, "123456789", state, "190")

        self.assertEqual(state["step"], "WAITING_PIN")
        self.assertTrue(any("PIN" in call.args[1] for call in send_message.call_args_list))
        save_binding.assert_not_called()


if __name__ == "__main__":
    unittest.main()
