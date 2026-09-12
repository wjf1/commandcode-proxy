// =============================================================================
// chat.ts 与 messages.ts 双出口共享的助手
// -----------------------------------------------------------------------------
// 两个兼容出口的流式处理高度相似：SSE 响应头、上游 SSE 事件行解析、
// 长连接 socket 加固（客户端断开 → 取消上游）、会话记录持久化。
// 收敛到一处，避免双份实现随时间漂移。
// =============================================================================
import { createInterface } from 'readline';
import { FastifyRequest, FastifyReply } from 'fastify';
import { CCEvent } from '../types/index.js';
import { UsageAccumulator } from '../adapters/commandcode/usage.js';
import { RequestContext } from '../utils/request-context.js';
import { estimateCostUsd, recordCompletion } from '../utils/usage-store.js';

export function writeSSEHeaders(reply: any): void {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();
}

/** 解析一行上游 SSE 为一个 CCEvent；空行或 [DONE] 返回 null。 */
export function parseEventLine(line: string): CCEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!jsonStr || jsonStr === '[DONE]') return null;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/** 把一行上游 SSE 变成异步迭代器（非流式路径逐事件消费用）。 */
export function sseLineIterator(stream: any): AsyncIterable<string> {
  return createInterface({ input: stream, crlfDelay: Infinity });
}

/**
 * 长连接加固：禁用 socket 超时 + keepalive（面向多分钟推理的长会话），
 * 并在客户端提前断开时取消上游请求。
 */
export function hardenConnectionForLongStream(
  req: FastifyRequest,
  reply: FastifyReply,
  abortController: AbortController,
): void {
  req.raw.setTimeout(0);
  if (req.raw.socket) {
    req.raw.socket.setTimeout(0);
    req.raw.socket.setKeepAlive(true, 10000);
    req.raw.socket.setNoDelay(true);
  }

  // 仅当客户端在我们写完之前离开时才取消上游。
  const onClientClose = () => {
    if (!reply.raw.writableEnded) abortController.abort();
  };
  req.raw.on('aborted', onClientClose);
  reply.raw.on('close', onClientClose);
}

/**
 * 持久化一次会话记录到 usage-history.jsonl。
 * 成本优先取上游权威金额（上游已算好峰谷价与缓存折扣），缺失时才本地估算。
 */
export function persistCompletion(
  model: string,
  usage: UsageAccumulator,
  context: RequestContext,
  startTime: number,
  status: 'COMPLETED' | 'FAILED',
  traceId?: string,
  mode: 'chat' | 'messages' = 'chat',
): void {
  const estimated = estimateCostUsd(model, usage.inputTokens || 0, usage.outputTokens || 0, {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    at: new Date(startTime),
  });
  const hasUpstreamCost = usage.upstreamCostUsd !== undefined;
  recordCompletion({
    timestamp: new Date().toISOString(),
    model,
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
    cacheReadTokens: usage.cacheReadTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
    timingMs: Date.now() - startTime,
    costUsd: hasUpstreamCost ? usage.upstreamCostUsd! : estimated.costUsd,
    costSource: hasUpstreamCost ? 'official' : 'estimated',
    estimatedCostUsd: estimated.costUsd,
    hasPricing: hasUpstreamCost || estimated.hasPricing,
    status,
    traceId,
    mode,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.project ? { project: context.project } : {}),
    ...(context.projectSource ? { projectSource: context.projectSource } : {}),
    ...(context.sessionType ? { sessionType: context.sessionType } : {}),
    ...(context.agent ? { agent: context.agent } : {}),
    ...(context.timezone ? { timezone: context.timezone } : {}),
  });
}
