@echo off
rem AZS team planner - remove EXAONE proxy auto start and stop the background proxy
cd /d "%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP%\AZS_EXAONE_proxy.bat" del "%STARTUP%\AZS_EXAONE_proxy.bat"
set "PYC="
where py >nul 2>nul
if not errorlevel 1 set "PYC=py -3"
if not defined PYC (
  where python >nul 2>nul
  if not errorlevel 1 set "PYC=python"
)
if defined PYC %PYC% "%~dp0exaone_proxy.py" --stop
echo.
echo [OK] Auto start removed. The background proxy is stopped.
echo      To use EXAONE again, run EXAONE_proxy_share_start.bat (or EXAONE_autostart_install.bat).
pause
