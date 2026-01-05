@echo off
title TelegramCRM - All Runners
color 0A

echo.
echo  ================================================
echo       TelegramCRM - Starting All Runners
echo  ================================================
echo.

cd /d "%~dp0"

echo  [1/2] Installing requirements...
py -m pip install telethon httpx pysocks --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks --quiet 2>nul
)
echo        Done!
echo.

echo  [2/2] Starting 6 runners in parallel...
echo.

:: Start each runner in a new window
start "Campaign Runner" cmd /k "title Campaign Runner && color 0B && py campaign_runner.py"
timeout /t 1 /nobreak >nul

start "LiveChat Receiver" cmd /k "title LiveChat Receiver && color 0D && py live_chat_receiver.py"
timeout /t 1 /nobreak >nul

start "LiveChat Sender" cmd /k "title LiveChat Sender && color 05 && py live_chat_sender.py"
timeout /t 1 /nobreak >nul

start "Account Runner" cmd /k "title Account Runner && color 0E && py account_runner.py"
timeout /t 1 /nobreak >nul

start "Warmup Runner" cmd /k "title Warmup Runner && color 0A && py warmup_runner.py"
timeout /t 1 /nobreak >nul

start "Block Runner" cmd /k "title Block Runner && color 0C && py block_runner.py"

echo.
echo  ================================================
echo     All 6 runners started!
echo  ================================================
echo.
echo     Blue    = Campaign Runner
echo     Purple  = LiveChat Receiver (incoming)
echo     Magenta = LiveChat Sender (outgoing)
echo     Yellow  = Account Runner
echo     Green   = Warmup Runner
echo     Red     = Block Runner
echo.
echo     To STOP: Close all windows or press Ctrl+C
echo  ================================================
echo.
pause
