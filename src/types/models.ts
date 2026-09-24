// =============================================================================
// 类型定义：模型元数据（定价 / 峰谷分时价 / 能力 / 优惠 / 目录条目）
// -----------------------------------------------------------------------------
// 自 types/index.ts 原样拆出（架构 Phase 1），类型定义内容零变化。
// =============================================================================

// ─── Models ──────────────────────────────────────────────────────────────────

/** Per-1M-token pricing (USD). Mirrors the official Command Code pricing page. */
export interface ModelPricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * 官方定价页的峰谷分时价。部分模型（当前 4 个）在峰时段按更高费率计费，
 * 例如 deepseek-v4.1-flash 谷时 $0.15/$0.60、峰时 $0.30/$1.20。
 * 面板静态展示的 pricing 取谷时（官方页面默认展示档），实际估算需按时间选档。
 */
export interface TimeOfDayPricing {
  /** 峰时费率。 */
  peak?: ModelPricing;
  /** 谷时费率。 */
  offPeak?: ModelPricing;
  peakHoursPerDay?: number;
  offPeakHoursPerDay?: number;
  /** 峰时窗口的人类可读描述，例如 "01–04 & 06–10 UTC, Mon–Fri"。 */
  windows?: string;
  tip?: string;
}

/** Model capability flags (Caps). */
export interface ModelCaps {
  text?: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

/** Promo / deal info (FREE / discount percent). */
export interface ModelDeal {
  id?: string;
  discountPercent?: number;
  free?: boolean;
  expires?: string;
  endsWhen?: string;
  revertNote?: string;
}

export interface ModelItem {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  name?: string;
  context_length?: number;
  reasoning_efforts?: string[];
  supports_vision?: boolean;
  // -- Official pricing catalog enrichment (from commandcode.ai) --
  context_window?: number;
  category?: string;
  caps?: ModelCaps;
  pricing?: ModelPricing;
  /** 峰谷分时价（官方仅对部分模型提供）。 */
  timeOfDay?: TimeOfDayPricing;
  deal?: ModelDeal;
  /** Available on the individual Go plan (availability.individual-go). */
  onGoPlan?: boolean;
  /**
   * Per-plan availability map from the official pricing catalog, e.g.
   * {"individual-go":true,"individual-goat":true,...}. Stored verbatim so the
   * dashboard/API can filter by the caller's own plan instead of hardcoding one.
   */
  availability?: Record<string, boolean>;
  tip?: string;
}
