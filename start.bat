@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js or add it to PATH first.
  pause
  exit /b 1
)

title Local Port Manager
node server.js --open

if errorlevel 1 (
  echo.
  echo The service failed to start. Review the message above.
  pause
)
