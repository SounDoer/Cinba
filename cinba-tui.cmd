@echo off
rem Double-click launcher for the terminal client. Keep the selected project as
rem its working directory while npm loads Cinba from the repository.

if not "%~1"=="" (
  if exist "%~1\" cd /d "%~1"
)

call npm --prefix "%~dp0" run tui -- "%CD%"
if errorlevel 1 pause
