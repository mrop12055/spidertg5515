@echo off
REM ====================================================
REM  TelegramCRM - LIVE DEV MODE
REM  Double-click to launch the app with hot reload.
REM  Edit files -> app updates instantly, no rebuild.
REM  Press Ctrl+C in this window to stop.
REM ====================================================

cd /d "%~dp0"

echo.
echo [1/2] Ensuring dependencies are installed...
if not exist node_modules (
  call npm install
  if errorlevel 1 goto :err
)

echo.
echo [2/2] Starting Vite + Electron (live reload)...
call npm run electron:dev
if errorlevel 1 goto :err
exit /b 0

:err
echo.
echo ====================================================
echo  DEV MODE FAILED - see error above.
echo ====================================================
pause
exit /b 1
