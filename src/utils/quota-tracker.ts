// =============================================================================
// 额度采样与燃烧速率预测
// -----------------------------------------------------------------------------
// 关键口径问题：官方 `windowLimits.fiveHour.used` 是**全账号**值（含直连 CLI、
// 其他客户端的流量），而本代理的本地用量历史只覆盖经过代理的部分（实测约
// 18%）。因此**不能**用本地历史的外推速率去预测官方额度的耗尽时间 —— 那会把
// 剩余时间严重高估，给出危险的反向预警。
//
// 正确做法：对官方 `used` 做**时间差分**。定期采样 official used，相邻两次采样
// 的增量 / 时间差即真实燃烧速率。本模块只做这件事，不读本地用量历史。
// =============================================================================

export interface QuotaSample {
  /** 采样时刻（epoch ms）。 */
  at: number;
  /** 官方口径的已用额度（USD）。 */
  used: number;
  /** 官方口径的窗口上限（USD）。 */
  cap: number;
  /** 官方给出的窗口重置时刻（epoch ms），可能缺失。 */
  resetAt: number | null;
}

export interface QuotaProjection {
  /** 采样次数（<2 时无法计算速率）。 */
  samples: number;
  /** 参与速率计算的时间跨度（分钟）。 */
  windowMinutes: number | null;
  /** 官方口径燃烧速率（USD / 小时）；增长或持平为正，回落为负。 */
  burnPerHour: number | null;
  /** 距窗口上限的剩余额度（USD）。 */
  remainingUsd: number | null;
  /** 按当前速率预计**多少分钟后**撞上限额；速率非正或已超限时为 null。 */
  minutesToCap: number | null;
  /**
   * 是否会在官方重置之前撞上限额。null 表示无法判断（采样不足 / 速率非正 /
   * 缺 resetAt）。这是唯一需要用户行动的结论，其余都是中间量。
   */
  willHitCapBeforeReset: boolean | null;
  /** 官方重置倒计时（分钟）。 */
  minutesToReset: number | null;
  /** 已用比例（0-1）。 */
  usageRatio: number | null;
}

/** 保留的采样窗口：6 小时，覆盖一个 5h 计费窗口。 */
const SAMPLE_TTL_MS = 6 * 60 * 60 * 1000;
/** 参与速率计算的最小时间跨度（分钟）：过短会被上游统计延迟放大噪声。 */
const MIN_SPAN_MINUTES = 10;

/** 纯函数：由采样序列计算预测。独立导出便于测试。 */
export function projectFromSamples(samples: QuotaSample[], now: number = Date.now()): QuotaProjection {
  const fresh = samples
    .filter(s => s && Number.isFinite(s.at) && Number.isFinite(s.used))
    .filter(s => now - s.at <= SAMPLE_TTL_MS)
    .sort((a, b) => a.at - b.at);

  const latest = fresh[fresh.length - 1] || null;
  const base: QuotaProjection = {
    samples: fresh.length,
    windowMinutes: null,
    burnPerHour: null,
    remainingUsd: null,
    minutesToCap: null,
    willHitCapBeforeReset: null,
    minutesToReset: null,
    usageRatio: null,
  };
  if (!latest) return base;

  const cap = Number.isFinite(latest.cap) && latest.cap > 0 ? latest.cap : null;
  base.remainingUsd = cap === null ? null : Math.max(0, cap - latest.used);
  base.usageRatio = cap === null ? null : Math.min(1, Math.max(0, latest.used / cap));
  base.minutesToReset = latest.resetAt && latest.resetAt > now
    ? Math.round((latest.resetAt - now) / 60000)
    : null;

  if (fresh.length < 2) return base;

  // 取足够长的跨度以抑制噪声：从最新样本向前找，跨度至少 MIN_SPAN_MINUTES。
  let first = fresh[0];
  for (const s of fresh) {
    if ((latest.at - s.at) / 60000 >= MIN_SPAN_MINUTES) {
      first = s;
      break;
    }
  }
  const spanMs = latest.at - first.at;
  if (spanMs <= 0) return base;
  const spanMinutes = spanMs / 60000;
  const deltaUsed = latest.used - first.used;

  // 官方计数回落（如窗口重置/口径修正）时速率记为 0，不外推。
  const burnPerHour = deltaUsed <= 0 ? 0 : (deltaUsed / spanMs) * 3600_000;
  base.windowMinutes = Math.round(spanMinutes);
  base.burnPerHour = burnPerHour;

  if (base.remainingUsd === null || burnPerHour <= 0) {
    // 速率非正 → 不会因燃烧撞限。
    base.minutesToCap = null;
    base.willHitCapBeforeReset = false;
    return base;
  }

  const minutesToCap = (base.remainingUsd / burnPerHour) * 60;
  base.minutesToCap = Math.round(minutesToCap);
  base.willHitCapBeforeReset =
    base.minutesToReset !== null ? minutesToCap < base.minutesToReset : null;
  return base;
}

// ─── 进程内采样器 ────────────────────────────────────────────────────────────

const samples: QuotaSample[] = [];
const MAX_SAMPLES = 200;

/** 记录一次官方额度采样（重复值也记录 —— 用于确认"确实没有增长"）。 */
export function recordQuotaSample(used: number, cap: number, resetAt: number | null, at: number = Date.now()): void {
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return;
  samples.push({ at, used, cap, resetAt: Number.isFinite(resetAt as number) ? resetAt : null });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

/** 当前预测结果。 */
export function getQuotaProjection(now: number = Date.now()): QuotaProjection {
  return projectFromSamples(samples, now);
}

/** 测试与换账号场景用：清空采样历史。 */
export function resetQuotaSamples(): void {
  samples.length = 0;
}

/** 采样次数（诊断用）。 */
export function quotaSampleCount(): number {
  return samples.length;
}
