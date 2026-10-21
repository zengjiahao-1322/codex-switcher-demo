@echo off
rem Codex API Switcher - double-click to install (Windows 10/11).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0platform\windows\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation failed. See the messages above.
  pause
)
