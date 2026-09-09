@echo off
setlocal
cd /d "%~dp0"
title Life Steward

set "APP_URL=http://127.0.0.1:4000/"
set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

rem If the local service is already running, only open the browser.
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%APP_URL%api/state'; if ($r.StatusCode -eq 200) { exit 0 } } catch { }; exit 1" >nul 2>nul
if not errorlevel 1 goto open_browser

rem Prefer a system Node.js installation.
where node >nul 2>nul
if not errorlevel 1 goto run_system_node

rem Fall back to the Node.js runtime bundled with Codex.
if exist "%BUNDLED_NODE%" goto run_bundled_node

echo.
echo  [ERROR] Node.js was not found.
echo  Install Node.js from https://nodejs.org/
echo.
pause
exit /b 1

:open_browser
if "%LIFE_STEWARD_TEST%"=="1" (
    echo OPEN_BROWSER_OK
    exit /b 0
)
start "" "%APP_URL%"
exit /b 0

:run_system_node
echo.
echo  Starting Life Steward...
echo  The default browser will open automatically.
echo  Close this window to stop the service.
echo.
node server.js
pause
exit /b %errorlevel%

:run_bundled_node
echo.
echo  Starting Life Steward...
echo  The default browser will open automatically.
echo  Close this window to stop the service.
echo.
"%BUNDLED_NODE%" server.js
pause
exit /b %errorlevel%
