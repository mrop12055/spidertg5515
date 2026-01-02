@echo off
title TelegramCRM - Run All Runners
echo ============================================
echo   TelegramCRM - Starting All Runners
echo ============================================
echo.
echo This will start all 4 runners in separate windows:
echo   - Campaign Runner (sends campaign messages)
echo   - Live Chat Listener (handles incoming messages)
echo   - Account Manager (handles account tasks like bio/name changes)
echo   - Warmup Runner (handles warmup tasks)
echo.
echo Press any key to start all runners...
pause >nul

echo.
echo Starting Campaign Runner...
start "TelegramCRM - Campaign" cmd /c "python campaign_runner.py & pause"

timeout /t 2 >nul

echo Starting Live Chat Listener...
start "TelegramCRM - LiveChat" cmd /c "python live_chat_listener.py & pause"

timeout /t 2 >nul

echo Starting Account Manager...
start "TelegramCRM - Account" cmd /c "python account_manager.py & pause"

timeout /t 2 >nul

echo Starting Warmup Runner...
start "TelegramCRM - Warmup" cmd /c "python warmup_runner.py & pause"

echo.
echo ============================================
echo   All runners started in separate windows!
echo ============================================
echo.
echo To stop all runners, run STOP_ALL.bat or close the windows.
echo.
pause
