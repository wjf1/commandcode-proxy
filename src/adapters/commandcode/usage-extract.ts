// =============================================================================
// CC 事件上的 usage 与错误消息提取（原 adapter.ts 职责模块化）
// -----------------------------------------------------------------------------
// OpenAI 流式编码与 Anthropic 非流式构建都要从 finish 事件里取 usage、把 error
// 事件转成可读文本；两条路径的提取细节不同（OpenAI 侧多查 code/error 字段），
// 因此各自成对导出、互不抽象 —— 原样搬迁，逻辑零改动。
// =============================================================================

/**
 * finish / finish-step 事件里的 usage 对象。
 * Original CLI: usage lives at event.totalUsage; data.usage is legacy.
 */
export function finishUsageOf(event: any): any {
  return event.totalUsage ?? event.data?.usage;
}

/**
 * OpenAI 流式路径的错误文本提取：依次尝试 string / message / code / error（嵌套），
 * 最终形态还可能是 { message }。无可读内容（空或 "unknown"）返回 null —— 与原
 * encodeOpenAIChunk 的行为一致：不产出任何 chunk。
 */
export function openAIUpstreamErrorText(event: any): string | null {
  const errObj = event.error || event;
  const errMsg =
    typeof errObj === 'string'
      ? errObj
      : errObj?.message ||
        errObj?.code ||
        errObj?.error ||
        '';
  const msgStr = typeof errMsg === 'string' ? errMsg : errMsg?.message || '';
  if (!msgStr || msgStr === 'unknown') return null;
  return msgStr;
}

/**
 * Anthropic 非流式路径的错误文本提取：只认 string / message 两形态，
 * 空或 "unknown" 返回 null（不追加错误文本块）。
 */
export function anthropicUpstreamErrorText(event: any): string | null {
  const errObj = event.error || event;
  const errMsg =
    typeof errObj === 'string'
      ? errObj
      : ((errObj?.message as string | undefined) || '');
  if (!errMsg || errMsg === 'unknown') return null;
  return errMsg;
}
