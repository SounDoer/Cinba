@echo off
rem Double-click launcher for the Windows system tray controller.

cd /d "%~dp0"
call node scripts\cinba.ts tray
if errorlevel 1 pause
