@echo off
cd /d "%~dp0"

start "" "http://localhost:8000/?mode=laptop"

python server.py