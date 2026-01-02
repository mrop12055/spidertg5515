@echo off
echo ============================================
echo   Stopping All TelegramCRM Processes
echo ============================================
echo.

:: Close windows by title
taskkill /FI "WINDOWTITLE eq TelegramCRM - Campaign*" /F 2>nul
taskkill /FI "WINDOWTITLE eq TelegramCRM - LiveChat*" /F 2>nul
taskkill /FI "WINDOWTITLE eq TelegramCRM - Account*" /F 2>nul
taskkill /FI "WINDOWTITLE eq TelegramCRM - Warmup*" /F 2>nul
taskkill /FI "WINDOWTITLE eq TelegramCRM - All in One*" /F 2>nul

:: Kill Python processes running our scripts
for /f "tokens=2 delims=," %%a in ('tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH 2^>nul') do (
    wmic process where "ProcessId=%%~a" get CommandLine 2>nul | findstr /i "campaign_runner live_chat_listener account_manager warmup_runner main_runner" >nul && (
        echo Stopping Python process %%~a...
        taskkill /F /PID %%~a 2>nul
    )
)

echo.
echo All TelegramCRM processes stopped.
echo.
pause
