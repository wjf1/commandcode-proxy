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

  // Force a live re-sync from upstream (dashboard "Fetch Live Models" button).
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
