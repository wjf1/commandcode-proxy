// =============================================================================
// CommandCode Proxy v4 —— 服务入口（bootstrap）
// -----------------------------------------------------------------------------
// 启动流程：
//   1. 注册全局未捕获异常/拒绝处理器（记录日志，不让进程崩溃）
//   2. 加载配置（config.json / 环境变量）
//   3. 注册管理员仪表盘、OpenAI、Anthropic、models 四条路由
//   4. 可选地挂载 PROXY_API_KEY 共享密钥鉴权钩子
//   5. 后台拉取模型目录（尽力而为，不阻塞启动）
//   6. 若配置为 auto-quota 轮换模式，启动 30 分钟一次的额度轮换调度器
//   7. 监听端口；默认自动打开浏览器显示仪表盘
// =============================================================================
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

const QUOTA_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 每 30 分钟检查一次额度

const start = async () => {
  try {
    // 可选的共享密钥鉴权（PROXY_API_KEY 环境变量），作用于 /v1/*。
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

    // v3 bug 修复：auto-quota 轮换此前是死代码 —— 现在真正被调度执行。
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
