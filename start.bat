@echo off
REM Serves the tracker locally and opens it. Nothing leaves this machine --
REM the server only listens on 127.0.0.1.
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on PATH. Install Python, or open this folder
  echo through any other local web server.
  echo.
  pause
  exit /b 1
)

echo.
echo   M-PESA Tracker is starting...
echo   Opening http://localhost:8777 in your browser.
echo.
echo   KEEP THIS WINDOW OPEN while you use the app.
echo   Closing it stops the app.
echo.

REM Open the browser from a detached shell that waits for the server to bind
REM first. Opening it before python starts listening yields "site can't be
REM reached" -- the browser wins the race every time.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8777"

REM serve.py rather than `python -m http.server`: it sends no-cache headers, so a
REM refresh always runs the current code instead of a stale cached module.
python serve.py 8777

REM If python exits immediately the port is usually already taken; keep the
REM window open so the error is readable rather than flashing past.
echo.
echo Server stopped. If that was unexpected, port 8777 may already be in use.
pause
