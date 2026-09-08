@echo off
rem 开发模式：核心服务 + Vite 热更新，一边用一边改界面。
rem 会开出两个窗口，各自的日志分开看。浏览器用 5173，改完代码自动刷新。

chcp 65001 >nul
cd /d "%~dp0"

netstat -ano | findstr "127.0.0.1:4517" >nul
if errorlevel 1 (
  echo 启动核心服务...
  start "Cinba 核心服务" cmd /k "chcp 65001 >nul && node packages\core-server\src\index.ts"
) else (
  echo 核心服务已在运行，直接复用。
)

echo 启动 Vite 热更新...
start "Cinba 界面（热更新）" cmd /k "chcp 65001 >nul && npm run dev --workspace @cinba/web"

rem Vite 冷启动要几秒，等它就位再开浏览器。
start /b "" powershell -NoProfile -Command "Start-Sleep 5; Start-Process 'http://localhost:5173/'"

echo.
echo 两个窗口已开出，浏览器过几秒自动打开 http://localhost:5173/
echo 停止开发：把那两个窗口关掉。
echo.
timeout /t 4 >nul
