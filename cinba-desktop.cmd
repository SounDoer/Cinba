@echo off
rem Double-click launcher for the Windows System Tray and Desktop controller.

cd /d "%~dp0"
call node scripts\cinba.ts desktop
if errorlevel 1 pause
