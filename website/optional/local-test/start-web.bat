@echo off
cd /d "%~dp0"
echo Starting Dividend Uploader...
echo.

py -3 run_local.py
if not errorlevel 1 goto :eof

echo.
echo Python launcher 'py -3' failed, trying 'python'...
python run_local.py
if not errorlevel 1 goto :eof

echo.
echo Failed to start Dividend Uploader.
echo Please make sure Python 3.9+ is installed. Node.js will be installed automatically when winget or choco is available.
echo.
pause
