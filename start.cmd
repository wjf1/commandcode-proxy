@echo off
rem CommandCode Proxy v4 - autostart launcher (Windows Task Scheduler)
rem Resolve this script's own directory so the checkout can live anywhere.
cd /d "%~dp0"
set NO_OPEN_BROWSER=1
rem 上游白名单：即使系统 DNS 被代理软件 fake-ip 化（198.18.x.x），
rem 也跳过该域名的 DNS rebinding 校验，避免 BLOCKED_HOST 秒败。
set COMMANDCODE_UPSTREAM_ALLOWED_HOSTS=api.commandcode.ai
rem 出站代理支持：若系统或用户未配置，默认走本机科学上网客户端，避免海外
rem Cloudflare 节点直连 TCP 超时（UND_ERR_CONNECT_TIMEOUT）。混合端口历史上
rem 漂移过两次（7897 → 7900 → 7901），写死必再漂——改为依次探测实际监听的
rem 端口取第一个命中者，全部未监听时回落 7901（当前值）。
set "CC_PROXY_PORT="
for %%P in (7901 7900 7897) do (
  if not defined CC_PROXY_PORT (
    netstat -ano | findstr /R /C:":%%P .*LISTENING" >nul 2>&1 && set "CC_PROXY_PORT=%%P"
  )
)
if not defined CC_PROXY_PORT set "CC_PROXY_PORT=7901"
if not defined HTTPS_PROXY set "HTTPS_PROXY=http://127.0.0.1:%CC_PROXY_PORT%"
if not defined HTTP_PROXY set "HTTP_PROXY=http://127.0.0.1:%CC_PROXY_PORT%"
if not defined NO_PROXY set "NO_PROXY=localhost,127.0.0.1,::1"
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
