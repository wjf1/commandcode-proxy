@echo off
rem CommandCode Proxy v4 - autostart launcher (Windows Task Scheduler)
rem Resolve this script's own directory so the checkout can live anywhere.
cd /d "%~dp0"
set NO_OPEN_BROWSER=1
if not exist "logs" mkdir logs
rem Prefer a standard Node.js install over whatever "node" PATH resolves to
rem (bundled runtimes from other tools can shadow it), then fall back to PATH.
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE set "NODE=node"
rem Logger persists to logs/proxy.log itself; keep console output separate
rem (two writers on one file would interleave/corrupt lines).
"%NODE%" dist/index.js >> logs\console.log 2>&1
