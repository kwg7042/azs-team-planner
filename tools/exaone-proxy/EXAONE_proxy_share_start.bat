@echo off
rem AZS team planner - EXAONE local proxy launcher (team share: other PCs use this PC)
cd /d "%~dp0"
set PYTHONUTF8=1
where py >nul 2>nul
if not errorlevel 1 (
  py -3 exaone_proxy.py --share %*
  goto done
)
where python >nul 2>nul
if not errorlevel 1 (
  python exaone_proxy.py --share %*
  goto done
)
echo [ERROR] Python 3 is not installed. Install it from https://www.python.org/downloads/ and run this file again.
:done
pause
