@echo off
rem Double-click launcher for the terminal client.
rem
rem Unlike cinba.cmd this deliberately does NOT cd to the repository: the
rem terminal lands in the conversations of whichever directory it starts in, so
rem the working directory is the whole point. Double-clicked it uses the folder
rem it sits in; drag a project folder onto it, or run it from a terminal that is
rem already in one, to work there instead.

if not "%~1"=="" (
  if exist "%~1\" cd /d "%~1"
)

rem The core service has to be running. The terminal starts no Pi of its own, on
rem purpose: whoever owns that process should own its lifetime and its log.
netstat -ano | findstr "127.0.0.1:4517" >nul
if errorlevel 1 (
  echo Cinba's core service is not running, and this window cannot talk to anything without it.
  echo.
  echo Start it first: double-click cinba.cmd in the repository root.
  echo.
  pause
  goto :eof
)

echo Cinba terminal, working in: %CD%
echo Type / for commands. Ctrl+C to exit.
echo.

node "%~dp0packages\tui\src\index.ts"

echo.
echo Terminal closed. The core service is still running in its own window.
pause
