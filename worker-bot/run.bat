@echo off
chcp 65001 > nul
title Novda Ishchilar Telegram Boti
echo ========================================================
echo       NOVDA HISOB-KITOB — ISHCHILAR TELEGRAM BOTI
echo ========================================================
echo.

cd /d "%~dp0"

python worker_bot.py
pause
