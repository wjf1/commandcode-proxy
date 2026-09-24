// =============================================================================
// 浏览器 OAuth 登录 / auth.json 读取 / 系统浏览器唤起
// -----------------------------------------------------------------------------
// 自 config.ts 原样搬出（架构 Phase 1 拆分），公共行为零变化。
// openBrowser 针对 Windows cmd 的 "&" 分隔符问题做了特殊处理。
//
// 依赖方向（含一处刻意保留的循环导入，初始化安全）：
//   - 本文件 → config.js：startBrowserLoginFlow 在 OAuth 回调命中时调用
//     loginNewAccount 注册新账号。该调用仅发生在运行时（回调触发后），模块
//     顶层不求值 config 的任何绑定，ESM live binding 保证两个加载顺序下
//     初始化均安全（config → 本文件 或 本文件 → config）。
//   - config.js → 本文件：re-export loadDefaultApiKeyFromEnvOrSystem /
//     openBrowser / startBrowserLoginFlow（全仓调用方 import 路径不变），
//     且 loadConfig / getActiveApiKey 内部使用 loadDefaultApiKeyFromEnvOrSystem。
//   - logger.js / types 为单向依赖，无环。
// =============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { AccountInfo } from '../types/index.js';
import { logger } from './logger.js';
import { loginNewAccount } from './config.js';

/** 从环境变量或用户级 auth.json 加载默认 API Key（作为无账号配置时的兜底）。 */
export function loadDefaultApiKeyFromEnvOrSystem(): { apiKey: string; source: 'env' | 'auth.json' | '' } {
  if (process.env.COMMANDCODE_API_KEY) {
    return { apiKey: process.env.COMMANDCODE_API_KEY.trim(), source: 'env' };
  }
  try {
    const authFile = path.join(os.homedir(), '.commandcode', 'auth.json');
    if (fs.existsSync(authFile)) {
      const content = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      if (content.apiKey || content.token) {
        return { apiKey: String(content.apiKey || content.token).trim(), source: 'auth.json' };
      }
    }
  } catch (err: any) {
    logger.warn(`[CONFIG] Could not read ~/.commandcode/auth.json: ${err.message}`);
  }
  return { apiKey: '', source: '' };
}

// ─── 打开浏览器（跨平台、无 shell）────────────────────────────────────────────

/**
 * 用默认浏览器打开 URL。全程不通过 shell —— 以参数数组 spawn 各平台的系统
 * 浏览器命令：
 *   - Windows: rundll32 url.dll,FileProtocolHandler <url>（不再走 cmd `start`，
 *     避免 cmd 把 URL 里的 `&`/`|` 当命令分隔符，从而杜绝命令注入）
 *   - macOS:   open <url>
 *   - Linux:   xdg-open <url>
 * process.platform 与要打开的 URL 均来自服务端自身（固定 dashboard/OAuth 地址），
 * 此处再额外校验必须为合法绝对 URL，避免任何不可控字符串进入进程。
 */
export function openBrowser(url: string): void {
  let target: string;
  try {
    target = new URL(url).toString();
  } catch {
    logger.warn(`[BROWSER] Ignoring invalid URL: ${url}`);
    return;
  }

  try {
    let child: ReturnType<typeof spawn>;
    if (process.platform === 'win32') {
      child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target], { shell: false, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [target], { shell: false, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [target], { shell: false, stdio: 'ignore' });
    }
    child.on('error', err => logger.warn(`[BROWSER] Could not open browser URL: ${err.message}`));
  } catch (err: any) {
    logger.warn(`[BROWSER] Could not open browser URL: ${err.message}`);
  }
}

// ─── 浏览器 OAuth 登录流程 ────────────────────────────────────────────────────

/**
 * 启动本地 HTTP 回调服务（默认端口 5959），打开 commandcode.ai 的 OAuth 授权页，
 * 等待用户完成授权后从回调参数中提取 token/apiKey，并注册为新账号。
 * 若 3 分钟内未完成授权则超时拒绝。
 */
export function startBrowserLoginFlow(port = 5959): Promise<AccountInfo> {
  const stateToken = crypto.randomUUID();
  const callbackUrl = `http://localhost:${port}/callback`;
  const authUrl = `https://commandcode.ai/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost:9090');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
        if (reqUrl.pathname === '/callback') {
          // CSRF 防护：若回调携带 state，必须与本流程随机生成的 stateToken 一致。
          // 不携带 state 时视为兼容旧版 CLI 流程（其可能不回显 state），不阻断。
          const cbState = reqUrl.searchParams.get('state');
          if (cbState && cbState !== stateToken) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Auth failed: invalid state');
            return;
          }
          let apiKey =
            reqUrl.searchParams.get('token') ||
            reqUrl.searchParams.get('apiKey') ||
            reqUrl.searchParams.get('key') ||
            '';

          if (!apiKey && req.method === 'POST') {
            let bodyStr = '';
            req.on('data', chunk => {
              bodyStr += chunk;
              if (bodyStr.length > 64 * 1024) req.destroy();
            });
            await new Promise<void>(r => req.on('end', () => r()));
            try {
              const parsed = JSON.parse(bodyStr);
              apiKey = parsed.token || parsed.apiKey || parsed.key || '';
            } catch {}
          }

          if (apiKey) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><title>CommandCode Auth Success</title></head>
<body style="font-family:system-ui,sans-serif;background:#090d16;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;background:#111827;padding:2.5rem;border-radius:1rem;border:1px solid #1f2937;max-width:400px">
<h2 style="margin:0;color:#6366f1">Authentication Successful!</h2>
<p style="color:#9ca3af;font-size:.875rem">Your Command Code account has been added to the Proxy Gateway.</p>
</div><script>setTimeout(()=>window.close(),3000)</script></body></html>`);

            try {
              const newAcc = await loginNewAccount(apiKey);
              server.close();
              resolve(newAcc);
            } catch (err: any) {
              server.close();
              reject(err);
            }
            return;
          }
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Auth error: ${err.message}`);
        server.close();
        reject(err);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    server.on('error', err => {
      logger.error(`[AUTH] Callback server error: ${err.message}`);
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      logger.info(`[AUTH] Browser login flow started. Opening URL: ${authUrl}`);
      openBrowser(authUrl);
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Browser login timed out after 3 minutes.'));
    }, 180_000);

    const origClose = server.close.bind(server);
    server.close = ((...args: any[]) => {
      clearTimeout(timeout);
      return (origClose as any)(...args);
    }) as typeof server.close;
  });
}
