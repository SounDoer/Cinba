@echo off
setlocal
rem Double-click or drag-and-drop launcher for the terminal client. Keep the
rem selected project while Node loads Cinba from the repository.

set "project=%CD%"

if not "%~1"=="" (
  if exist "%~1\" set "project=%~f1"
)

call node "%~dp0scripts\cinba.ts" tui "%project%"
set "exitCode=%errorlevel%"
if not "%exitCode%"=="0" pause
exit /b %exitCode%
