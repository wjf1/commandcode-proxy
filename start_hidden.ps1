# CommandCode Proxy v4 - hidden autostart (no console window)
$ErrorActionPreference = "Stop"
$dir = "C:\Users\Administrator\Doubao\chats\2026-09-03\new-chat-2\commandcode-proxy"
$node = "C:\Program Files\nodejs\node.exe"
$env:NO_OPEN_BROWSER = "1"
$env:COMMANDCODE_PROXY_DIR = $dir
if (-not (Test-Path "$dir\logs")) { New-Item -ItemType Directory -Path "$dir\logs" | Out-Null }
Start-Process -FilePath $node -ArgumentList "dist/index.js" -WorkingDirectory $dir `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$dir\logs\proxy.out.log" `
  -RedirectStandardError "$dir\logs\proxy.err.log"
