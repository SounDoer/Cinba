@echo off
rem Development mode: core service plus Vite hot reload, for using Cinba while
rem changing its UI. Two windows open so their logs stay separate. Use port
rem 5173; edits to the UI refresh by themselves.

cd /d "%~dp0"

netstat -ano | findstr "127.0.0.1:4517" >nul
if errorlevel 1 (
  echo Starting the core service...
  start "Cinba core service" cmd /k node packages\server\src\index.ts
) else (
  echo The core service is already running, reusing it.
)

echo Starting Vite hot reload...
start "Cinba UI (hot reload)" cmd /k npm run dev --workspace @cinba/web

rem Vite takes a few seconds to come up; wait before opening the browser.
start /b "" powershell -NoProfile -Command "Start-Sleep 5; Start-Process 'http://localhost:5173/'"

echo.
echo Two windows opened. The browser opens http://localhost:5173/ shortly.
echo To stop developing, close those two windows.
echo.
timeout /t 4 >nul
