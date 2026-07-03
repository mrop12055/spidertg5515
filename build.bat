@echo off
REM ====================================================
REM  TelegramCRM - build the Windows desktop app (.exe)
REM  Double-click this file on Windows to build.
REM ====================================================

cd /d "%~dp0"

echo.
echo [1/3] Installing dependencies (first run only)...
call npm install
if errorlevel 1 goto :err

echo.
echo [2/3] Cleaning old build...
call npm run electron:clean

echo.
echo [3/3] Building app (vite + electron-packager)...
call npm run electron:pack
if errorlevel 1 goto :err

echo.
echo ====================================================
echo  BUILD OK
echo  App is at:
type electron-release-latest.txt
echo  Double-click TelegramCRM.exe to launch.
echo ====================================================
pause
exit /b 0

:err
echo.
echo ====================================================
echo  BUILD FAILED - see error above.
echo ====================================================
pause
exit /b 1
