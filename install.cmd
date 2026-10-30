@echo off
rem feishu-bridge one-click installer (double-click friendly)
rem Always runs the PowerShell script with a relaxed execution policy,
rem regardless of the machine's default policy.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Install did not finish. Scroll up for the reason, fix it, then run this again.
  pause
)
