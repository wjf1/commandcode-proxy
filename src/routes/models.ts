// =============================================================================
// 模型目录接口
// -----------------------------------------------------------------------------
// - GET  /v1/models        返回缓存的模型列表（含官方定价/caps/deal 富化）
//                          支持按套餐过滤：?plan=individual-go&available=1
// - POST /v1/models/refresh 强制从上游重新同步模型与官方定价目录
//
// 过滤是**可选的**：不带参数时行为与之前完全一致（返回全部模型），避免打断
// 既有客户端。每个模型都会带上上游原始的 availability 映射与可读档位标签。
// =============================================================================
import { FastifyInstance } from 'fastify';
import { getCachedModels, fetchUpstreamModels } from '../utils/models.js';
import { getActiveApiKey, loadConfig } from '../utils/config.js';
import {
  isModelAvailableForPlan,
  planLabelForModel,
  planName,
  planTier,
  resolveActivePlanId,
} from '../utils/plans.js';

function isTruthyFlag(value: unknown): boolean {
  const v = String(value ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export async function modelsRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/models', async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const requestedPlan =
      typeof query.plan === 'string' && query.plan.trim() ? query.plan.trim() : undefined;
    const availableOnly = isTruthyFlag(query.available) || isTruthyFlag(query.only);

    // 只按套餐过滤但没指定档位时，回落到当前账号的套餐（内部有 10 分钟缓存）。
    const planId = requestedPlan ?? (availableOnly ? await resolveActivePlanId() : undefined);

    let models = getCachedModels();
    if (availableOnly && planId) {
      // fail-open：判定为 undefined（无 availability 数据）的模型保留，不误杀。
      models = models.filter(m => isModelAvailableForPlan(m.availability, planId) !== false);
    }

    const tier = planTier(planId);
    return {
      object: 'list',
      ...(planId
        ? {
            plan: {
              id: planId,
              name: planName(planId),
              monthlyCredits: tier?.monthlyCredits,
              fiveHourCap: tier?.fiveHourCap,
              weeklyCap: tier?.weeklyCap,
              availableOnly,
              filteredCount: availableOnly ? models.length : undefined,
            },
          }
        : {}),
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: m.created,
        owned_by: m.owned_by,
        name: m.name,
        context_length: m.context_length,
        reasoning_efforts: m.reasoning_efforts,
        supports_vision: m.supports_vision,
        context_window: m.context_window,
        category: m.category,
        caps: m.caps,
        pricing: m.pricing,
        deal: m.deal,
        onGoPlan: m.onGoPlan,
        availability: m.availability,
        available_on_plan: planId ? isModelAvailableForPlan(m.availability, planId) : undefined,
        plan_tier: planLabelForModel(m.availability),
        tip: m.tip,
      })),
    };
  });

  // 强制从上游实时再同步（仪表盘"获取最新模型"按钮）。
  fastify.post('/v1/models/refresh', async (req, reply) => {
    const apiKey = getActiveApiKey();
    if (!apiKey) {
      return reply.status(401).send({ error: { message: 'No active API key' } });
    }
    const config = loadConfig();
    // Dashboard refresh: also force-fetch the official pricing catalog (pricing + caps + deals).
    const models = await fetchUpstreamModels(apiKey, config.ccVersion, true);
    return { status: 'success', count: models.length };
  });
}
