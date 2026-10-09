@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Engine Studio needs Node.js on this computer.
  echo Ask whoever set this PC up to finish the install.
  pause
  exit /b 1
)
start "Engine Studio" /min node launcher.js
