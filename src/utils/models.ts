import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { ModelItem, ModelPricing, ModelCaps, ModelDeal } from '../types/index.js';

export interface UpstreamModel extends ModelItem {}

function getProjectRootDir(): string {
  if ((process as any).pkg || process.execPath.toLowerCase().includes('commandcode-proxy')) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

const MODELS_FILE_PATH = path.join(getProjectRootDir(), 'models.json');
const PRICING_FILE_PATH = path.join(getProjectRootDir(), 'pricing.json');
/** Official pricing page. Contains CONTEXT / INPUT / OUTPUT / CACHE READ / CACHE WRITE / Caps / Deals. */
const PRICING_PLAN_URL = 'https://commandcode.ai/docs/plans/go';
/** How long a fetched pricing catalog is considered fresh (ms). */
const PRICING_TTL_MS = 6 * 60 * 60 * 1000;

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

// ── Official pricing catalog (commandcode.ai) ────────────────────────────────

interface PricingCatalogEntry {
  id: string;
  name?: string;
  category?: string;
  contextWindow?: number;
  caps?: ModelCaps;
  deal?: ModelDeal;
  tip?: string;
  pricing?: ModelPricing;
  onGoPlan?: boolean;
}

function normalizeId(s: string): string {
  return String(s || '').toLowerCase().trim();
}

/** Extract the model array from the Next.js RSC payload embedded in the pricing page HTML. */
function parsePricingFromHtml(html: string): PricingCatalogEntry[] {
  const marker = '{\"rows\":[';
  const i = html.indexOf(marker);
  if (i < 0) {
    logger.warn('[MODELS] Pricing page structure changed: "rows" marker not found.');
    return [];
  }
  let depth = 0;
  let j = i;
  while (j < html.length) {
    const ch = html[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === '\\') {
      j += 1; // skip escaped char inside the JS string literal
    }
    j += 1;
  }
  if (j >= html.length) {
    logger.warn('[MODELS] Pricing page structure changed: unbalanced object.');
    return [];
  }
  const raw = html.slice(i, j + 1);
  let decodedStr: string;
  try {
    decodedStr = JSON.parse('"' + raw + '"') as string;
  } catch {
    logger.warn('[MODELS] Pricing page unescape failed.');
    return [];
  }
  let obj: any;
  try {
    obj = JSON.parse(decodedStr);
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
    const avail = r.availability || {};
    out.push({
      id: r.id,
      name: r.name,
      category: r.category,
      contextWindow: typeof r.contextWindow === 'number' ? r.contextWindow : undefined,
      caps: r.caps || undefined,
      deal: r.deal || undefined,
      tip: r.tip,
      onGoPlan: avail['individual-go'] === true,
      pricing: rates
        ? {
            input: typeof rates.input === 'number' ? rates.input : undefined,
            output: typeof rates.output === 'number' ? rates.output : undefined,
            cacheRead: typeof rates.cacheRead === 'number' ? rates.cacheRead : undefined,
            cacheWrite: typeof rates.cacheWrite === 'number' ? rates.cacheWrite : undefined,
          }
        : undefined,
    });
  }
  return out;
}

function loadCachedPricing(): { fetchedAt: number; entries: PricingCatalogEntry[] } | null {
  try {
    if (fs.existsSync(PRICING_FILE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(PRICING_FILE_PATH, 'utf-8'));
      if (parsed && Array.isArray(parsed.entries)) {
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
    fs.writeFileSync(PRICING_FILE_PATH, JSON.stringify({ fetchedAt, entries }, null, 2), 'utf-8');
  } catch (err: any) {
    logger.error(`[MODELS] Error saving pricing.json: ${err.message}`);
  }
}

/**
 * Fetch the official Command Code pricing catalog (context / input / output /
 * cache-read / cache-write / caps / deals). Cached to pricing.json with a TTL;
 * pass force=true to bypass the cache (used by the dashboard "Fetch Live Models").
 */
export async function fetchPricingCatalog(force = false): Promise<Map<string, PricingCatalogEntry>> {
  const cache = loadCachedPricing();
  if (!force && cache && Date.now() - cache.fetchedAt < PRICING_TTL_MS) {
    return new Map(cache.entries.map(e => [normalizeId(e.id), e]));
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(PRICING_PLAN_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; commandcode-proxy/4)' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      logger.warn(`[MODELS] Pricing page fetch failed: HTTP ${res.status}`);
      return cache ? new Map(cache.entries.map(e => [normalizeId(e.id), e])) : new Map();
    }
    const html = await res.text();
    const entries = parsePricingFromHtml(html);
    if (entries.length > 0) {
      savePricingCache(Date.now(), entries);
      logger.info(`[MODELS] Fetched official pricing catalog (${entries.length} models) from commandcode.ai`);
      return new Map(entries.map(e => [normalizeId(e.id), e]));
    }
    return cache ? new Map(cache.entries.map(e => [normalizeId(e.id), e])) : new Map();
  } catch (err: any) {
    logger.warn(`[MODELS] Pricing catalog fetch failed: ${err.message}`);
    return cache ? new Map(cache.entries.map(e => [normalizeId(e.id), e])) : new Map();
  }
}

/** Merge official catalog details (pricing/context/caps/deal/go-plan) into the model list. */
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
      deal: e.deal,
      tip: e.tip,
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
    const res = await fetch(`${config.ccApiBase}/provider/v1/models`, { method: 'GET', headers });
    if (res.ok) {
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

  // ── Enrich with the official Command Code pricing catalog (best effort) ──
  if (freshModels && freshModels.length > 0) {
    const pricingMap = await fetchPricingCatalog(refreshPricing);
    if (pricingMap.size > 0) {
      const merged = mergePricingIntoModels(freshModels, pricingMap);
      // Append official Go-plan models that the provider API did not list, so the
      // dashboard shows the full Go catalog with pricing/caps/deals.
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
          deal: e.deal,
          tip: e.tip,
          onGoPlan: true,
          supports_vision: e.caps?.vision,
        });
      }
      freshModels = merged;
    }
  }

  if (freshModels && freshModels.length > 0) {
    // Compare full content (not just ids) so pricing/caps/deal changes are persisted.
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
 * Fuzzy-resolve a requested model id to a known upstream model.
 * Exact → prefix-strip → suffix → partial → family keyword → first model.
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

  const defaultModel = available[0]?.id || 'claude-sonnet-5';
  logger.warn(`[MODELS] Model '${requestedModel}' not found upstream. Falling back to '${defaultModel}'.`);
  return defaultModel;
}

/** Look up the reasoning-effort tiers the upstream model supports. */
export function getReasoningEfforts(modelId: string): string[] | undefined {
  const m = cachedModels.find(m => m.id === modelId);
  return m?.reasoning_efforts;
}
