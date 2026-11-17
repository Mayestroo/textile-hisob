"""Tests for Admin Bot Daily Production Report broadcast and commands."""

import html
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import admin_bot


TASHKENT_TZ = timezone(timedelta(hours=5))


@pytest.fixture(autouse=True)
def reset_daily_report_state():
    admin_bot.LAST_DAILY_REPORT_DATE = None
    admin_bot.BOT_TOKEN = "test_token"
    admin_bot.ADMIN_API_TOKEN = "test_api_token"
    yield
    admin_bot.LAST_DAILY_REPORT_DATE = None


def test_format_number():
    assert admin_bot.format_number(None) == "0"
    assert admin_bot.format_number(0) == "0"
    assert admin_bot.format_number(1250) == "1 250"
    assert admin_bot.format_number(1250.0) == "1 250"
    assert admin_bot.format_number(1250.5) == "1 250.50"
    assert admin_bot.format_number("abc") == "abc"


def test_format_daily_report_message_full():
    report = {
        "companyId": "comp_novda",
        "companyName": "Novda Textile",
        "date": "2026-11-10",
        "cutProduction": {
            "totalQty": 1250,
            "totalTickets": 25,
            "byModel": [
                {"modelId": "m1", "modelName": "DZ-008-1", "qty": 800, "ticketCount": 16, "partyCount": 3},
                {"modelId": "m2", "modelName": "Брайс-Турси", "qty": 450, "ticketCount": 9, "partyCount": 2},
            ],
        },
        "enteredProduction": {
            "totalQty": 980,
            "totalEntries": 48,
            "byModel": [
                {"modelId": "m1", "modelName": "DZ-008-1", "qty": 650, "entryCount": 32},
                {"modelId": "m2", "modelName": "Брайс-Турси", "qty": 330, "entryCount": 16},
            ],
        },
    }

    message = admin_bot.format_daily_report_message(report)

    assert "📊 <b>Kunlik ishlab chiqarish hisoboti</b>" in message
    assert "📅 <b>Sana:</b> 10.11.2026 (16:30)" in message
    assert "🏢 <b>Kompaniya:</b> Novda Textile" in message
    assert "✂️ <b>BICHILGAN SON:</b> 1 250 dona (25 ta patta)" in message
    assert "(Bugun chiqarilgan pattalardagi umumiy ish soni)" in message
    assert "DZ-008-1: <b>800</b> dona (3 ta partiya, 16 ta patta)" in message
    assert "Брайс-Турси: <b>450</b> dona (2 ta partiya, 9 ta patta)" in message
    assert "📥 <b>KIRITILGAN UMUMIY ISH SONI:</b> 980 dona" in message
    assert "DZ-008-1: <b>650</b> dona" in message
    assert "Брайс-Турси: <b>330</b> dona" in message
    assert 'ta operatsiya' not in message


def test_entered_pieces_are_not_multiplied_by_operation_count():
    report = {"companyName": "Novda", "enteredProduction": {
        "totalQty": 796, "totalEntries": 25, "byModel": [
            {"modelName": "DZ_Cayshab-349-Model", "qty": 684, "entryCount": 10},
            {"modelName": "DZ-008-1", "qty": 112, "entryCount": 15}
        ]}}
    message = admin_bot.format_daily_report_message(report, '2026-11-16')
    assert 'KIRITILGAN UMUMIY ISH SONI:</b> 796 dona' in message
    assert 'DZ_Cayshab-349-Model: <b>684</b> dona' in message
    assert 'DZ-008-1: <b>112</b> dona' in message
    assert 'ta operatsiya' not in message
    assert '8 520' not in message


def test_format_daily_report_message_empty():
    report = {
        "companyId": "comp_novda",
        "companyName": "Novda Textile",
        "date": "2026-11-10",
        "cutProduction": {"totalQty": 0, "totalTickets": 0, "byModel": []},
        "enteredProduction": {"totalQty": 0, "totalEntries": 0, "byModel": []},
    }

    message = admin_bot.format_daily_report_message(report)
    assert "✂️ <b>BICHILGAN SON:</b> 0 dona" in message
    assert "<i>(Bugun bichilgan modellar yo'q)</i>" in message
    assert "📥 <b>KIRITILGAN UMUMIY ISH SONI:</b> 0 dona" in message
    assert "<i>(Ochiq davrda shu sanada kiritilgan ishlar yo'q)</i>" in message


def test_format_daily_report_message_html_escape():
    report = {
        "companyId": "comp_test",
        "companyName": "Novda <Textile> & Co",
        "date": "2026-11-10",
        "cutProduction": {
            "totalQty": 100,
            "totalTickets": 1,
            "byModel": [{"modelName": "Model <Special> & Test", "qty": 100, "ticketCount": 1}],
        },
        "enteredProduction": {"totalQty": 0, "totalEntries": 0, "byModel": []},
    }

    message = admin_bot.format_daily_report_message(report)
    assert "Novda &lt;Textile&gt; &amp; Co" in message
    assert "Model &lt;Special&gt; &amp; Test" in message
    assert "<Special>" not in message


@patch("admin_bot.send_daily_production_reports")
def test_check_and_send_daily_reports_trigger_logic(mock_send):
    mock_send.return_value = 2

    # Case 1: 16:29:59 (before 16:30) -> Should NOT send
    dt_before = datetime(2026, 11, 10, 16, 29, 59, tzinfo=TASHKENT_TZ)
    assert admin_bot.check_and_send_daily_reports(now=dt_before) == 0
    assert mock_send.call_count == 0
    assert admin_bot.LAST_DAILY_REPORT_DATE is None

    # Case 2: 16:30 -> Should send once
    dt_report = datetime(2026, 11, 10, 16, 30, 0, tzinfo=TASHKENT_TZ)
    assert admin_bot.check_and_send_daily_reports(now=dt_report) == 2
    assert mock_send.call_count == 1
    mock_send.assert_called_with(target_date="2026-11-10")
    assert admin_bot.LAST_DAILY_REPORT_DATE == "2026-11-10"

    # Case 3: 18:05 same day -> Should NOT send again
    dt_18_05 = datetime(2026, 11, 10, 18, 5, 0, tzinfo=TASHKENT_TZ)
    assert admin_bot.check_and_send_daily_reports(now=dt_18_05) == 0
    assert mock_send.call_count == 1

    # Case 4: 16:30 next day -> Should send for new date
    dt_next_report = datetime(2026, 11, 11, 16, 30, 0, tzinfo=TASHKENT_TZ)
    assert admin_bot.check_and_send_daily_reports(now=dt_next_report) == 2
    assert mock_send.call_count == 2
    mock_send.assert_called_with(target_date="2026-11-11")
    assert admin_bot.LAST_DAILY_REPORT_DATE == "2026-11-11"


@patch("admin_bot.send_message")
@patch("admin_bot.api_request")
def test_send_daily_production_reports_delivery(mock_api, mock_send):
    mock_api.return_value = {
        "reports": [
            {
                "companyId": "comp_novda",
                "companyName": "Novda",
                "adminTelegramIds": ["274466315"],
                "cutProduction": {"totalQty": 500, "totalTickets": 10, "byModel": []},
                "enteredProduction": {"totalQty": 300, "totalEntries": 15, "byModel": []},
            }
        ]
    }

    # Only explicitly assigned company admins receive the company report.
    sent = admin_bot.send_daily_production_reports(target_date="2026-11-10")
    assert sent == 1
    assert mock_send.call_count == 1
    recipients = {call.args[0] for call in mock_send.call_args_list}
    assert recipients == {"274466315"}


@patch("admin_bot.api_request")
def test_handle_admin_command_hisobot(mock_api):
    mock_api.return_value = {
        "reports": [
            {
                "companyId": "comp_novda",
                "companyName": "Novda",
                "date": "2026-11-10",
                "cutProduction": {"totalQty": 100, "totalTickets": 2, "byModel": []},
                "enteredProduction": {"totalQty": 50, "totalEntries": 5, "byModel": []},
            }
        ]
    }

    access = {"companyIds": ["comp_novda"]}
    response = admin_bot.handle_admin_command("274466315", "/hisobot", access=access)
    assert response is not None
    assert "Kunlik ishlab chiqarish hisoboti" in response
    assert "BICHILGAN SON:</b> 100 dona" in response

    # Also test /bugun
    response_bugun = admin_bot.handle_admin_command("274466315", "/bugun", access=access)
    assert response_bugun is not None
    assert "Kunlik ishlab chiqarish hisoboti" in response_bugun
