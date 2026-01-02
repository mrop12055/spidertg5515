@echo off
echo ============================================
echo   Stopping All TelegramCRM Processes
echo ============================================
echo.

:: Kill all Python processes running our scripts
taskkill /F /IM python.exe /FI "WINDOWTITLE eq *TelegramCRM*" 2>nul
taskkill /F /IM python.exe /FI "WINDOWTITLE eq *Live Chat*" 2>nul
taskkill /F /IM python.exe /FI "WINDOWTITLE eq *Campaign*" 2>nul
taskkill /F /IM python.exe /FI "WINDOWTITLE eq *Account*" 2>nul

:: Alternative method - kill by script name pattern
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq python.exe" /FO LIST ^| find "PID:"') do (
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | findstr /i "live_chat_listener campaign_runner account_manager main_runner" >nul && (
        echo Stopping process %%a...
        taskkill /F /PID %%a 2>nul
    )
)

echo.
echo All TelegramCRM processes stopped.
echo.
pause
