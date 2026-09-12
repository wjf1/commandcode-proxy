// =============================================================================
// 模型目录：同步上游 / 官方定价富化 / 模糊模型名解析
// -----------------------------------------------------------------------------
// - getCachedModels()          读取内存中的模型列表（来自 models.json 缓存）
// - fetchUpstreamModels()      从上游 /provider/v1/models 拉取实时模型，
//                              并配以官方 commandcode.ai 定价页富化
//                              （pricing/context/caps/deal/go-plan），落盘缓存
// - resolveModelName()         把客户端请求的模型名模糊解析到已知模型
// - fetchPricingCatalog()      抓取官方定价页（TTL 6h），从 Next.js RSC payload 提取
// =============================================================================
import fs from 'fs';
import path from 'path';
import { loadConfig, assertSafeUpstreamUrl } from './config.js';
import { getProjectRootDir } from './paths.js';
import { logger } from './logger.js';
import { buildAvailabilityMap } from './plans.js';
import { ModelItem, ModelPricing, ModelCaps, ModelDeal, TimeOfDayPricing } from '../types/index.js';

export interface UpstreamModel extends ModelItem {}

const MODELS_FILE_PATH = process.env.COMMANDCODE_MODELS_CACHE_PATH
  ? path.resolve(process.env.COMMANDCODE_MODELS_CACHE_PATH)
  : path.join(getProjectRootDir(), 'models.json');
const PRICING_FILE_PATH = process.env.COMMANDCODE_PRICING_CACHE_PATH
  ? path.resolve(process.env.COMMANDCODE_PRICING_CACHE_PATH)
  : path.join(getProjectRootDir(), 'pricing.json');
/** 官方定价页。包含 CONTEXT / INPUT / OUTPUT / CACHE READ / CACHE WRITE / Caps / Deals。 */
const PRICING_PLAN_URL = process.env.COMMANDCODE_PRICING_URL || 'https://commandcode.ai/docs/plans/go';
/** 一次抓取的定价目录视为"新鲜"的有效期（毫秒）：6 小时。 */
const PRICING_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * pricing.json 的结构版本。改动缓存字段（如新增 availability 档位映射）时递增，
 * 旧缓存会自动失效并重新抓取，避免升级后新功能静默不生效。
 */
const PRICING_SCHEMA_VERSION = 3;

const DEFAULT_MODELS: ModelItem[] = [
  { id: 'claude-sonnet-5', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'command-code', name: 'Claude Sonnet 5', context_length: 1000000, supports_vision: true },
  { id: 'claude-sonnet-4-6', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'command-code', name: 'Claude Sonnet 4.6', context_length: 1000000 },
  { id: 'gpt-5.6-sol', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'command-code', name: 'GPT 5.6 Sol', context_length: 1000000 },
  { id: 'deepseek/deepseek-v4-pro', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'deepseek', name: 'DeepSeek V4 Pro' },
  { id: 'poolside/laguna-s-2.1-free', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'poolside', name: 'Poolside Laguna S 2.1 Free' },
  { id: 'google/gemini-3.6-flash', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'google', name: 'Gemini 3.6 Flash' },
  { id: 'xai/grok-4.5', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'xai', name: 'Grok 4.5' },
];

let cachedModels: ModelItem[] = loadPersistedModels();

function loadPersistedModels(): ModelItem[] {
  try {
    if (fs.existsSync(MODELS_FILE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(MODELS_FILE_PATH, 'utf-8'));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (err: any) {
    logger.warn(`[MODELS] Could not load models.json: ${err.message}`);
  }
  savePersistedModels(DEFAULT_MODELS);
  return DEFAULT_MODELS;
}

function savePersistedModels(models: ModelItem[]): void {
  try {
    fs.writeFileSync(MODELS_FILE_PATH, JSON.stringify(models, null, 2), 'utf-8');
  } catch (err: any) {
    logger.error(`[MODELS] Error saving models.json: ${err.message}`);
  }
}

function hasModelsChanged(existing: ModelItem[], fresh: ModelItem[]): boolean {
  if (existing.length !== fresh.length) return true;
  const existingIds = new Set(existing.map(m => m.id));
  return fresh.some(m => !existingIds.has(m.id));
}

export function getCachedModels(): ModelItem[] {
  return cachedModels;
}

/** 仅供测试：替换内存模型缓存（resolveModelName 等纯内存逻辑借此获得确定输入）。 */
export function setCachedModelsForTest(models: ModelItem[]): void {
  cachedModels = models;
}

// ── 官方定价目录（commandcode.ai）────────────────────────────────────────────

interface PricingCatalogEntry {
  id: string;
  name?: string;
  category?: string;
  contextWindow?: number;
  caps?: ModelCaps;
  deal?: ModelDeal;
  tip?: string;
  pricing?: ModelPricing;
  /** 峰谷分时价（官方仅部分模型提供）。 */
  timeOfDay?: TimeOfDayPricing;
  onGoPlan?: boolean;
  availability?: Record<string, boolean>;
}

/** 官方 rates 对象 → 规范化的 ModelPricing（只保留数值字段）。 */
function toPricing(rates: any): ModelPricing | undefined {
  if (!rates || typeof rates !== 'object') return undefined;
  const parsed: ModelPricing = {
    input: typeof rates.input === 'number' ? rates.input : undefined,
    output: typeof rates.output === 'number' ? rates.output : undefined,
    cacheRead: typeof rates.cacheRead === 'number' ? rates.cacheRead : undefined,
    cacheWrite: typeof rates.cacheWrite === 'number' ? rates.cacheWrite : undefined,
  };
  return parsed.input === undefined && parsed.output === undefined ? undefined : parsed;
}

/**
 * 解析官方 timeOfDay 分时价。
 * 官方对 4 个模型（deepseek 系列）给出 peak/offPeak 双档：谷时 $0.15/$0.60、
 * 峰时 $0.30/$1.20。此前解析器只取 tiers[0].rates（= 谷时），峰时价被丢弃，
 * 导致峰时请求成本被低估一半。
 */
function parseTimeOfDay(tod: any): TimeOfDayPricing | undefined {
  if (!tod || typeof tod !== 'object') return undefined;
  const peak = toPricing(tod.peak);
  const offPeak = toPricing(tod.offPeak);
  if (!peak && !offPeak) return undefined;
  return {
    peak,
    offPeak,
    peakHoursPerDay: typeof tod.peakHoursPerDay === 'number' ? tod.peakHoursPerDay : undefined,
    offPeakHoursPerDay: typeof tod.offPeakHoursPerDay === 'number' ? tod.offPeakHoursPerDay : undefined,
    windows: typeof tod.windows === 'string' ? tod.windows : undefined,
    tip: typeof tod.tip === 'string' ? tod.tip : undefined,
  };
}

function normalizeId(s: string): string {
  return String(s || '').toLowerCase().trim();
}

/** 从嵌在定价页 HTML 的 Next.js RSC payload 中提取模型数组。导出便于用 fixture 锁定解析契约。 */
export function parsePricingFromHtml(html: string): PricingCatalogEntry[] {
  // App Router RSC 飞行数据通过 self.__next_f.push([1,"..."]) 分块注入，
  // 各块内是转义的 JS 字符串字面量；先解转义并按序拼接成完整 flight 文本。
  const chunks: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const start = m.index + m[0].length;
    let i = start;
    while (i < html.length) {
      const ch = html[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"' && (html.slice(i + 1, i + 3) === '])' || html.slice(i + 1, i + 4) === ']);')) break;
      i += 1;
    }
    if (i >= html.length) continue;
    try {
      chunks.push(JSON.parse('"' + html.slice(start, i) + '"') as string);
    } catch { /* 跳过无法解析的分块 */ }
  }
  if (chunks.length === 0) {
    logger.warn('[MODELS] Pricing page structure changed: no RSC payload found.');
    return [];
  }
  const flight = chunks.join('');

  const marker = '{"rows":[';
  const i = flight.indexOf(marker);
  if (i < 0) {
    logger.warn('[MODELS] Pricing page structure changed: "rows" marker not found.');
    return [];
  }
  let depth = 0;
  let j = i;
  while (j < flight.length) {
    const ch = flight[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
    j += 1;
  }
  if (j >= flight.length) {
    logger.warn('[MODELS] Pricing page structure changed: unbalanced object.');
    return [];
  }
  let obj: any;
  try {
    obj = JSON.parse(flight.slice(i, j + 1));
  } catch {
    logger.warn('[MODELS] Pricing page JSON parse failed.');
    return [];
  }
  const rows: any[] = Array.isArray(obj.rows) ? obj.rows : [];
  const out: PricingCatalogEntry[] = [];
  for (const r of rows) {
    if (!r || typeof r.id !== 'string') continue;
    const tier = Array.isArray(r.tiers) && r.tiers.length > 0 ? r.tiers[0] : null;
    const rates = tier?.rates || null;
    const avail = buildAvailabilityMap(r.availability);
    out.push({
      id: r.id,
      name: r.name,
      category: r.category,
      contextWindow: typeof r.contextWindow === 'number' ? r.contextWindow : undefined,
      caps: r.caps || undefined,
      deal: r.deal || undefined,
      tip: r.tip,
      availability: avail,
      onGoPlan: avail?.['individual-go'] === true,
      pricing: toPricing(rates),
      timeOfDay: parseTimeOfDay(r.timeOfDay),
    });
  }
  return out;
}

function loadCachedPricing(): { fetchedAt: number; entries: PricingCatalogEntry[] } | null {
  try {
    if (fs.existsSync(PRICING_FILE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(PRICING_FILE_PATH, 'utf-8'));
      if (parsed && Array.isArray(parsed.entries)) {
        // 结构版本不匹配 → 视为过期：旧代码写入的缓存缺少 availability 等字段，
        // 若继续沿用，升级后按套餐过滤会静默失效（看起来"全部可用"）。
        if (parsed.schemaVersion !== PRICING_SCHEMA_VERSION) {
          logger.info(
            `[MODELS] pricing.json schema v${parsed.schemaVersion ?? 1} != v${PRICING_SCHEMA_VERSION}; refetching.`,
          );
          return null;
        }
        return { fetchedAt: parsed.fetchedAt || 0, entries: parsed.entries };
      }
    }
  } catch (err: any) {
    logger.warn(`[MODELS] Could not load pricing.json: ${err.message}`);
  }
  return null;
}

function savePricingCache(fetchedAt: number, entries: PricingCatalogEntry[]): void {
  try {
    fs.writeFileSync(
      PRICING_FILE_PATH,
      JSON.stringify({ schemaVersion: PRICING_SCHEMA_VERSION, fetchedAt, entries }, null, 2),
      'utf-8',
    );
  } catch (err: any) {
    logger.error(`[MODELS] Error saving pricing.json: ${err.message}`);
  }
}

/**
 * 抓取官方 Command Code 定价目录（context / input / output / cache-read /
 * cache-write / caps / deals）。缓存到 pricing.json 并附带 TTL；
 * 传 force=true 跳过缓存（供仪表盘"获取最新模型"按钮使用）。
 */
export async function fetchPricingCatalog(force = false): Promise<Map<string, PricingCatalogEntry>> {
  const cache = loadCachedPricing();
  if (!force && cache && Date.now() - cache.fetchedAt < PRICING_TTL_MS) {
    return new Map(cache.entries.map(e => [normalizeId(e.id), e]));
  }
  // 站点在部分地区较慢/不稳定：45s 超时 + 3 次重试。
  const attempts = 3;
  let safePricingUrl: string;
  try {
    safePricingUrl = assertSafeUpstreamUrl(PRICING_PLAN_URL).toString();
  } catch (err: any) {
    logger.warn(`[MODELS] Blocked unsafe pricing URL: ${err.message}`);
    return cache ? new Map(cache.entries.map(e => [normalizeId(e.id), e])) : new Map();
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      const res = await fetch(safePricingUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; commandcode-proxy/4)' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        logger.warn(`[MODELS] Pricing page fetch failed: HTTP ${res.status} (attempt ${attempt}/${attempts})`);
      } else {
        const html = await res.text();
        const entries = parsePricingFromHtml(html);
        if (entries.length > 0) {
          savePricingCache(Date.now(), entries);
          logger.info(`[MODELS] Fetched official pricing catalog (${entries.length} models) from commandcode.ai`);
          return new Map(entries.map(e => [normalizeId(e.id), e]));
        }
      }
    } catch (err: any) {
      logger.warn(`[MODELS] Pricing catalog fetch failed (attempt ${attempt}/${attempts}): ${err.message}`);
    }
    if (attempt < attempts) await new Promise(r => setTimeout(r, 2000));
  }
  return cache ? new Map(cache.entries.map(e => [normalizeId(e.id), e])) : new Map();
}

/** 把官方目录细节（定价/上下文/caps/deal/go-plan）合并进模型列表。 */
function mergePricingIntoModels(models: ModelItem[], pricingMap: Map<string, PricingCatalogEntry>): ModelItem[] {
  const byName = new Map<string, PricingCatalogEntry>();
  const byNorm = new Map<string, PricingCatalogEntry>();
  for (const e of pricingMap.values()) {
    byNorm.set(normalizeId(e.id), e);
    if (e.name) byName.set(normalizeId(e.name), e);
  }
  const merged = models.map(m => {
    const key = normalizeId(m.id);
    const bare = key.replace(/^[a-z0-9-]+\//, ''); // strip provider prefix for matching
    const e = byNorm.get(key) || byNorm.get(bare) || byName.get(normalizeId(m.name || ''));
    if (!e) return m;
    return {
      ...m,
      name: m.name || e.name,
      context_window: e.contextWindow,
      context_length: m.context_length ?? e.contextWindow,
      category: e.category,
      caps: e.caps,
      pricing: e.pricing,
      timeOfDay: e.timeOfDay,
      deal: e.deal,
      tip: e.tip,
      availability: e.availability,
      onGoPlan: e.onGoPlan,
      supports_vision: m.supports_vision ?? e.caps?.vision,
    };
  });
  return merged;
}

export async function fetchUpstreamModels(apiKey: string, ccVersion: string, refreshPricing = false): Promise<ModelItem[]> {
  const config = loadConfig();
  if (!apiKey) return cachedModels;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'cli',
    'x-cli-environment': 'cli',
    'x-command-code-version': ccVersion,
  };

  let freshModels: ModelItem[] | null = null;

  try {
    let safeModelsUrl: string;
    try {
      safeModelsUrl = assertSafeUpstreamUrl(`${config.ccApiBase}/provider/v1/models`).toString();
    } catch (err: any) {
      logger.warn(`[MODELS] Blocked unsafe upstream URL: ${err.message}`);
      safeModelsUrl = '';
    }
    const res = safeModelsUrl ? await fetch(safeModelsUrl, { method: 'GET', headers }) : null;
    if (res && res.ok) {
      const data: any = await res.json();
      let rawList: any[] = [];
      if (Array.isArray(data)) rawList = data;
      else if (Array.isArray(data.data)) rawList = data.data;
      else if (Array.isArray(data.models)) rawList = data.models;

      if (rawList.length > 0) {
        freshModels = rawList.map((item: any) => {
          if (typeof item === 'string') {
            return {
              id: item,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: item.split('/')[0] || 'command-code',
            };
          }
          return {
            id: item.id || item.name,
            object: 'model',
            created: item.created || Math.floor(Date.now() / 1000),
            owned_by: item.owned_by || item.provider || (item.id ? String(item.id).split('/')[0] : 'command-code'),
            name: item.name,
            context_length: item.context_length || item.contextWindow,
            reasoning_efforts: item.reasoning_efforts || item.reasoningEfforts,
            supports_vision: item.supports_vision ?? item.supportsVision,
          };
        });
      }
    }
  } catch (err: any) {
    logger.warn(`[MODELS] Upstream model fetch failed: ${err.message}`);
  }

  // ── 用官方定价目录对模型做富化（尽力而为）──────────────
  if (freshModels && freshModels.length > 0) {
    const pricingMap = await fetchPricingCatalog(refreshPricing);
    if (pricingMap.size > 0) {
      const merged = mergePricingIntoModels(freshModels, pricingMap);
      // 追加 provider API 未列出的官方 Go 套餐模型，使仪表盘能展示完整
      // Go 目录（含定价/caps/deals）。
      const known = new Set(merged.map(m => normalizeId(m.id)));
      const knownBare = new Set(merged.map(m => normalizeId(m.id).replace(/^[a-z0-9-]+\//, '')));
      for (const e of pricingMap.values()) {
        const key = normalizeId(e.id);
        if (known.has(key) || knownBare.has(key)) continue;
        if (!e.onGoPlan) continue;
        merged.push({
          id: e.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: e.id.split('/')[0] || 'command-code',
          name: e.name,
          context_length: e.contextWindow,
          context_window: e.contextWindow,
          category: e.category,
          caps: e.caps,
          pricing: e.pricing,
          timeOfDay: e.timeOfDay,
          deal: e.deal,
          tip: e.tip,
          availability: e.availability,
          onGoPlan: true,
          supports_vision: e.caps?.vision,
        });
      }
      freshModels = merged;
    }
  }

  if (freshModels && freshModels.length > 0) {
    // 比较完整内容（而非仅 id），使 pricing/caps/deal 变化也能持久化。
    const nextJson = JSON.stringify(freshModels);
    const curJson = JSON.stringify(cachedModels);
    if (nextJson !== curJson) {
      cachedModels = freshModels;
      savePersistedModels(cachedModels);
      logger.info(`[MODELS] Synchronized ${cachedModels.length} models (with official pricing) into models.json`);
    } else {
      logger.info(`[MODELS] Model catalog verified (${cachedModels.length} models up to date).`);
    }
    return cachedModels;
  }

  return cachedModels;
}

/**
 * 模糊解析请求的模型名到已知上游模型。
 * 匹配顺序：精确 → 去掉厂商前缀 → 后缀 → 部分包含 → 家族关键字 → 第一个模型。
 */
export function resolveModelName(requestedModel: string): string {
  if (!requestedModel || typeof requestedModel !== 'string') {
    return cachedModels[0]?.id || 'claude-sonnet-5';
  }

  const raw = requestedModel.trim();
  const available = getCachedModels();

  if (available.some(m => m.id === raw)) return raw;

  let clean = raw.replace(/^([a-z0-9_-]+)[:\/]/i, '').trim();
  if (available.some(m => m.id === clean)) {
    logger.info(`[MODELS] Resolved '${requestedModel}' -> '${clean}'`);
    return clean;
  }

  const lowerClean = clean.toLowerCase();
  const endsWithMatch = available.find(
    m =>
      m.id.toLowerCase() === lowerClean ||
      m.id.toLowerCase().endsWith('/' + lowerClean) ||
      (m.name && m.name.toLowerCase() === lowerClean)
  );
  if (endsWithMatch) {
    logger.info(`[MODELS] Resolved '${requestedModel}' -> '${endsWithMatch.id}'`);
    return endsWithMatch.id;
  }

  const partialMatch = available.find(m => m.id.toLowerCase().includes(lowerClean));
  if (partialMatch) {
    logger.info(`[MODELS] Resolved '${requestedModel}' -> '${partialMatch.id}'`);
    return partialMatch.id;
  }

  const familyRules: Array<[RegExp, string[]]> = [
    [/sonnet|claude/, ['sonnet', 'claude']],
    [/gpt-4|gpt-5|gpt/, ['gpt-5', 'gpt-4', 'gpt']],
    [/o3|o1|reason/, ['o3', 'o1']],
    [/gemini|flash/, ['gemini', 'flash']],
  ];
  for (const [test, candidates] of familyRules) {
    if (test.test(lowerClean)) {
      for (const kw of candidates) {
        const hit = available.find(m => m.id.toLowerCase().includes(kw));
        if (hit) {
          logger.warn(`[MODELS] Unrecognized model '${requestedModel}' mapped to '${hit.id}'`);
          return hit.id;
        }
      }
    }
  }

  // 目录里完全找不到时原样透传给上游：上游会对未知模型返回准确的错误，
  // 而不是像"静默替换成默认模型"那样让用户收到一个从未请求过的模型名
  // （免费套餐下还会表现为 MODEL_NOT_IN_PLAN 指向错误模型的困惑报错）。
  logger.warn(`[MODELS] Model '${requestedModel}' not in local catalog; passing through to upstream as-is.`);
  return raw;
}

/** 查询上游模型支持的推理档位（reasoning effort tiers）。 */
export function getReasoningEfforts(modelId: string): string[] | undefined {
  const m = cachedModels.find(m => m.id === modelId);
  return m?.reasoning_efforts;
}
