// =============================================================================
// 请求速率限制（默认关闭 —— RATE_LIMIT_RPM / RATE_LIMIT_TPM 均未设置时零开销旁路）
// -----------------------------------------------------------------------------
// - 滑动窗口（60s）内存计数：每 key 一列 {ts, tokens} 事件；check 时惰性清理
//   本 key 过期事件，并按需（距上次 ≥60s）做一次全表 sweep 防 Map 无限增长。
//   无定时器，测试与进程退出零干扰。
// - key：客户端 API key 末 4 位（Bearer / x-api-key），无凭据回落 'global'。
//   只存尾号，绝不存全量密钥。
// - env 均在调用时读取：RATE_LIMIT_RPM（每分钟请求数）、RATE_LIMIT_TPM（每分钟
//   token 数）。两者都未设置 = 功能完全关闭：不拦截、不记账、零 IO。
// - TPM 口径：入口按消息文本字段粗估 input（复用 estimateTextTokens，不序列化
//   整个 body —— 图片 base64 一旦计入，一张截图就能把 TPM 顶穿）；流结束后的
//   实际 output tokens 由 recordRequestOutput 在请求收敛点补记。粗估只含文本
//   字段，不含 tools/图片额度，偏保守低估。
// - 超限返回 429：复用 errors.ts 既有 RATE_LIMIT 码（429 / rate_limit_error，
//   OpenAI 与 Anthropic 两种出口形态由 ProxyError 保证一致），响应头带
//   Retry-After（窗口内最老事件的剩余存活秒数）。被拒请求不计入窗口。
// - 错误码决策：errors.ts 已有 429/限流语义的 RATE_LIMIT 码，直接复用，不再
//   追加 RATE_LIMITED —— errors.ts 的 STATUS/TYPE/HINTS 映射是封闭的
//   Record<ErrorCodeName, ...>，外部新增码拿不到正确 status/type。
// =============================================================================
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ErrorCode, ProxyError } from './errors.js';
import { estimateTextTokens } from '../adapters/commandcode/upstream.js';
import { auditReject } from './audit-log.js';

const WINDOW_MS = 60_000;

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSec?: number;
  reason?: string;
}

interface WindowEvent {
  ts: number;
  tokens: number;
}

const windows = new Map<string, WindowEvent[]>();
/** 放行请求的限流 key（弱关联），供 recordRequestOutput 在收尾时补记 output。 */
const pendingKeys = new WeakMap<object, string>();
let lastSweepAt = 0;

/** 测试钩子：清空窗口（内存 Map 跨用例共享，避免串扰）。 */
export function __testReset(): void {
  windows.clear();
  lastSweepAt = 0;
}

/** 测试钩子：当前有记账的 key 数，供内存清理断言。 */
export function __trackedKeys(): number {
  return windows.size;
}

function intEnv(name: string): number | undefined {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 客户端限流 key：API key 末 4 位（Bearer / x-api-key）；无凭据 → 'global'。 */
export function rateLimitKeyOf(req: { headers: unknown }): string {
  const h = (req?.headers ?? {}) as Record<string, unknown>;
  const auth = String(h.authorization ?? '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const xKey = String(h['x-api-key'] ?? '').trim();
  const key = bearer || xKey;
  return key ? key.slice(-4) : 'global';
}

function sweepAll(now: number): void {
  if (now - lastSweepAt < WINDOW_MS) return;
  lastSweepAt = now;
  for (const [k, events] of windows) {
    const fresh = events.filter((e) => e.ts > now - WINDOW_MS);
    if (fresh.length === 0) windows.delete(k);
    else if (fresh.length !== events.length) windows.set(k, fresh);
  }
}

/**
 * 滑动窗口限流检查。功能关闭（两个 env 均未设）恒放行且不记账。
 * estimatedTokens 为本次请求的 input 预估；允许时计入窗口。
 */
export function checkRateLimit(key: string, estimatedTokens = 0): RateLimitVerdict {
  const rpm = intEnv('RATE_LIMIT_RPM');
  const tpm = intEnv('RATE_LIMIT_TPM');
  if (rpm === undefined && tpm === undefined) return { allowed: true };

  const now = Date.now();
  sweepAll(now);

  const events = (windows.get(key) ?? []).filter((e) => e.ts > now - WINDOW_MS);
  if (rpm !== undefined && events.length + 1 > rpm) {
    windows.set(key, events); // 被拒请求不计入窗口
    const oldest = events[0]?.ts ?? now;
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
      reason: `Rate limit exceeded: more than ${rpm} requests per minute for this client.`,
    };
  }
  if (tpm !== undefined) {
    const used = events.reduce((s, e) => s + e.tokens, 0);
    if (used + Math.max(0, estimatedTokens) > tpm) {
      windows.set(key, events);
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - (now - (events[0]?.ts ?? now))) / 1000)),
        reason: `Token rate limit exceeded: more than ${tpm} tokens per minute for this client.`,
      };
    }
  }
  events.push({ ts: now, tokens: Math.max(0, Math.floor(estimatedTokens)) });
  windows.set(key, events);
  return { allowed: true };
}

/** 请求收敛点调用：把流结束后的实际 output tokens 补记进该请求的窗口事件。 */
export function recordOutputTokens(key: string, tokens: number): void {
  const n = Math.max(0, Math.floor(tokens || 0));
  if (!n) return;
  const events = windows.get(key);
  if (!events?.length) return; // 功能关闭或该请求未记账：空操作
  events[events.length - 1].tokens += n;
}

/**
 * 请求体 input tokens 粗估：只数消息文本字段（与 estimateTextTokens 同源口径），
 * 不序列化整个 body —— base64 图片一旦计入会凭空造出几十万 token。
 */
function estimateBodyTokens(body: unknown): number {
  const b = body as any;
  if (!b || typeof b !== 'object') return 0;
  const chunks: string[] = [];
  const push = (s: unknown): void => {
    if (typeof s === 'string' && s) chunks.push(s);
  };
  if (typeof b.system === 'string') push(b.system);
  else if (Array.isArray(b.system)) for (const part of b.system) push(part?.text);
  const messages = Array.isArray(b.messages) ? b.messages : [];
  for (const m of messages) {
    if (typeof m?.content === 'string') push(m.content);
    else if (Array.isArray(m?.content)) for (const p of m.content) push(p?.text);
  }
  return estimateTextTokens(chunks.join('\n'));
}

/**
 * 路由早期守卫（鉴权之后、转发上游之前）：限流检查 + 被拒时直接响应
 * （429 + Retry-After，按出口形态选 OpenAI / Anthropic 信封，并落审计行）。
 * 返回 true 表示已拒绝并写完响应，handler 应立即 return。
 */
export function guardRateLimit(req: FastifyRequest, reply: FastifyReply): boolean {
  if (intEnv('RATE_LIMIT_RPM') === undefined && intEnv('RATE_LIMIT_TPM') === undefined) return false;
  const key = rateLimitKeyOf(req);
  const verdict = checkRateLimit(key, estimateBodyTokens(req.body));
  if (verdict.allowed) {
    pendingKeys.set(req as object, key);
    return false;
  }
  auditReject(req, 'RATE_LIMITED', (req.body as any)?.model ?? null);
  const err = new ProxyError(ErrorCode.RATE_LIMIT, verdict.reason ?? 'Rate limit exceeded.');
  reply.header('Retry-After', String(verdict.retryAfterSec ?? 60));
  if (req.url.startsWith('/v1/messages')) reply.status(err.status).send(err.anthropicPayload());
  else reply.status(err.status).send({ error: err.openAIPayload() });
  return true;
}

/** 请求收尾时把实际 output tokens 记入限流窗口（功能关闭或未记账时为空操作）。 */
export function recordRequestOutput(req: object, tokens: number): void {
  const key = pendingKeys.get(req);
  if (key) recordOutputTokens(key, tokens);
}
