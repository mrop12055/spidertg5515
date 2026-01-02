@echo off
title TelegramCRM - Run All Runners
echo ============================================
echo   TelegramCRM - Starting All Runners
echo ============================================
echo.
echo This will start all 4 runners in separate windows:
echo   - Campaign Runner
echo   - Live Chat Listener  
echo   - Account Manager
echo   - Warmup Runner
echo.
echo Press any key to start...
pause >nul

echo.
echo Starting Campaign Runner...
start "TelegramCRM - Campaign" cmd /k "cd /d %~dp0 && python campaign_runner.py"

timeout /t 3 >nul

echo Starting Live Chat Listener...
start "TelegramCRM - LiveChat" cmd /k "cd /d %~dp0 && python live_chat_listener.py"

timeout /t 3 >nul

echo Starting Account Manager...
start "TelegramCRM - Account" cmd /k "cd /d %~dp0 && python account_manager.py"

timeout /t 3 >nul

echo Starting Warmup Runner...
start "TelegramCRM - Warmup" cmd /k "cd /d %~dp0 && python warmup_runner.py"

echo.
echo ============================================
echo   All runners started!
echo ============================================
echo.
echo Windows will stay open to show any errors.
echo To stop: run STOP_ALL.bat or close windows.
echo.
pause
