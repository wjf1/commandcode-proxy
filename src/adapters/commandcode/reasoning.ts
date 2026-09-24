// =============================================================================
// 推理强度（reasoning effort）求解 + max_tokens 钳制（原 adapter.ts 职责模块化）
// -----------------------------------------------------------------------------
// 从 adapter.ts 原样搬迁，逻辑零改动；adapter.ts 的 CommandCodeAdapter 委托至此。
// =============================================================================

// ─── max_tokens 钳制（按 CLI wire 契约）────────────────────────────────────────
// CC wire 的 schema 校验对 params.max_tokens 有全局硬上限 200000（上游 zod 报
// "Too big: expected number to be <=200000"）。宿主（如 ZCode）可能按模型上下文
// 窗口推导 max_tokens 而超过该值，导致整轮请求 400。这里统一向下钳制，而不是
// 让请求打到上游被拒。
export const CC_WIRE_MAX_TOKENS_CAP = 200000;

export function clampMaxTokens(v: number): number {
  return Math.max(1, Math.min(v, CC_WIRE_MAX_TOKENS_CAP));
}

// ─── 推理强度（reasoning effort）映射表（按 CLI wire 契约）───────────────────────
// 不同模型支持不同的推理档位。请求方传入的 reasoning_effort 会被"向下就近对齐"
// 到该模型实际支持的档位，避免上游 400。档位从弱到强：
//   Qn = low < medium < high < xhigh < max          （五档 SOTA 系列）
//   Xn = low < medium < high < xhigh                （四档）
//   Zn = low < medium < high                        （三档）
//   er = high < max                                 （两档，DeepSeek 等）

const Qn = ['low', 'medium', 'high', 'xhigh', 'max'];
const Xn = ['low', 'medium', 'high', 'xhigh'];
const Zn = ['low', 'medium', 'high'];
const er = ['high', 'max'];

// 原版 CLI（fr map）：GLM-5.3 支持 low/high/max —— 而不是 er 集合。
const OFFICIAL_REASONING_MAP: Record<string, string[]> = {
  'claude-sonnet-5': Qn,
  'claude-sonnet-4-6': Qn,
  'claude-fable-5': Qn,
  'claude-opus-5': Qn,
  'claude-opus-4-8': Qn,
  'claude-opus-4-7': Qn,
  'gpt-5.6-sol': Qn,
  'gpt-5.6-terra': Qn,
  'gpt-5.6-luna': Qn,
  'gpt-5.5': Xn,
  'gpt-5.4': Xn,
  'gpt-5.3-codex': Xn,
  'gpt-5.4-mini': Zn,
  'deepseek/deepseek-v4-pro': er,
  'deepseek/deepseek-v4-flash': er,
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
  'zai-org/GLM-5.2': er,
  'zai-org/GLM-5': er,
  'google/gemini-3.7-flash': Zn,
  'google/gemini-3.6-flash': Zn,
  'google/gemini-3.5-flash': Zn,
  'google/gemini-3.5-flash-lite': Zn,
  'google/gemini-3.1-flash-lite': Zn,
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'xai/grok-4.6': Xn,
  'xai/grok-4.5': Zn,
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
};

// 每个档位的数值权重，用于"向下就近对齐"：请求档位权重 > 模型支持档位权重时，
// 挑选模型支持的、权重不超过请求档位中最接近的一个。
const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 5,
};

/**
 * 求解最终发送到 CC 的 reasoning_effort 档位。
 * 有三种输入来源，优先级从高到低：
 *  1) Anthropic 的 thinking 配置（type=enabled 时按 budget_tokens 映射档位）
 *  2) 请求方显式传入的 reasoning_effort（字符串或数字）
 *  3) 未传入 → 不输出该字段（原版 CLI 行为：不会默认补 medium）
 * 处理逻辑：
 *  - 先查模型专属支持表；查不到再按模型名关键字推断默认支持档位；
 *  - 对不在支持表内的档位，做"向下就近对齐"（snap down）到最近的可支持档位；
 *  - 数字型档位按 OpenAI 式阈值映射。
 */
export function resolveReasoningEffort(model: string, requested?: any, thinkingConfig?: any): string | undefined {
  if (thinkingConfig && thinkingConfig.type === 'enabled') {
    const budget = thinkingConfig.budget_tokens ?? 2048;
    if (budget >= 16000) return 'max';
    if (budget >= 8000) return 'high';
    if (budget >= 4000) return 'medium';
    return 'low';
  }

  let supported = OFFICIAL_REASONING_MAP[model];
  if (!supported) {
    const modelLower = model.toLowerCase();
    if (
      modelLower.includes('deepseek') ||
      modelLower.includes('glm-') ||
      modelLower.includes('grok') ||
      modelLower.includes('reasoner') ||
      modelLower.includes('thinking') ||
      modelLower.includes('o1') ||
      modelLower.includes('o3') ||
      modelLower.includes('qwq') ||
      modelLower.includes('laguna') ||
      modelLower.includes('inkling') ||
      modelLower.includes('step') ||
      modelLower.includes('kimi') ||
      modelLower.includes('qwen') ||
      modelLower.includes('claude-sonnet') ||
      modelLower.includes('claude-opus') ||
      modelLower.includes('gpt-5')
    ) {
      supported = ['low', 'medium', 'high', 'xhigh', 'max'];
    }
  }

  if (!supported) return undefined;

  // Original CLI: no requested effort → no reasoning_effort field at all
  // (supportsThinking gates it; there is no default-medium).
  if (requested == null) return undefined;

  let effortStr = String(requested).toLowerCase();
  if (typeof requested === 'number') {
    if (requested >= 6) effortStr = 'ultra';
    else if (requested === 5) effortStr = 'max';
    else if (requested === 4) effortStr = 'high';
    else if (requested === 3) effortStr = 'medium';
    else if (requested === 2) effortStr = 'low';
    else effortStr = 'minimal';
  }

  if (supported.includes(effortStr)) return effortStr;

  // Snap to the closest supported tier at or below the request.
  const reqRank = EFFORT_RANK[effortStr] ?? 2;
  const atOrBelow = supported.filter(e => (EFFORT_RANK[e] ?? 2) <= reqRank);
  if (atOrBelow.length > 0) {
    return atOrBelow.reduce((best, e) => (EFFORT_RANK[e] > EFFORT_RANK[best] ? e : best));
  }
  return supported[0] || 'medium';
}
