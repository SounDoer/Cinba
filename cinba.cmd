@echo off
rem Double-click launcher: make sure the UI is built, start the core service,
rem and open the browser. This window IS the service - closing it stops Cinba.

cd /d "%~dp0"

if not exist "packages\web\dist\index.html" (
  echo The UI has not been built yet. Building it once, this takes a moment...
  call npm run build --workspace @cinba/web
  if errorlevel 1 goto :done
)

echo Starting Cinba. The browser opens in a couple of seconds.
echo Close this window to stop the service.
echo.

rem Give the server two seconds to start listening before opening the browser.
start /b "" powershell -NoProfile -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:4517/'"

node packages\core-server\src\index.ts

:done
echo.
echo Service stopped.
pause
