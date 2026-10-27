@echo off
chcp 65001 >nul
title ChatDrop - 局域网互传
cd /d "%~dp0"

echo.
echo   ============================================
echo     ChatDrop  局域网聊天式互传
echo   ============================================
echo.

rem 优先用 PATH 里的 node，找不到再试常见安装路径
set "NODEEXE="
where node >nul 2>nul && set "NODEEXE=node"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODEEXE (
  echo   [错误] 未找到 Node.js
  echo   请先安装 Node.js 18 或更高版本： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "usebackq tokens=*" %%v in (`"%NODEEXE%" -v`) do echo   Node.js %%v
echo.

if not exist "%~dp0server.js" (
  echo   [错误] 当前目录找不到 server.js
  echo   目录： %~dp0
  echo.
  pause
  exit /b 1
)

"%NODEEXE%" "%~dp0server.js"

echo.
echo   服务已停止。
pause
