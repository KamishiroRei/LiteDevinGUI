@echo off
rem devin-lite 启动器（保留控制台窗口便于看日志；静默启动用 devin-lite.vbs）
cd /d %~dp0
where node >nul 2>&1
if errorlevel 1 (
  echo [devin-lite] 未找到 node，请先安装 Node.js
  pause
  exit /b 1
)
start "" http://127.0.0.1:8317
node server.mjs
pause
