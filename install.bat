@echo off
rem dsh-auto-workspace one-click installer (thin wrapper over install.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %errorlevel%
