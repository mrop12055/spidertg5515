@echo off
title TelegramCRM - Live Chat
echo ========================================
echo    TelegramCRM - Live Chat Listener
echo ========================================
echo.
cd /d %~dp0
python live_chat_listener.py
echo.
echo ========================================
echo    Runner stopped or crashed
echo ========================================
pause
