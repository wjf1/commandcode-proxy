// =============================================================================
// 配置加载 / 账号管理 / 额度轮换
// -----------------------------------------------------------------------------
// - 配置优先环境变量 > config.json > 默认值
// - 安全默认：仅绑定 127.0.0.1，避免局域网暴露
// - 多账号：支持手动切换、浏览器 OAuth 登录、按 5 小时额度自动轮换（≥90% 切换）
// - 浏览器 OAuth 登录 / auth.json 读取 / openBrowser 已拆至 auth-browser.ts，
//   此处 re-export 保持既有 import（dashboard.ts、index.ts 等）路径不变
// =============================================================================
import fs from 'fs';
import path from 'path';
import net from 'net';
import dns from 'dns';
import crypto from 'crypto';
import { GatewayConfig, GatewayConfigFile, AccountInfo } from '../types/index.js';
import { logger } from './logger.js';
import { notify } from './notifier.js';
import { getProjectRootDir } from './paths.js';
import { loadDefaultApiKeyFromEnvOrSystem } from './auth-browser.js';

// 路径解析收敛到 paths.ts（logger 也依赖它，避免循环导入）；此处保持再导出
// 兼容既有 import（dashboard.ts 等）。
export { getProjectRootDir };

// 浏览器 OAuth 登录 / auth.json 读取 / openBrowser 已拆至 auth-browser.ts；
// re-export 保持既有 import 路径不变（loadConfig / getActiveApiKey 内部
// 仍使用 loadDefaultApiKeyFromEnvOrSystem）。
export { loadDefaultApiKeyFromEnvOrSystem, openBrowser, startBrowserLoginFlow } from './auth-browser.js';

/** 项目根目录：pkg 打包产物取 exe 所在目录，源码运行取 cwd。 */
export const CONFIG_FILE_PATH = process.env.COMMANDCODE_CONFIG_PATH
  ? path.resolve(process.env.COMMANDCODE_CONFIG_PATH)
  : path.join(getProjectRootDir(), 'config.json');
// 与 CONFIG_FILE_PATH 同一套隔离约定。缺了它，.env 会无视 COMMANDCODE_CONFIG_PATH
// 落到项目根 —— 而 .env 里存的是明文上游 key（见 saveEnvFile），测试与从
// Program Files 运行的打包产物都会把凭据写进各自的工作目录。
const ENV_FILE_PATH = process.env.COMMANDCODE_ENV_FILE_PATH
  ? path.resolve(process.env.COMMANDCODE_ENV_FILE_PATH)
  : path.join(getProjectRootDir(), '.env');

const DEFAULTS = {
  port: 9090,
  host: '127.0.0.1',
  apiBase: 'https://api.commandcode.ai',
  ccVersion: '1.27.1',
  rotationMode: 'manual' as const,
  // 挂钟总时限。4.18.0 起该配置才真正被执行（此前 0 个消费点），因此默认值必须明显
  // 高于真实长尾：编码 agent 的单次请求带上大上下文可以合理跑过 10 分钟。
  // 注意 0 不等于"不限制"——下面用的是 `||`，0 会回落到本默认值。
  upstreamTimeoutMs: 1_800_000,
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
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true;                       // 127.0.0.0/8 回环
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试保留
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
 * base 用于解析相对 URL（重定向 Location 场景）。
 */
export function assertSafeUpstreamUrl(rawUrl: string, base?: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(rawUrl), base);
  } catch (e: any) {
    throw new Error(`[NET] Invalid upstream URL: ${e?.message || 'parse error'}`, { cause: e });
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

/**
 * 校验重定向目标（Wave 3 SSRF）：在 assertSafeUpstreamUrl 基线之上，强制拒绝
 * 私网/回环/保留地址（含 169.254.169.254 等云元数据）。重定向是唯一能绕过
 * "初始 URL 校验"的通道——即使主机被 COMMANDCODE_UPSTREAM_ALLOWED_HOSTS 显式
 * 放行，也不得作为重定向目标。本规则 fail-closed 且不提供任何开关。
 */
export function assertSafeUpstreamRedirectTarget(rawUrl: string, base?: string | URL): URL {
  const url = assertSafeUpstreamUrl(rawUrl, base);
  if (isPrivateOrReserved(normalizeHost(url.hostname))) {
    throw new Error(`[NET] Redirect target is private/loopback/reserved and can never be followed: ${url.hostname}`);
  }
  return url;
}

/**
 * Wave 3（DNS rebinding）：请求前解析上游域名并校验解析结果。assertSafeUpstreamUrl
 * 只能校验 URL 字面里的 host——攻击者控制的域名可以先解析到公网 IP 通过校验，实际
 * 请求时再解析到内网地址（DNS rebinding）。默认 on；DNS_REBINDING_GUARD=off 显式回退。
 * 跳过解析校验的三类 host（无 rebinding 可能或已显式信任）：
 *   - IP 字面量（安全性由 assertSafeUpstreamUrl + allowlist 决定）
 *   - localhost 等回环主机（恒解析为回环，是本地 mock / 自建网关的合法形态）
 *   - COMMANDCODE_UPSTREAM_ALLOWED_HOSTS 命中的主机（运维显式信任即显式放行）
 * 残余风险（已知且刻意接受）：lookup 与 fetch 真正建连之间存在 TOCTOU 窗口，彻底
 * 封闭需要固定解析结果建连（自定义 undici Agent），当前按"请求前校验"档位实现。
 */
export async function assertSafeUpstreamDns(rawUrl: string): Promise<void> {
  if ((process.env.DNS_REBINDING_GUARD || '').trim().toLowerCase() === 'off') return;
  const url = new URL(String(rawUrl));
  const host = normalizeHost(url.hostname);
  if (!host || net.isIP(host) || isLoopback(host) || hostInExtraAllowlist(host)) return;
  const addresses = await dns.promises.lookup(host, { all: true });
  const bad = addresses.find(a => isPrivateOrReserved(normalizeHost(a.address)));
  if (bad) {
    throw new Error(
      `Upstream host '${host}' resolves to private/reserved address ${bad.address} ` +
      `(DNS rebinding guard; set DNS_REBINDING_GUARD=off to skip)`,
    );
  }
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

/**
 * 解析项目根的 .env（KEY=VALUE、# 注释、成对引号），**已存在的环境变量优先**，
 * 因此 docker/systemd 等外部注入不受影响。与 syncEnvFile 的写入形成闭环：
 * 仪表盘添加账号后 .env 会同步最新 Key，重启即生效，无需手动 export。
 */
let envLoaded = false;
function loadEnvFileOnce(): void {
  if (envLoaded) return;
  envLoaded = true;
  try {
    if (!fs.existsSync(ENV_FILE_PATH)) return;
    for (const raw of fs.readFileSync(ENV_FILE_PATH, 'utf-8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (err: any) {
    logger.warn(`[CONFIG] Could not load .env: ${err.message}`);
  }
}

/** config.json 的 mtime 缓存：文件未变时跳过每请求的读盘+解析。 */
let configFileCache: { mtimeMs: number; size: number; data: Partial<GatewayConfigFile> } | null = null;

function readFileConfig(): Partial<GatewayConfigFile> {
  try {
    if (!fs.existsSync(CONFIG_FILE_PATH)) {
      configFileCache = null;
      return {};
    }
    const st = fs.statSync(CONFIG_FILE_PATH);
    if (configFileCache && configFileCache.mtimeMs === st.mtimeMs && configFileCache.size === st.size) {
      return configFileCache.data;
    }
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8')) as Partial<GatewayConfigFile>;
    configFileCache = { mtimeMs: st.mtimeMs, size: st.size, data };
    return data;
  } catch (err: any) {
    logger.error(`[CONFIG] Error reading config.json: ${err.message}`);
    return {};
  }
}

export function loadConfig(): GatewayConfig {
  loadEnvFileOnce();
  const fileConfig = readFileConfig();

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
  const accounts: AccountInfo[] = Array.isArray(fileConfig.accounts) ? fileConfig.accounts : [];
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
    activeAccountId,
    accounts,
    upstreamTimeoutMs: fileConfig.upstream?.timeoutMs || DEFAULTS.upstreamTimeoutMs,
    idleTimeoutMs: fileConfig.upstream?.idleTimeoutMs || DEFAULTS.idleTimeoutMs,
    maxRetries: fileConfig.upstream?.maxRetries ?? DEFAULTS.maxRetries,
  };
}

/**
 * 原子化写入 config.json（临时文件 + rename），避免崩溃时截断配置。
 *
 * 返回是否真的落盘。此前返回 void 且吞掉一切异常，调用方（含全部仪表盘写端点）
 * 于是无条件向用户报 success —— exe 装在 Program Files、目标盘只读或杀软锁文件时
 * 写入失败，用户看到"账号已添加"，重启后账号消失且请求仍在用旧 Key。
 */
export function saveConfigFile(updates: Partial<GatewayConfigFile>): boolean {
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
      accounts: updates.accounts ?? current.accounts ?? [],
      upstream: {
        apiBase: updates.upstream?.apiBase ?? current.upstream?.apiBase ?? DEFAULTS.apiBase,
        ccVersion: updates.upstream?.ccVersion ?? current.upstream?.ccVersion ?? DEFAULTS.ccVersion,
        timeoutMs: updates.upstream?.timeoutMs ?? current.upstream?.timeoutMs ?? DEFAULTS.upstreamTimeoutMs,
        idleTimeoutMs: updates.upstream?.idleTimeoutMs ?? current.upstream?.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
        maxRetries: updates.upstream?.maxRetries ?? current.upstream?.maxRetries ?? DEFAULTS.maxRetries,
      },
    };

    // 临时文件名带 pid：固定名在两个实例共用同一数据目录时会互相踩，且 Windows 上
    // rename 覆盖被对方打开的文件会 EPERM。
    const tmp = `${CONFIG_FILE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8');
    fs.renameSync(tmp, CONFIG_FILE_PATH);

    const activeAcc = (updated.accounts || []).find(a => a.id === updated.activeAccountId);
    // 没有活跃凭据时也必须同步：条件式跳过会让上一个（已删除的）Key 原样留在 .env 里，
    // 下次启动被重新导入并合成 acc_default。
    syncEnvFile(
      updated.accounts || [],
      activeAcc?.apiKey || '',
      // 只镜像配置文件里**真正写了**的值，不写 DEFAULTS 兜底后的值：env 优先级高于
      // config.json，把默认值固化进 .env 等于让自建上游端点在一次账号操作后、于下次
      // 重启被静默改回公网默认。没有这一行时 loadConfig 自然回落到代码默认，行为不变。
      updates.upstream?.apiBase ?? current.upstream?.apiBase,
      updates.upstream?.ccVersion ?? current.upstream?.ccVersion
    );
    return true;
  } catch (err: any) {
    logger.error(`[CONFIG] Error saving config.json: ${err.message}`);
    return false;
  }
}

function syncEnvFile(
  accounts: AccountInfo[],
  activeApiKey: string,
  apiBase?: string,
  ccVersion?: string
): void {
  try {
    const envLines = [
      // 无活跃 Key 时整条消失，而不是留着旧值。
      ...(activeApiKey ? [`COMMANDCODE_API_KEY=${activeApiKey}`] : []),
      ...(apiBase ? [`COMMANDCODE_API_BASE=${apiBase}`] : []),
      ...(ccVersion ? [`COMMANDCODE_VERSION=${ccVersion}`] : []),
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

export function setActiveAccount(accountId: string): boolean {
  const config = loadConfig();
  const target = config.accounts.find(a => a.id === accountId);
  if (!target) return false;
  if (!saveConfigFile({ activeAccountId: accountId })) return false;
  logger.info(`[AUTH] Switched active account to: ${target.name} (${target.id})`);
  return true;
}

export function setRotationMode(mode: 'manual' | 'auto-quota'): boolean {
  if (!saveConfigFile({ rotationMode: mode })) return false;
  logger.info(`[AUTH] Changed key rotation mode to: ${mode}`);
  return true;
}

export async function loginNewAccount(apiKey: string, name?: string): Promise<AccountInfo> {
  const config = loadConfig();
  const cleanKey = apiKey.trim();

  const existing = config.accounts.find(a => a.apiKey === cleanKey);
  if (existing) {
    if (!setActiveAccount(existing.id)) {
      throw new Error('切换已有账号失败：config.json 写入未成功');
    }
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

  const persisted = saveConfigFile({
    accounts: [...config.accounts, newAcc],
    activeAccountId: id,
  });
  if (!persisted) {
    // 上游已确认这条凭据有效，但本地没落盘。若照常返回，UI 会显示"已登录"、
    // 后续请求继续用旧 Key、重启后账号消失 —— 这种半成功必须作为失败冒出来。
    throw new Error('凭据校验通过，但 config.json 写入失败：请检查数据目录是否可写'
      + '（装在 Program Files 下、只读盘或杀软锁定都会触发）');
  }

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
  const target = config.accounts.find(a => a.id === accountId);
  const updatedAccounts = config.accounts.filter(a => a.id !== accountId);
  let newActiveId = config.activeAccountId;

  if (newActiveId === accountId) {
    newActiveId = updatedAccounts.length > 0 ? updatedAccounts[0].id : '';
  }

  if (!saveConfigFile({ accounts: updatedAccounts, activeAccountId: newActiveId })) return false;

  // 磁盘上的 .env 由 saveConfigFile 收掉了，进程内的兜底还得单独收：
  // getActiveApiKey() 在账号表为空时回落到 loadDefaultApiKeyFromEnvOrSystem()，
  // 只清文件挡不住本次运行 —— 删掉的账号会继续用那条 Key 发请求、烧它的额度。
  // 只在确实与本次删除的是同一条 Key 时清（不碰 shell 里显式设置的、以及
  // auth.json 系统登录态的来源）。
  if (target?.apiKey && process.env.COMMANDCODE_API_KEY === target.apiKey
      && !updatedAccounts.some(a => a.apiKey === target.apiKey)) {
    delete process.env.COMMANDCODE_API_KEY;
    logger.info(`[AUTH] Cleared in-process fallback key of removed account '${accountId}'`);
  }

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
          // 换号会改变后续请求的归属与额度池，用户通常不在面板前，需主动告知。
          notify('account-switched', 'CommandCode 已切换账号', `额度不足，已切换到 '${altAcc.name}'（余量 ${(100 - altRatio * 100).toFixed(0)}%）`, 'warn');
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

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<any | null> {
  let safeUrl: string;
  try {
    safeUrl = assertSafeUpstreamUrl(url).toString();
    await assertSafeUpstreamDns(safeUrl);
  } catch (err: any) {
    logger.warn(`[USAGE] Blocked unsafe upstream URL: ${err.message}`);
    return null;
  }
  try {
    // Wave 3（SSRF）：3xx 不跟随，res.ok 为 false 走下方返回 null 的失败分支
    const res = await fetch(safeUrl, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' } as RequestInit);
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

// ─── 用量统计缓存（45s TTL + 并发去重）───────────────────────────────────────
// 仪表盘切一次用量页会对同一账号触发 overview + aggregate 两轮统计（每轮 4 个
// 上游请求）；这些数据 45 秒内不会变化，缓存掉重复。登录、额度轮换等需要新鲜
// 值的场景继续用未缓存的 fetchLiveUsageStats。

const LIVE_STATS_TTL_MS = 45_000;
const liveStatsCache = new Map<string, { at: number; data: any }>();
const liveStatsInflight = new Map<string, Promise<any>>();

export async function fetchLiveUsageStatsCached(apiKey: string, ccApiBase: string, ccVersion: string): Promise<any> {
  const key = `${apiKey}|${ccApiBase}|${ccVersion}`;
  const hit = liveStatsCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_STATS_TTL_MS) return hit.data;

  const inflight = liveStatsInflight.get(key);
  if (inflight) return inflight;

  const p = fetchLiveUsageStats(apiKey, ccApiBase, ccVersion)
    .then(data => {
      liveStatsCache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      liveStatsInflight.delete(key);
      // 缓存条目有界：账号通常个位数，防御性丢弃最旧条目
      if (liveStatsCache.size > 64) {
        const oldest = [...liveStatsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) liveStatsCache.delete(oldest[0]);
      }
    });
  liveStatsInflight.set(key, p);
  return p;
}

/**
 * 只拉额度（credits）以采样窗口用量 —— 供燃烧速率预测定期采样用。
 * 与 fetchLiveUsageStats 的区别：不拉 whoami/subscriptions/summary，
 * 把高频轮询的上游开销降到最低。失败返回 null（采样允许缺失）。
 */
export async function fetchWindowLimits(apiKey: string, ccApiBase: string, ccVersion: string): Promise<any | null> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'cli',
    'x-cli-environment': 'cli',
    'x-command-code-version': ccVersion,
  };
  const credits = await fetchJson(`${ccApiBase}/alpha/billing/credits`, headers);
  return credits?.windowLimits ?? null;
}
