# CommandCode Proxy v4 - hidden autostart (no console window)
$ErrorActionPreference = "Stop"

# Resolve this script's own directory so the checkout can live anywhere.
$dir = $PSScriptRoot
if (-not $dir) { $dir = Split-Path -Parent $MyInvocation.MyCommand.Path }

# Prefer a standard Node.js install over whatever "node" PATH happens to
# resolve to (bundled runtimes from other tools can shadow it).
$candidates = @()
if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
$node = $null
foreach ($candidate in $candidates) {
  if (Test-Path $candidate) { $node = $candidate; break }
}
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw "node.exe not found. Install Node.js or add it to PATH." }

$env:NO_OPEN_BROWSER = "1"
if (-not (Test-Path "$dir\logs")) { New-Item -ItemType Directory -Path "$dir\logs" | Out-Null }
Start-Process -FilePath $node -ArgumentList "dist/index.js" -WorkingDirectory $dir `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$dir\logs\proxy.out.log" `
  -RedirectStandardError "$dir\logs\proxy.err.log"
