import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
import { exec } from 'child_process';
import { GatewayConfig, GatewayConfigFile, AccountInfo } from '../types/index.js';
import { logger } from './logger.js';

function getProjectRootDir(): string {
  if ((process as any).pkg || process.execPath.toLowerCase().includes('commandcode-proxy')) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

export const CONFIG_FILE_PATH = path.join(getProjectRootDir(), 'config.json');
const ENV_FILE_PATH = path.join(getProjectRootDir(), '.env');

const DEFAULTS = {
  port: 9090,
  host: '127.0.0.1',
  apiBase: 'https://api.commandcode.ai',
  ccVersion: '1.27.1',
  rotationMode: 'manual' as const,
  permissionMode: 'auto-accept',
  upstreamTimeoutMs: 600_000,
  idleTimeoutMs: 120_000,
  maxRetries: 2,
};

export function loadDefaultApiKeyFromEnvOrSystem(): string {
  if (process.env.COMMANDCODE_API_KEY) {
    return process.env.COMMANDCODE_API_KEY.trim();
  }
  try {
    const authFile = path.join(os.homedir(), '.commandcode', 'auth.json');
    if (fs.existsSync(authFile)) {
      const content = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      if (content.apiKey || content.token) {
        return String(content.apiKey || content.token).trim();
      }
    }
  } catch (err: any) {
    logger.warn(`[CONFIG] Could not read ~/.commandcode/auth.json: ${err.message}`);
  }
  return '';
}

export function loadConfig(): GatewayConfig {
  let fileConfig: Partial<GatewayConfigFile> = {};
  if (fs.existsSync(CONFIG_FILE_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
    } catch (err: any) {
      logger.error(`[CONFIG] Error reading config.json: ${err.message}`);
    }
  }

  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  const port = envPort || fileConfig.port || DEFAULTS.port;
  // Security default: bind loopback only. Opt in to LAN exposure explicitly.
  const host = process.env.HOST || fileConfig.host || DEFAULTS.host;

  const ccApiBase = process.env.COMMANDCODE_API_BASE || fileConfig.upstream?.apiBase || DEFAULTS.apiBase;
  const ccVersion = process.env.COMMANDCODE_VERSION || fileConfig.upstream?.ccVersion || DEFAULTS.ccVersion;
  const rotationMode =
    process.env.ROTATION_MODE === 'auto-quota' || fileConfig.rotationMode === 'auto-quota'
      ? 'auto-quota'
      : 'manual';
  const permissionMode = fileConfig.permissionMode || DEFAULTS.permissionMode;

  let accounts: AccountInfo[] = Array.isArray(fileConfig.accounts) ? fileConfig.accounts : [];
  if (accounts.length === 0) {
    const sysKey = loadDefaultApiKeyFromEnvOrSystem();
    if (sysKey) {
      accounts.push({
        id: 'acc_default',
        name: 'Default System Account',
        apiKey: sysKey,
        addedAt: new Date().toISOString(),
      });
    }
  }

  let activeAccountId = fileConfig.activeAccountId || (accounts.length > 0 ? accounts[0].id : '');
  if (activeAccountId && !accounts.some(a => a.id === activeAccountId) && accounts.length > 0) {
    activeAccountId = accounts[0].id;
  }

  return {
    port,
    host,
    ccApiBase,
    ccVersion,
    rotationMode,
    permissionMode,
    activeAccountId,
    accounts,
    upstreamTimeoutMs: fileConfig.upstream?.timeoutMs || DEFAULTS.upstreamTimeoutMs,
    idleTimeoutMs: fileConfig.upstream?.idleTimeoutMs || DEFAULTS.idleTimeoutMs,
    maxRetries: fileConfig.upstream?.maxRetries ?? DEFAULTS.maxRetries,
  };
}

/** Write config atomically (temp file + rename) so a crash never truncates it. */
export function saveConfigFile(updates: Partial<GatewayConfigFile>): void {
  try {
    let current: Partial<GatewayConfigFile> = {};
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      try {
        current = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
      } catch {}
    }

    const updated: GatewayConfigFile = {
      port: updates.port ?? current.port ?? DEFAULTS.port,
      host: updates.host ?? current.host ?? DEFAULTS.host,
      activeAccountId: updates.activeAccountId ?? current.activeAccountId ?? '',
      rotationMode: updates.rotationMode ?? current.rotationMode ?? 'manual',
      permissionMode: updates.permissionMode ?? current.permissionMode ?? DEFAULTS.permissionMode,
      accounts: updates.accounts ?? current.accounts ?? [],
      upstream: {
        apiBase: updates.upstream?.apiBase ?? current.upstream?.apiBase ?? DEFAULTS.apiBase,
        ccVersion: updates.upstream?.ccVersion ?? current.upstream?.ccVersion ?? DEFAULTS.ccVersion,
        timeoutMs: updates.upstream?.timeoutMs ?? current.upstream?.timeoutMs ?? DEFAULTS.upstreamTimeoutMs,
        idleTimeoutMs: updates.upstream?.idleTimeoutMs ?? current.upstream?.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
        maxRetries: updates.upstream?.maxRetries ?? current.upstream?.maxRetries ?? DEFAULTS.maxRetries,
      },
    };

    const tmp = `${CONFIG_FILE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8');
    fs.renameSync(tmp, CONFIG_FILE_PATH);

    const activeAcc = (updated.accounts || []).find(a => a.id === updated.activeAccountId);
    if (activeAcc?.apiKey) syncEnvFile(updated.accounts || [], activeAcc.apiKey);
  } catch (err: any) {
    logger.error(`[CONFIG] Error saving config.json: ${err.message}`);
  }
}

function syncEnvFile(accounts: AccountInfo[], activeApiKey: string): void {
  try {
    const envLines = [
      `COMMANDCODE_API_KEY=${activeApiKey}`,
      `COMMANDCODE_API_BASE=${DEFAULTS.apiBase}`,
      `COMMANDCODE_VERSION=${DEFAULTS.ccVersion}`,
      `ACCOUNTS_COUNT=${accounts.length}`,
      `UPDATED_AT=${new Date().toISOString()}`,
    ];
    fs.writeFileSync(ENV_FILE_PATH, envLines.join('\n'), 'utf-8');
  } catch (err: any) {
    logger.warn(`[CONFIG] Could not sync .env file: ${err.message}`);
  }
}

// ─── Gateway engine state ─────────────────────────────────────────────────────

export function getGatewayRunning(): boolean {
  return (globalThis as any).__GATEWAY_RUNNING__ !== false;
}

export function setGatewayRunning(running: boolean): void {
  (globalThis as any).__GATEWAY_RUNNING__ = running;
}

// ─── Account management ───────────────────────────────────────────────────────

export function getActiveAccount(): AccountInfo | undefined {
  const config = loadConfig();
  return config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];
}

export function getActiveApiKey(): string {
  const acc = getActiveAccount();
  return acc?.apiKey || loadDefaultApiKeyFromEnvOrSystem();
}

export function setActiveAccount(accountId: string): void {
  const config = loadConfig();
  const target = config.accounts.find(a => a.id === accountId);
  if (target) {
    saveConfigFile({ activeAccountId: accountId });
    logger.info(`[AUTH] Switched active account to: ${target.name} (${target.id})`);
  }
}

export function setRotationMode(mode: 'manual' | 'auto-quota'): void {
  saveConfigFile({ rotationMode: mode });
  logger.info(`[AUTH] Changed key rotation mode to: ${mode}`);
}

export async function loginNewAccount(apiKey: string, name?: string): Promise<AccountInfo> {
  const config = loadConfig();
  const cleanKey = apiKey.trim();

  const existing = config.accounts.find(a => a.apiKey === cleanKey);
  if (existing) {
    setActiveAccount(existing.id);
    return existing;
  }

  const profileStats = await fetchLiveUsageStats(cleanKey, config.ccApiBase, config.ccVersion);
  const who = profileStats.whoami?.user;

  const id = `acc_${crypto.randomBytes(4).toString('hex')}`;
  const accName =
    name ||
    (who && (who.name || who.userName) ? `Command Code (${who.name || who.userName})` : undefined) ||
    `Account (${cleanKey.slice(-4)})`;

  const newAcc: AccountInfo = {
    id,
    name: accName,
    apiKey: cleanKey,
    userName: who?.userName,
    email: who?.email,
    userId: who?.id,
    addedAt: new Date().toISOString(),
  };

  saveConfigFile({
    accounts: [...config.accounts, newAcc],
    activeAccountId: id,
  });

  logger.info(`[AUTH] Registered new account: ${accName} (${id})`);
  return newAcc;
}

export function logoutAccount(accountId: string): boolean {
  const config = loadConfig();
  const updatedAccounts = config.accounts.filter(a => a.id !== accountId);
  let newActiveId = config.activeAccountId;

  if (newActiveId === accountId) {
    newActiveId = updatedAccounts.length > 0 ? updatedAccounts[0].id : '';
  }

  saveConfigFile({ accounts: updatedAccounts, activeAccountId: newActiveId });
  logger.info(`[AUTH] Removed account '${accountId}'`);
  return true;
}

// ─── Quota rotation (actually scheduled from index.ts) ────────────────────────

const QUOTA_THRESHOLD = 0.9;

export async function checkAndRotateAccountsOnQuota(): Promise<boolean> {
  const config = loadConfig();
  if (config.rotationMode !== 'auto-quota' || config.accounts.length <= 1) {
    return false;
  }

  const currentAcc = config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];
  if (!currentAcc?.apiKey) return false;

  try {
    const stats = await fetchLiveUsageStats(currentAcc.apiKey, config.ccApiBase, config.ccVersion);
    const fhLimit = stats.credits?.windowLimits?.fiveHour;
    if (!fhLimit || !(fhLimit.cap > 0)) return false;

    const usageRatio = fhLimit.used / fhLimit.cap;
    logger.info(
      `[AUTO-QUOTA] '${currentAcc.name}' 5-Hour quota: ${(usageRatio * 100).toFixed(1)}% (${fhLimit.used.toFixed(2)} / ${fhLimit.cap.toFixed(2)})`
    );

    if (usageRatio < QUOTA_THRESHOLD) return false;

    logger.warn(`[AUTO-QUOTA] '${currentAcc.name}' exceeded ${QUOTA_THRESHOLD * 100}% threshold. Searching alternates...`);
    for (const altAcc of config.accounts) {
      if (altAcc.id === currentAcc.id || !altAcc.apiKey) continue;
      try {
        const altStats = await fetchLiveUsageStats(altAcc.apiKey, config.ccApiBase, config.ccVersion);
        const altFh = altStats.credits?.windowLimits?.fiveHour;
        const altRatio = altFh && altFh.cap > 0 ? altFh.used / altFh.cap : 0;
        if (altRatio < QUOTA_THRESHOLD) {
          setActiveAccount(altAcc.id);
          logger.info(`[AUTO-QUOTA] Switched active account to '${altAcc.name}' [Quota: ${(altRatio * 100).toFixed(1)}%]`);
          return true;
        }
      } catch {}
    }
    logger.warn('[AUTO-QUOTA] All registered accounts exceed the quota threshold.');
  } catch (err: any) {
    logger.error(`[AUTO-QUOTA] Failed to check quota: ${err.message}`);
  }
  return false;
}

// ─── Upstream usage stats ─────────────────────────────────────────────────────

async function fetchJson(url: string, headers: Record<string, string>): Promise<any | null> {
  try {
    const res = await fetch(url, { headers });
    if (res.ok) return await res.json();
  } catch (err: any) {
    logger.warn(`[USAGE] ${url} fetch error: ${err.message}`);
  }
  return null;
}

export async function fetchLiveUsageStats(apiKey: string, ccApiBase: string, ccVersion: string): Promise<any> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'cli',
    'x-cli-environment': 'cli',
    'x-command-code-version': ccVersion,
  };

  const whoami = await fetchJson(`${ccApiBase}/alpha/whoami`, headers);
  const orgId = whoami?.org?.id || whoami?.data?.org?.id;
  const orgQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';

  const [credits, subscription, summary] = await Promise.all([
    fetchJson(`${ccApiBase}/alpha/billing/credits${orgQuery}`, headers),
    fetchJson(`${ccApiBase}/alpha/billing/subscriptions${orgQuery}`, headers),
    fetchJson(`${ccApiBase}/alpha/usage/summary${orgQuery}`, headers),
  ]);

  return { whoami, credits, subscription, summary };
}

// ─── Browser opening (Windows-safe) ───────────────────────────────────────────

/**
 * Windows gotcha: `exec("start <url>")` breaks on URLs containing "&" because
 * cmd.exe treats it as a command separator. Quoting the URL and giving start an
 * empty title argument (`start "" "<url>"`) makes it safe on every platform.
 */
export function openBrowser(url: string): void {
  const quoted = `"${url.replace(/"/g, '%22')}"`;
  const cmd =
    process.platform === 'win32'
      ? `start "" ${quoted}`
      : process.platform === 'darwin'
        ? `open ${quoted}`
        : `xdg-open ${quoted}`;
  exec(cmd, { shell: process.platform === 'win32' ? undefined : '/bin/sh' }, err => {
    if (err) logger.warn(`[BROWSER] Could not auto-open browser URL: ${err.message}`);
  });
}

// ─── Browser OAuth login flow ─────────────────────────────────────────────────

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
