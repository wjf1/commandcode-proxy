// =============================================================================
// 模型访问控制（默认关闭 —— MODEL_ALLOWLIST / MODEL_BLOCKLIST 均未设置时全放行）
// -----------------------------------------------------------------------------
// - MODEL_ALLOWLIST / MODEL_BLOCKLIST：逗号分隔的精确模型 id，大小写不敏感、
//   容忍名单项两侧空格。env 在调用时读取，改了即生效。
// - allowlist 优先：设置了 MODEL_ALLOWLIST 则不在名单内的模型一律拒绝（即使
//   blocklist 未设）；未设 allowlist 时才查 MODEL_BLOCKLIST。
// - 空模型名：设了 allowlist 即拒（不在名单内）；仅 blocklist 时放行。
// - 错误码决策：复用 errors.ts 既有 MODEL_NOT_IN_PLAN（403 / permission_error，
//   现有体系里最贴近"该模型不可用"的码）。不追加 MODEL_BLOCKED —— errors.ts 的
//   STATUS/OPENAI_TYPE/ANTHROPIC_TYPE/HINTS 映射是封闭的 Record<ErrorCodeName, ...>，
//   外部新增码拿不到正确的 status 与 error.type（信封会缺字段），自建 payload
//   又会复制错误信封逻辑，故复用并在 message 里写明 allowlist/blocklist 原因。
// =============================================================================
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ErrorCode, ProxyError } from './errors.js';
import { auditReject } from './audit-log.js';

function parseList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 访问判定：allowlist 优先，其次 blocklist；均未设置全放行。大小写不敏感。 */
export function checkModelAccess(model: string): { allowed: boolean; reason?: string } {
  const allow = parseList('MODEL_ALLOWLIST');
  const block = parseList('MODEL_BLOCKLIST');
  if (allow.length === 0 && block.length === 0) return { allowed: true };
  const m = String(model ?? '').trim().toLowerCase();
  if (allow.length > 0) {
    if (m && allow.includes(m)) return { allowed: true };
    return { allowed: false, reason: `not in MODEL_ALLOWLIST (${allow.join(', ')})` };
  }
  if (block.includes(m)) {
    return { allowed: false, reason: `blocked by MODEL_BLOCKLIST (${block.join(', ')})` };
  }
  return { allowed: true };
}

/**
 * 路由早期守卫（鉴权之后、转发上游之前）：按请求体的 model 字段做访问控制，
 * 被拒时直接响应（403，按出口形态选 OpenAI / Anthropic 信封，并落审计行）。
 * 返回 true 表示已拒绝并写完响应，handler 应立即 return。
 */
export function guardModelAccess(req: FastifyRequest, reply: FastifyReply): boolean {
  const model = String((req.body as any)?.model ?? '').trim();
  const verdict = checkModelAccess(model);
  if (verdict.allowed) return false;
  auditReject(req, 'MODEL_FORBIDDEN', model || null);
  const err = new ProxyError(
    ErrorCode.MODEL_NOT_IN_PLAN,
    `Model "${model}" is rejected by the gateway access policy: ${verdict.reason}. Adjust MODEL_ALLOWLIST / MODEL_BLOCKLIST to change it.`,
  );
  if (req.url.startsWith('/v1/messages')) reply.status(err.status).send(err.anthropicPayload());
  else reply.status(err.status).send({ error: err.openAIPayload() });
  return true;
}
