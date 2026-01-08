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
py -m pip install telethon httpx pysocks aiohttp --quiet 2>nul
if errorlevel 1 (
    python -m pip install telethon httpx pysocks aiohttp --quiet 2>nul
)
echo        Done!
echo.

echo  [2/2] Starting 4 runners in parallel...
echo.

:: Start each runner in a new window
start "Campaign Runner" cmd /k "title Campaign Runner && color 0B && py campaign_runner.py"
timeout /t 1 /nobreak >nul

start "LiveChat Listener" cmd /k "title LiveChat Listener && color 0D && py live_chat_listener.py"
timeout /t 1 /nobreak >nul

start "Account Manager" cmd /k "title Account Manager && color 0E && py account_manager.py"
timeout /t 1 /nobreak >nul

start "Warmup Runner" cmd /k "title Warmup Runner && color 0A && py warmup_runner.py"

echo.
echo  ================================================
echo     All 4 runners started!
echo  ================================================
echo.
echo     Blue   = Campaign Runner
echo     Purple = LiveChat Listener  
echo     Yellow = Account Manager
echo     Green  = Warmup Runner
echo.
echo     To STOP: Close all windows or press Ctrl+C
echo  ================================================
echo.
pause
