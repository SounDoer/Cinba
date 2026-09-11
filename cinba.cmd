@echo off
rem Double-click launcher for the regular, built Cinba web application.

cd /d "%~dp0"
call npm start
if errorlevel 1 pause
