@echo off
rem 无窗口启动服务并打开界面；服务已在运行时只打开界面。
cd /d "%~dp0"
start "" wscript.exe "%~dp0launch-hidden.vbs" open
