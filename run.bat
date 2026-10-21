@echo off
setlocal EnableExtensions
title Daejeon Tram Route Lab

rem Always switch to the directory containing this BAT file, even when launched
rem from a shortcut, another drive, or C:\Windows\System32.
cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot enter project directory:
  echo "%~dp0"
  pause
  exit /b 1
)

echo [INFO] Current directory: %CD%
echo [INFO] Looking for server.js here...

if not exist "%~dp0server.js" (
  echo.
  echo [ERROR] server.js is not in the same folder as this run.bat.
  echo You may have opened a shortcut or copied only run.bat.
  echo Extract the complete ZIP and run this file:
  echo "%~dp0run.bat"
  echo.
  echo Files in this folder:
  dir /b
  pause
  exit /b 2
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not on PATH.
  echo Reinstall Node.js LTS and enable "Add to PATH".
  pause
  exit /b 3
)

rem Reuse the familiar port first; if an older version is still open, try backups.
set "PORT="
for %%P in (3024 3025 3030 3031) do (
  netstat -ano | findstr /R /C:":%%P .*LISTENING" >nul
  if errorlevel 1 (
    set "PORT=%%P"
    goto PORT_READY
  )
)
:PORT_READY
if not defined PORT (
  echo [ERROR] Ports 3024, 3025, 3030 and 3031 are all busy.
  echo Close another copy of the app and try again.
  pause
  exit /b 4
)
echo.
echo [INFO] Starting server from:
echo "%~dp0server.js"
echo [INFO] Open http://localhost:%PORT% after startup.
echo [INFO] Keep this window open while using the app.
echo.
node "%~dp0server.js"
set "SERVER_EXIT=%ERRORLEVEL%"
echo.
if not "%SERVER_EXIT%"=="0" (
  echo [ERROR] Server exited with code %SERVER_EXIT%.
)
pause
exit /b %SERVER_EXIT%
