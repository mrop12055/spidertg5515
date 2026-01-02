@echo off
title TelegramCRM - Warmup Runner
echo ========================================
echo    TelegramCRM - Warmup Runner
echo ========================================
echo.
cd /d %~dp0
python warmup_runner.py
echo.
echo ========================================
echo    Runner stopped or crashed
echo ========================================
pause
