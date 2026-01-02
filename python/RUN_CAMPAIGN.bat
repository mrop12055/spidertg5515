@echo off
title TelegramCRM - Campaign Runner
echo ========================================
echo    TelegramCRM - Campaign Runner
echo ========================================
echo.
cd /d %~dp0
python campaign_runner.py
echo.
echo ========================================
echo    Runner stopped or crashed
echo ========================================
pause
