@echo off
rem 双击启动 Cinba：确保界面已构建，起核心服务，顺手打开浏览器。
rem 这个窗口就是服务本身——关掉它等于停止服务。

chcp 65001 >nul
cd /d "%~dp0"

if not exist "packages\web\dist\index.html" (
  echo 界面还没构建过，先构建一次，稍等...
  call npm run build --workspace @cinba/web
  if errorlevel 1 goto :done
)

echo Cinba 正在启动，浏览器过两秒自动打开。
echo 关掉这个窗口即可停止服务。
echo.

rem 延迟两秒再开浏览器，等服务器把端口监听起来。
start /b "" powershell -NoProfile -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:4517/'"

node packages\core-server\src\index.ts

:done
echo.
echo 服务已退出。
pause
