@echo off
title TelegramCRM - Account Manager
echo ========================================
echo    TelegramCRM - Account Manager
echo ========================================
echo.
cd /d %~dp0
python account_manager.py
echo.
echo ========================================
echo    Runner stopped or crashed
echo ========================================
pause
