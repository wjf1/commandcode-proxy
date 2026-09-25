// =============================================================================
// 流水线阶段 2：受控请求
// -----------------------------------------------------------------------------
// 职责：
//   1. 入口安全检查：上游 URL 字面校验 + DNS 解析结果校验（resolveUpstreamEntryUrl）。
//   2. 受控 fetch：一律 redirect:'manual'，SSRF 逐跳校验重定向目标
//      （fetchWithRedirectGuard）。
//
// 状态归属：函数无隐藏的可变闭包变量——headers 的跨 host 凭据剥离发生在本模块
// 内部的局部副本上，不影响编排层持有的初始 headers；日志上下文（model/threadId）
// 由编排层显式传入。
// =============================================================================
import { assertSafeUpstreamUrl, assertSafeUpstreamRedirectTarget, assertSafeUpstreamDns } from '../../../utils/config.js';
import { logger } from '../../../utils/logger.js';
import { ErrorCode } from '../../../utils/errors.js';
import { UpstreamError } from './errors.js';

/**
 * 解析并校验上游入口 URL（字面校验 + Wave 3 DNS 解析结果校验）。
 * 不通过时记日志并抛 BLOCKED_HOST 的 UpstreamError（不可重试）。
 */
export async function resolveUpstreamEntryUrl(ccApiBase: string): Promise<string> {
  try {
    const url = assertSafeUpstreamUrl(`${ccApiBase}/alpha/generate`).toString();
    // Wave 3（DNS rebinding）：域名解析结果校验，防"字面公网域名实际解析进内网"。
    await assertSafeUpstreamDns(url);
    return url;
  } catch (err: any) {
    logger.error(`[UPSTREAM] Blocked unsafe upstream URL: ${err.message}`);
    throw new UpstreamError(`Unsafe upstream URL: ${err.message}`, undefined, false, ErrorCode.BLOCKED_HOST);
  }
}

export interface ControlledRequestArgs {
  /** 已通过入口安全校验的上游 URL（本次尝试的起点）。 */
  url: string;
  /** 本次尝试的请求头；跨 host 跳转时在内部副本上剥离凭据，外部传入值不被修改。 */
  headers: Record<string, string>;
  /** 序列化好的请求体。 */
  body: string;
  /** 阶段 1 装配好的合并信号（客户端中止 + 挂钟/空闲超时）。 */
  signal: AbortSignal;
  /** 日志上下文。 */
  model: string;
  threadId: string;
}

/**
 * 发起受控 POST：一律 redirect:'manual'，并对每一跳重定向做 SSRF 校验。
 * 返回首个非 3xx 响应；3xx 的处理（阻断/跟随）见内部分支。
 */
export async function fetchWithRedirectGuard(args: ControlledRequestArgs): Promise<Response> {
  let { headers } = args;

  // Wave 3（SSRF）：一律 redirect:'manual'。Node fetch 默认 follow，被攻击者控制的
  // 上游可用 302 把带凭据的请求引向 169.254.169.254 等内网/元数据地址，绕过对初始
  // URL 的校验。默认 conservative：3xx 按上游错误终止；UPSTREAM_REDIRECT=follow
  // 显式放行后逐跳校验目标（私网/保留地址永不跟随，不受 allowlist 影响），同 host
  // 跳转保留 POST 与请求体（API 重定向唯一合理场景是网关迁移，body 不可丢），跨
  // host 跳转剥离凭据头，防止 Authorization 被引到第三方。
  const redirectMode = (process.env.UPSTREAM_REDIRECT || '').trim().toLowerCase() === 'follow' ? 'follow' : 'conservative';
  const MAX_REDIRECT_HOPS = 5;
  let currentUrl = args.url;
  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    res = await fetch(currentUrl, {
      method: 'POST',
      headers,
      body: args.body,
      signal: args.signal,
      redirect: 'manual',
    } as RequestInit);
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get('location');
    try { await res.body?.cancel(); } catch { /* 3xx 响应体释放失败不影响主流程 */ }
    if (redirectMode !== 'follow' || !location || hop >= MAX_REDIRECT_HOPS) {
      logger.error(
        `[UPSTREAM] Model: ${args.model} | Thread ${args.threadId} | ` +
        `Redirect ${res.status} to ${location || '<no Location>'} blocked (UPSTREAM_REDIRECT=${redirectMode})`,
      );
      throw new UpstreamError(
        `Upstream redirect ${res.status} blocked (UPSTREAM_REDIRECT=${redirectMode})`,
        res.status,
        false,
        ErrorCode.PROVIDER_PROTOCOL_ERROR,
      );
    }
    const prevHost = new URL(currentUrl).host;
    let nextUrl: URL;
    try {
      nextUrl = assertSafeUpstreamRedirectTarget(location, currentUrl);
      await assertSafeUpstreamDns(nextUrl.toString());
    } catch (err: any) {
      // 不可重试的 BLOCKED_HOST：私网/元数据目标与 rebinding 域名没有重试价值。
      throw new UpstreamError(`Blocked redirect target: ${err.message}`, undefined, false, ErrorCode.BLOCKED_HOST);
    }
    if (nextUrl.host !== prevHost) {
      const hopHeaders: Record<string, string> = { ...headers };
      for (const k of Object.keys(hopHeaders)) {
        if (k.toLowerCase() === 'authorization') delete hopHeaders[k];
      }
      headers = hopHeaders;
    }
    currentUrl = nextUrl.toString();
  }
  return res as Response;
}
