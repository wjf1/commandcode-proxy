@echo off
rem CommandCode Proxy v4 - autostart launcher (Windows Task Scheduler)
cd /d "C:\Users\Administrator\Doubao\chats\2026-09-03\new-chat-2\commandcode-proxy"
set NO_OPEN_BROWSER=1
if not exist "logs" mkdir logs
"C:\Program Files\nodejs\node.exe" dist/index.js >> logs\proxy.log 2>&1
