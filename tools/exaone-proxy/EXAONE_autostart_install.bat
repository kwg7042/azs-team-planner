@echo off
rem AZS team planner - start the EXAONE team-share proxy automatically at Windows login (no window)
cd /d "%~dp0"
if not exist "%~dp0exaone_proxy.py" (
  echo [ERROR] exaone_proxy.py must be in the same folder as this file.
  pause
  exit /b 1
)
if not exist "%~dp0exaone_proxy_config.json" (
  echo [!] Your API key is not saved yet.
  echo     Run EXAONE_proxy_share_start.bat once, check "EXAONE OK", close it, then run this file again.
  pause
  exit /b 1
)
set "PYW="
set "PYC="
where pyw >nul 2>nul
if not errorlevel 1 set "PYW=pyw -3"
where py >nul 2>nul
if not errorlevel 1 set "PYC=py -3"
if not defined PYW (
  where pythonw >nul 2>nul
  if not errorlevel 1 set "PYW=pythonw"
)
if not defined PYC (
  where python >nul 2>nul
  if not errorlevel 1 set "PYC=python"
)
if not defined PYW (
  echo [ERROR] Python 3 is not installed. Install it from https://www.python.org/downloads/
  pause
  exit /b 1
)
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\AZS_EXAONE_proxy.bat" (
  echo @echo off
  echo cd /d "%~dp0"
  echo start "" %PYW% "%~dp0exaone_proxy.py" --share --background
)
rem stop a copy that is already running, then start the background one now
if defined PYC %PYC% "%~dp0exaone_proxy.py" --stop >nul 2>nul
timeout /t 2 /nobreak >nul
start "" %PYW% "%~dp0exaone_proxy.py" --share --background
echo.
echo [OK] The EXAONE team-share proxy now starts automatically every time you log in to Windows.
echo      It runs in the background (no window) and is running now.
echo      Log file : %~dp0exaone_proxy.log
echo      Remove   : run EXAONE_autostart_uninstall.bat
echo.
echo  If an old proxy window is still open, close it (both use port 8787).
pause
