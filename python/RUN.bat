@echo off
echo ============================================
echo       TelegramCRM - Starting All Runners
echo ============================================
echo.
echo Starting Campaign Runner...
start "Campaign Runner" cmd /k python campaign_runner.py
echo Starting Live Chat Listener...
start "Live Chat Listener" cmd /k python live_chat_listener.py
echo Starting Account Manager...
start "Account Manager" cmd /k python account_manager.py
echo Starting Warmup Runner...
start "Warmup Runner" cmd /k python warmup_runner.py
echo.
echo ============================================
echo  All runners started in separate windows
echo  Close each window to stop individual runners
echo ============================================
pause
