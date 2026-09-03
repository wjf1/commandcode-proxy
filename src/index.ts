import Fastify from 'fastify';
import { loadConfig, openBrowser, checkAndRotateAccountsOnQuota, getActiveApiKey } from './utils/config.js';
import { fetchUpstreamModels } from './utils/models.js';
import { logger } from './utils/logger.js';
import { chatRoutes, verifyProxyAuth } from './routes/chat.js';
import { messagesRoutes } from './routes/messages.js';
import { modelsRoutes } from './routes/models.js';
import { dashboardRoutes } from './routes/dashboard.js';

process.on('uncaughtException', err => {
  logger.error(`[CRITICAL] Uncaught Exception: ${err.message}`);
});

process.on('unhandledRejection', (reason: any) => {
  logger.error(`[CRITICAL] Unhandled Rejection: ${reason?.message || reason}`);
});

const config = loadConfig();

const fastify = Fastify({
  logger: false,
  trustProxy: true,
});

const QUOTA_CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes

const start = async () => {
  try {
    // Optional shared-secret auth on /v1/* (PROXY_API_KEY env).
    verifyProxyAuth(fastify);

    await fastify.register(dashboardRoutes);
    await fastify.register(chatRoutes);
    await fastify.register(messagesRoutes);
    await fastify.register(modelsRoutes);

    fastify.get('/health', async () => {
      return { status: 'ok', version: '4.0.0', time: new Date().toISOString() };
    });

    logger.info('[BOOT] Initializing CommandCode Proxy v4...');

    const activeApiKey = getActiveApiKey();
    if (activeApiKey) {
      fetchUpstreamModels(activeApiKey, config.ccVersion).catch(err => {
        logger.warn(`[BOOT] Model fetch background warning: ${err.message}`);
      });
    }

    // v3 bug fix: auto-quota rotation was dead code — now actually scheduled.
    if (config.rotationMode === 'auto-quota' && config.accounts.length > 1) {
      setInterval(() => {
        checkAndRotateAccountsOnQuota().catch(err => {
          logger.warn(`[AUTO-QUOTA] Scheduled check failed: ${err.message}`);
        });
      }, QUOTA_CHECK_INTERVAL_MS);
      logger.info('[AUTO-QUOTA] Rotation scheduler active (every 30m).');
    }

    await fastify.listen({ port: config.port, host: config.host });

    const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    const dashboardUrl = `http://${displayHost}:${config.port}/`;

    console.log('\n=============================================================');
    console.log('  ⚡ CommandCode Proxy v4 is ACTIVE');
    console.log(`  🌐 Controller GUI:          ${dashboardUrl}`);
    console.log(`  🤖 OpenAI Chat Completions: ${dashboardUrl}v1/chat/completions`);
    console.log(`  💬 Anthropic Messages:      ${dashboardUrl}v1/messages`);
    console.log(`  🔒 Bound to:                ${config.host}${process.env.PROXY_API_KEY ? ' (API auth ON)' : ''}`);
    console.log('=============================================================\n');

    logger.info(`[SERVER] CommandCode Proxy v4 running on ${dashboardUrl}`);

    if (process.env.NODE_ENV !== 'test' && !process.env.NO_OPEN_BROWSER) {
      openBrowser(dashboardUrl);
    }
  } catch (err: any) {
    logger.error(`[SERVER] Error starting server: ${err.message}`);
    console.error(`\n[SERVER] Startup error: ${err.message}`);
    process.exit(1);
  }
};

start();
