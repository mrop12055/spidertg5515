@echo off
title TelegramCRM - Unified Runner
echo ============================================
echo       TelegramCRM - UNIFIED RUNNER
echo ============================================
echo.
echo  Handles ALL task types in ONE process:
echo  - Live Chat (incoming + replies)
echo  - Campaign Messages
echo  - Account Management
echo  - Warmup Tasks
echo.
echo  NO session conflicts!
echo  Press Ctrl+C to stop
echo.
echo ============================================
echo.
python unified_runner.py
echo.
echo Runner stopped.
pause