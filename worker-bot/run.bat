@echo off
chcp 65001 > nul
title Novda Ishchilar Telegram Boti
echo ========================================================
echo       NOVDA HISOB-KITOB — ISHCHILAR TELEGRAM BOTI
echo ========================================================
echo.

cd /d "%~dp0"

if not exist config.json (
    echo [XATO] config.json fayli topilmadi!
    pause
    exit /b
)

python bot.py
pause
