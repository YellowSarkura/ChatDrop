@echo off
chcp 65001 >nul
title 安装 ChatDrop 开机自启
cd /d "%~dp0"

echo.
echo   将 ChatDrop 注册为开机自启（后台静默运行）
echo.

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%~dp0_chatdrop_silent.vbs"

rem 生成静默启动脚本（无黑窗口）
> "%VBS%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%VBS%" echo WshShell.CurrentDirectory = "%~dp0"
>> "%VBS%" echo WshShell.Run "node server.js", 0, False

copy /y "%VBS%" "%STARTUP%\ChatDrop.vbs" >nul
if errorlevel 1 (
  echo   [失败] 无法写入启动目录
  pause
  exit /b 1
)

echo   已安装： %STARTUP%\ChatDrop.vbs
echo.
echo   下次登录 Windows 时会自动启动 ChatDrop
echo   卸载：删除上面这个文件即可
echo.
pause
