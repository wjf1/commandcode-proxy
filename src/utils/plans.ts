// =============================================================================
// 套餐档位表 + 模型可用性判定
// -----------------------------------------------------------------------------
// 档位键名取自上游官方定价页的 availability 字段（实测 9 个键）：
//   individual-go / individual-goat / individual-pro / individual-pro-v1 /
//   individual-provider / individual-max / individual-ultra / teams-pro / all
//
// ⚠️ `all` 的语义未经证实：claude-opus-4-8 的 all=true，但在 Go 档位实测返回
//    403 MODEL_NOT_IN_PLAN。因此 **`all` 不参与过滤判定**，只看显式档位键。
//
// 额度/上限数值取自官方定价与限额文档：
//   Go $10 / $3 / $6、GOAT $70 / $14 / $35、Pro $80 / $16 / $40、Team Pro $40 / $12 / $24。
// individual-max、individual-ultra、individual-pro-v1 与文档中
// "Max 10× / Max 20× / Pro" 的对应关系**未能证实**，故只给显示名、不给数值，
// 以免面板展示错误数字。
// =============================================================================

export interface PlanTier {
  planId: string;
  name: string;
  /** 月度赠送额度（美元等值）。未证实者为 undefined。 */
  monthlyCredits?: number;
  /** 5 小时窗口上限。未证实者为 undefined。 */
  fiveHourCap?: number;
  /** 周窗口上限。未证实者为 undefined。 */
  weeklyCap?: number;
  note?: string;
}

/**
 * 把上游定价页的 availability 字段规范化为「档位键 → 布尔」映射。
 * 只保留布尔项；空对象/非对象一律返回 undefined（表示"无法判定"）。
 * models.ts 用它替代原先"压成 onGoPlan 一个布尔"的做法，从而保留全部档位信息。
 */
export function buildAvailabilityMap(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const PLAN_TIERS: Record<string, PlanTier> = {
  'individual-free': { planId: 'individual-free', name: 'Free', monthlyCredits: 0 },
  'individual-go': { planId: 'individual-go', name: 'Go', monthlyCredits: 10, fiveHourCap: 3, weeklyCap: 6 },
  'individual-goat': { planId: 'individual-goat', name: 'GOAT', monthlyCredits: 70, fiveHourCap: 14, weeklyCap: 35 },
  'individual-pro': { planId: 'individual-pro', name: 'Pro', monthlyCredits: 80, fiveHourCap: 16, weeklyCap: 40 },
  'individual-pro-v1': { planId: 'individual-pro-v1', name: 'Pro (v1)' },
  'individual-provider': { planId: 'individual-provider', name: 'Provider', note: 'pay-as-you-go' },
  'individual-max': { planId: 'individual-max', name: 'Max' },
  'individual-ultra': { planId: 'individual-ultra', name: 'Ultra' },
  'teams-pro': { planId: 'teams-pro', name: 'Team Pro', monthlyCredits: 40, fiveHourCap: 12, weeklyCap: 24 },
};

/** 用于展示的档位顺序（仅影响显示，不参与可用性判定）。 */
export const PLAN_DISPLAY_ORDER: string[] = [
  'individual-free',
  'individual-go',
  'individual-goat',
  'individual-pro',
  'individual-pro-v1',
  'individual-provider',
  'individual-max',
  'individual-ultra',
  'teams-pro',
];

/** 上游档位键白名单（`all` 被刻意排除，语义未证实）。 */
export const KNOWN_PLAN_KEYS: string[] = PLAN_DISPLAY_ORDER;

export function planTier(planId?: string): PlanTier | undefined {
  if (!planId) return undefined;
  return PLAN_TIERS[planId];
}

/** 档位显示名；未知档位原样返回 planId，缺失则返回 undefined。 */
export function planName(planId?: string): string | undefined {
  if (!planId) return undefined;
  return PLAN_TIERS[planId]?.name ?? planId;
}

/**
 * 判断某模型是否在当前档位可用。
 * 返回 undefined 表示"无法判定"（无 availability 数据，或该档位没有对应键），
 * 调用方应据此**放行**而非过滤掉——与插件 modelVisibleInPlan 的 fail-open 一致。
 */
export function isModelAvailableForPlan(
  availability: Record<string, boolean> | undefined,
  planId?: string,
): boolean | undefined {
  if (!availability || !planId) return undefined;
  const value = availability[planId];
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

/** 该模型可用（availability 显式为 true）的档位显示名列表。 */
export function availablePlanNames(availability?: Record<string, boolean>): string[] {
  if (!availability) return [];
  return PLAN_DISPLAY_ORDER.filter((key) => availability[key] === true).map(
    (key) => PLAN_TIERS[key]?.name ?? key,
  );
}

/** 模型的档位标签：可用档位多于 3 个时折叠为"多档位"。 */
export function planLabelForModel(availability?: Record<string, boolean>): string | undefined {
  const names = availablePlanNames(availability);
  if (names.length === 0) return undefined;
  return names.length > 3 ? `多档位 (${names.length})` : names.join(' · ');
}

// ─── 当前账号的套餐（带 TTL 缓存，避免每个请求都打上游）────────────────────────
//
// 订阅接口返回 { success, data: { planId, status, currentPeriodStart, ... } }。
// planId 变化不频繁，缓存 10 分钟足够，也避免 /v1/models 每次过滤都产生一次上游调用。

import { loadConfig, getActiveApiKey, fetchLiveUsageStats } from './config.js';

const ACTIVE_PLAN_TTL_MS = 10 * 60 * 1000;
let cachedActivePlan: { planId: string; at: number } | null = null;

export async function resolveActivePlanId(force = false): Promise<string | undefined> {
  if (!force && cachedActivePlan && Date.now() - cachedActivePlan.at < ACTIVE_PLAN_TTL_MS) {
    return cachedActivePlan.planId;
  }
  try {
    const apiKey = getActiveApiKey();
    if (!apiKey) return cachedActivePlan?.planId;
    const config = loadConfig();
    const stats = await fetchLiveUsageStats(apiKey, config.ccApiBase, config.ccVersion);
    const sub = stats?.subscription?.data ?? stats?.subscription;
    const planId = sub?.planId;
    if (typeof planId === 'string' && planId) {
      cachedActivePlan = { planId, at: Date.now() };
      return planId;
    }
  } catch {
    // 上游不可用：沿用旧缓存（可能为空），不影响其它功能
  }
  return cachedActivePlan?.planId;
}

/** 仅供测试：清空当前套餐缓存。 */
export function resetActivePlanCache(): void {
  cachedActivePlan = null;
}

