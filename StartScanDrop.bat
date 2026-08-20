@echo off
cd /d "%~dp0"

echo Starting ScanDrop...
echo.

if not exist "cert.pem" (
  echo First run: creating a local https certificate so the phone camera works.
  python make_cert.py
  echo.
)

start "" "http://localhost:8000/?mode=laptop"

python server.py
pause
