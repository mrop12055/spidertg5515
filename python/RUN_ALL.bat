@echo off
title TelegramCRM - All Runners
echo ============================================
echo   TelegramCRM - Starting All Runners
echo ============================================
echo.
cd /d %~dp0

echo Starting Campaign Runner...
start "TelegramCRM - Campaign" cmd /k "cd /d %~dp0 && python campaign_runner.py"
timeout /t 2 >nul

echo Starting Live Chat Listener...
start "TelegramCRM - LiveChat" cmd /k "cd /d %~dp0 && python live_chat_listener.py"
timeout /t 2 >nul

echo Starting Account Manager...
start "TelegramCRM - Account" cmd /k "cd /d %~dp0 && python account_manager.py"
timeout /t 2 >nul

echo Starting Warmup Runner...
start "TelegramCRM - Warmup" cmd /k "cd /d %~dp0 && python warmup_runner.py"

echo.
echo ============================================
echo   All 4 runners started in separate windows!
echo ============================================
echo.
echo To stop all: run STOP_ALL.bat
pause
