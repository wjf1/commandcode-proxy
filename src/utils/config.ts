// =============================================================================
// 配置加载 / 账号管理 / 额度轮换 / 浏览器 OAuth 登录
// -----------------------------------------------------------------------------
// - 配置优先环境变量 > config.json > 默认值
// - 安全默认：仅绑定 127.0.0.1，避免局域网暴露
// - 多账号：支持手动切换、浏览器 OAuth 登录、按 5 小时额度自动轮换（≥90% 切换）
// - openBrowser 针对 Windows cmd 的 "&" 分隔符问题做了特殊处理
// =============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { GatewayConfig, GatewayConfigFile, AccountInfo } from '../types/index.js';
import { logger } from './logger.js';

function getProjectRootDir(): string {
  if ((process as any).pkg || process.execPath.toLowerCase().includes('commandcode-proxy')) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

export const CONFIG_FILE_PATH = process.env.COMMANDCODE_CONFIG_PATH
  ? path.resolve(process.env.COMMANDCODE_CONFIG_PATH)
  : path.join(getProjectRootDir(), 'config.json');
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

const DEFAULT_BODY_LIMIT_MB = 64;

/**
 * 入站请求体上限（fastify bodyLimit，单位字节）。
 * 视觉/多图请求的 base64 负载常超过 Fastify 默认 1MB，会触发 413
 * (FST_ERR_CTP_BODY_TOO_LARGE)。默认 64MB，可用环境变量 MAX_BODY_MB 调整
 * （1..1024 的正整数）；非法值或未设置回退默认。
 */
export function resolveBodyLimit(): number {
  const raw = (process.env.MAX_BODY_MB || '').trim();
  if (/^\d+$/.test(raw)) {
    const mb = parseInt(raw, 10);
    if (mb >= 1 && mb <= 1024) return mb * 1024 * 1024;
  }
  return DEFAULT_BODY_LIMIT_MB * 1024 * 1024;
}

// ─── 上游 URL 安全校验（SSRF 加固）─────────────────────────────────────────────
//
// 所有服务端发起的上游请求（fetch / 用量统计 / 模型同步 / pricing 页）都必须
// 先经过 assertSafeUpstreamUrl 校验，防止：
//   - 注入非 http(s) 协议（file:、gopher: 等协议混淆）
//   - 在 URL 内嵌凭据（user:pass@host）
//   - 访问任意非授权主机（SSRF）
// 默认只允许 commandcode.ai 及其子域 + 回环地址；若用户配置了自建网关/镜像，
// 可通过环境变量 COMMANDCODE_UPSTREAM_ALLOWED_HOSTS 追加允许的 host（逗号分隔）。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

function normalizeHost(hostname: string): string {
  // 去掉首尾空白、IPv6 方括号、前导/尾随点，统一小写。
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^\.+/, '').replace(/\.+$/, '');
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 判断 host 是否是环回、私有或保留地址（IP 字面量）。这些内网/特殊地址默认一律
 * 拒绝，避免 SSRF 把请求导向本机、云元数据或内网；除非运维显式加入允许清单。
 * 非 IP 字面量（如域名）由 allowlist 判定，不在此处拦截。
 */
function isPrivateOrReserved(host: string): boolean {
  if (isLoopback(host)) return true;
  // IPv6：ULA fc00::/7、链路本地 fe80::/10 视为私有/保留
  if (host.includes(':')) {
    const h = host.toLowerCase();
    const fb = h.slice(0, 2);
    if (fb === 'fc' || fb === 'fd') return true;
    if (fb === 'fe') {
      const third = h.slice(2, 3);
      return third >= '8' && third <= 'b'; // fe80::/10 - febf::/10
    }
    return false;
  }
  // IPv4
  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 10) return true;                        // 10.0.0.0/8
    if (a === 127) return true;                       // 127.0.0.0/8 回环
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 0 || a >= 224) return true;             // 0.0.0.0/8、224/4(组播)、240/4(保留) 等
    return false;
  }
  return false;
}

function hostInExtraAllowlist(host: string): boolean {
  const extra = (process.env.COMMANDCODE_UPSTREAM_ALLOWED_HOSTS || '')
    .split(',')
    .map(s => normalizeHost(s))
    .filter(Boolean);
  return extra.some(e => host === e || host.endsWith('.' + e));
}

function isDefaultAllowedHost(host: string): boolean {
  // commandcode.ai 及其子域
  const sub = host.split('.').slice(-2).join('.');
  return host === 'commandcode.ai' || sub === 'commandcode.ai';
}

export function isAllowedUpstreamHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  // 环回/私有/保留地址默认拒绝，仅当运维显式加入允许清单时放行（自建网关/镜像/本地 mock）。
  if (isPrivateOrReserved(host)) return hostInExtraAllowlist(host);
  if (isDefaultAllowedHost(host)) return true;
  return hostInExtraAllowlist(host);
}

/**
 * 校验并返回一个可安全用于服务端 fetch 的 URL。
 * 不满足条件时抛错（fail-closed），调用方应据此拒绝请求而不是降级执行。
 */
export function assertSafeUpstreamUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch (e: any) {
    throw new Error(`[NET] Invalid upstream URL: ${e?.message || 'parse error'}`);
  }
  if (url.username || url.password) {
    throw new Error('[NET] Upstream URL must not embed credentials');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`[NET] Upstream URL must be http(s), got '${url.protocol}'`);
  }
  const host = normalizeHost(url.hostname);
  if (!host) throw new Error('[NET] Upstream URL has no host');
  const loopback = isLoopback(host);
  const privateOrReserved = isPrivateOrReserved(host);
  const explicitlyAllowed = hostInExtraAllowlist(host);
  // 环回/私有/保留地址（含 localhost、127.x、10.x、169.254.x、192.168.x、172.16-31.x、
  // IPv6 ULA/链路本地）默认拒绝，除非运维显式加入允许清单。
  if (privateOrReserved && !explicitlyAllowed) {
    throw new Error(`[NET] Upstream host is private/loopback and not allowlisted: ${host}`);
  }
  // 非环回强制 https（避免降级到明文）；环回且显式放行时才允许 http（用于本地 mock/自建网关）。
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('[NET] Non-loopback upstream must use https (got http)');
  }
  if (!isAllowedUpstreamHost(host)) {
    throw new Error(`[NET] Upstream host is not allowed: ${host}`);
  }
  return url;
}

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

/**
 * 为兜底账号生成显示名（不写死占位名）。
 * 例：`CLI Key (尾4位 xxxx)` / `Env Key (尾4位 xxxx)`。仅用 Key 尾 4 位做区分，
 * 不暴露完整密钥；真实用户名待启动时异步补全（见后台账号名补全）。
 */
export function defaultAccountName(apiKey: string, source: 'env' | 'auth.json' | ''): string {
  const tail = String(apiKey || '').slice(-4) || '????';
  const label = source === 'auth.json' ? 'CLI Key' : source === 'env' ? 'Env Key' : 'API Key';
  return `${label} (尾4位 ${tail})`;
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
  // 安全默认：仅绑定回环地址。显式设置 HOST 才会暴露到局域网。
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
    const { apiKey: sysKey, source } = loadDefaultApiKeyFromEnvOrSystem();
    if (sysKey) {
      accounts.push({
        id: 'acc_default',
        name: defaultAccountName(sysKey, source),
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

/** 原子化写入 config.json（临时文件 + rename），避免崩溃时截断配置。 */
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

// ─── 网关引擎开关状态 ─────────────────────────────────────────────────────────

export function getGatewayRunning(): boolean {
  return (globalThis as any).__GATEWAY_RUNNING__ !== false;
}

export function setGatewayRunning(running: boolean): void {
  (globalThis as any).__GATEWAY_RUNNING__ = running;
}

// ─── 账号管理 ────────────────────────────────────────────────────────────────

export function getActiveAccount(): AccountInfo | undefined {
  const config = loadConfig();
  return config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];
}

export function getActiveApiKey(): string {
  const acc = getActiveAccount();
  return acc?.apiKey || loadDefaultApiKeyFromEnvOrSystem().apiKey;
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

/**
 * 启动后异步补全兜底账号的真实用户名（不阻塞启动）。
 * 对 `config.json` 里没有命名账号、仅靠环境变量/auth.json 兜底 Key 的场景：
 * 用 `/alpha/whoami` 拿到 `user.name || user.userName`，将账号名补为
 * `Command Code (xxx)`，并回填 userName/email/userId。失败或拿不到时
 * 静默保留来源+尾4位显示名。
 */
export async function enrichDefaultAccountName(): Promise<void> {
  try {
    const config = loadConfig();
    const acc = config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];
    if (!acc?.apiKey) return;
    // 已有真实命名（含手动/OAuth 登录的账号）则不覆盖。
    if (acc.userName || (acc.name && !/尾4位|Default System Account|API Key$/i.test(acc.name))) return;
    const stats = await fetchLiveUsageStats(acc.apiKey, config.ccApiBase, config.ccVersion);
    const who = stats.whoami?.user;
    const realName = who && (who.name || who.userName);
    if (!realName) return;
    const updated = config.accounts.map(a =>
      a.id === acc.id
        ? { ...a, name: `Command Code (${realName})`, userName: who.userName, email: who.email, userId: who.id }
        : a,
    );
    saveConfigFile({ accounts: updated });
    logger.info(`[AUTH] Enriched account name: ${acc.name} -> Command Code (${realName})`);
  } catch (err: any) {
    logger.warn(`[AUTH] Account name enrichment skipped: ${err?.message || err}`);
  }
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

// ─── 额度轮换（在 index.ts 中实际被调度）───────────────────────────────────────

const QUOTA_THRESHOLD = 0.9;

/**
 * 检查当前账号的 5 小时额度使用率，若 ≥90% 则自动切换到使用率较低的备选账号。
 * 仅当 rotationMode === 'auto-quota' 且存在多个账号时生效。返回是否发生了切换。
 */
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

// ─── 上游用量统计（whoami / credits / subscriptions / usage summary）──────────

async function fetchJson(url: string, headers: Record<string, string>): Promise<any | null> {
  let safeUrl: string;
  try {
    safeUrl = assertSafeUpstreamUrl(url).toString();
  } catch (err: any) {
    logger.warn(`[USAGE] Blocked unsafe upstream URL: ${err.message}`);
    return null;
  }
  try {
    const res = await fetch(safeUrl, { headers });
    if (res.ok) return await res.json();
  } catch (err: any) {
    logger.warn(`[USAGE] ${safeUrl} fetch error: ${err.message}`);
  }
  return null;
}

/**
 * 并行拉取账号的 whoami、额度（credits）、订阅（subscriptions）与用量汇总。
 * 用于仪表盘展示与额度轮换判断。
 */
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
