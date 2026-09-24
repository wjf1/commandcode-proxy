// =============================================================================
// 上游 URL 安全校验（SSRF 加固）
// -----------------------------------------------------------------------------
// 自 config.ts 原样搬出（架构 Phase 1 拆分），公共行为零变化。
// 依赖方向：仅依赖 node 内置模块（net / dns），无项目内依赖，单向无环。
// COMMANDCODE_UPSTREAM_ALLOWED_HOSTS 环境变量的读取逻辑（hostInExtraAllowlist）
// 随函数一并搬至本文件。
//
// 所有服务端发起的上游请求（fetch / 用量统计 / 模型同步 / pricing 页）都必须
// 先经过 assertSafeUpstreamUrl 校验，防止：
//   - 注入非 http(s) 协议（file:、gopher: 等协议混淆）
//   - 在 URL 内嵌凭据（user:pass@host）
//   - 访问任意非授权主机（SSRF）
// 默认只允许 commandcode.ai 及其子域 + 回环地址；若用户配置了自建网关/镜像，
// 可通过环境变量 COMMANDCODE_UPSTREAM_ALLOWED_HOSTS 追加允许的 host（逗号分隔）。
// =============================================================================
import net from 'net';
import dns from 'dns';

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
