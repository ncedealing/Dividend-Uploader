@echo off
cd /d "%~dp0"
echo Dividend Uploader runtime check
echo.

echo Python:
py -3 --version
if errorlevel 1 python --version

echo.
echo Node.js:
node --version
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node.js 24+ from https://nodejs.org/
)

echo.
echo Done.
pause
