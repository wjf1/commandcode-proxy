// =============================================================================
// 模型目录接口
// -----------------------------------------------------------------------------
// - GET  /v1/models        返回缓存的模型列表（含官方定价/caps/deal 富化）
// - POST /v1/models/refresh 强制从上游重新同步模型与官方定价目录
// =============================================================================
import { FastifyInstance } from 'fastify';
import { getCachedModels, fetchUpstreamModels } from '../utils/models.js';
import { getActiveApiKey, loadConfig } from '../utils/config.js';

export async function modelsRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/models', async () => {
    return {
      object: 'list',
      data: getCachedModels().map(m => ({
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
