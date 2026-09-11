@echo off
rem Double-click launcher for Core watch mode and Vite hot reload.

cd /d "%~dp0"
call npm run dev
if errorlevel 1 pause
