@echo off
setlocal
cd /d "%~dp0"
echo.
echo  Frigate board:  http://localhost:8000/client/board.html
echo  Press Ctrl+C to stop.
echo.
php -S 0.0.0.0:8000 -t .