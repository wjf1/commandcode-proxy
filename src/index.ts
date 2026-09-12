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
import { loadConfig, openBrowser, checkAndRotateAccountsOnQuota, getActiveApiKey, resolveBodyLimit, enrichDefaultAccountName, fetchWindowLimits } from './utils/config.js';
import { fetchUpstreamModels } from './utils/models.js';
import { logger } from './utils/logger.js';
import { PROXY_VERSION } from './utils/version.js';
import { chatRoutes, verifyProxyAuth } from './routes/chat.js';
import { messagesRoutes } from './routes/messages.js';
import { modelsRoutes } from './routes/models.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { recordQuotaSample, getQuotaProjection } from './utils/quota-tracker.js';
import { flushPendingWrites } from './utils/usage-store.js';
import { scheduleUpdateChecks } from './utils/update-check.js';
import { notify, ensureAumidRegistered, isGlobalToastEnabled } from './utils/notifier.js';

// 未捕获异常/拒绝：单次只记日志（代理要尽量活着）。
// 但短时间连续出现说明进程已进入不可信状态（可能挂着僵死的上游连接、
// 内部状态被写坏）——达到阈值即主动退出，交给服务管理器/看门狗重启。
const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_THRESHOLD = 3;
let crashTimes: number[] = [];

function noteUncaught(kind: string, detail: string): void {
  const now = Date.now();
  crashTimes = crashTimes.filter(t => now - t < CRASH_WINDOW_MS);
  crashTimes.push(now);
  logger.error(`[CRITICAL] Uncaught ${kind}: ${detail}`);
  if (crashTimes.length >= CRASH_THRESHOLD) {
    logger.error(`[CRITICAL] ${CRASH_THRESHOLD} uncaught ${kind} within 5 minutes; exiting for supervisor restart.`);
    process.exit(1);
  }
}

process.on('uncaughtException', err => {
  noteUncaught('Exception', err.message);
});

process.on('unhandledRejection', (reason: any) => {
  noteUncaught('Rejection', reason?.message || String(reason));
});

const config = loadConfig();

const fastify = Fastify({
  logger: false,
  trustProxy: true,
  // 视觉/多图请求的 base64 负载可能超过 Fastify 默认 1MB，触发 413
  // (FST_ERR_CTP_BODY_TOO_LARGE)。默认 64MB，可用环境变量 MAX_BODY_MB 调整。
  bodyLimit: resolveBodyLimit(),
});

const QUOTA_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 每 30 分钟检查一次额度
/** 额度采样周期：官方 used 的时间差分决定燃烧速率，太疏会漏掉短时高峰。 */
const QUOTA_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 采样官方窗口用量并推进燃烧速率预测。只拉 credits 一个端点，开销最低。
 * 采样允许失败（网络抖动跳过本次即可，预测基于历史窗口）。
 */
async function sampleQuotaWindow(): Promise<void> {
  const apiKey = getActiveApiKey();
  if (!apiKey) return;
  try {
    const wl = await fetchWindowLimits(apiKey, config.ccApiBase, config.ccVersion);
    const fh = wl?.fiveHour;
    if (fh && Number.isFinite(fh.used) && Number.isFinite(fh.cap)) {
      recordQuotaSample(fh.used, fh.cap, typeof fh.resetAt === 'number' ? fh.resetAt : null);
      const p = getQuotaProjection();
      // 只在"会撞限"这个可行动结论上提醒，且由 notifier 去重限频。
      if (p.willHitCapBeforeReset === true && p.minutesToCap !== null) {
        notify(
          'quota-window-cap',
          'CommandCode 额度将耗尽',
          `按当前速率约 ${p.minutesToCap} 分钟后用完 5 小时窗口（剩余 $${(p.remainingUsd ?? 0).toFixed(2)}），早于重置时间`,
          'critical'
        );
      }
    }
  } catch (err: any) {
    logger.warn(`[QUOTA-SAMPLE] ${err?.message || err}`);
  }
}

// 优雅退出：SIGINT/SIGTERM 时先冲刷挂起的用量写入（内存写队列）再关闭，
// 避免 Ctrl+C 丢掉最后一两条会话记录。二次信号直接强制退出。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[SERVER] ${signal} received; flushing pending usage writes and closing...`);
  try {
    await flushPendingWrites();
  } catch { /* 尽力而为 */ }
  try {
    await fastify.close();
  } catch { /* 尽力而为 */ }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const start = async () => {
  try {
    // 可选的共享密钥鉴权（PROXY_API_KEY 环境变量），作用于 /v1/*。
    verifyProxyAuth(fastify);

    await fastify.register(dashboardRoutes);
    await fastify.register(chatRoutes);
    await fastify.register(messagesRoutes);
    await fastify.register(modelsRoutes);

    fastify.get('/health', async () => {
      return { status: 'ok', version: PROXY_VERSION, time: new Date().toISOString() };
    });

    logger.info('[BOOT] Initializing CommandCode Proxy v4...');

    const activeApiKey = getActiveApiKey();
    if (activeApiKey) {
      fetchUpstreamModels(activeApiKey, config.ccVersion).catch(err => {
        logger.warn(`[BOOT] Model fetch background warning: ${err.message}`);
      });
      // 后台补全兜底账号的真实用户名（whoami），不阻塞启动；失败静默。
      enrichDefaultAccountName().catch(err => {
        logger.warn(`[BOOT] Account name enrichment warning: ${err?.message || err}`);
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

    // 燃烧速率采样：立即采一次拿到基线，之后定时差分。
    if (getActiveApiKey()) {
      sampleQuotaWindow().catch(() => {});
      setInterval(() => {
        sampleQuotaWindow().catch(err => logger.warn(`[QUOTA-SAMPLE] ${err?.message || err}`));
      }, QUOTA_SAMPLE_INTERVAL_MS);
      logger.info('[QUOTA-SAMPLE] Window usage sampler active (every 5m).');
    }

    // 预注册通知 AUMID：让第一条 toast 就能以 "CommandCode Proxy" 名义显示，
    // 而不是回退到 PowerShell。幂等，且失败只影响显示名，不阻断启动。
    if (process.platform === 'win32') {
      setImmediate(() => {
        try {
          ensureAumidRegistered();
          // 系统通知总开关若被关闭，toast 会被静默拒绝 —— 启动时就讲清楚。
          if (!isGlobalToastEnabled()) {
            logger.warn(
              '[NOTIFY] 系统通知总开关已关闭，桌面通知将不会显示。' +
              '修复路径：Windows 设置 → 系统 → 通知，打开总开关。'
            );
          }
        } catch { /* 非关键路径 */ }
      });
    }

    await fastify.listen({ port: config.port, host: config.host });

    const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    const dashboardUrl = `http://${displayHost}:${config.port}/`;

    console.log('\n=============================================================');
    console.log('  ⚡ CommandCode Proxy v4 is ACTIVE');
    console.log(`  🏷️  Version:                 ${PROXY_VERSION}`);
    console.log(`  🌐 Controller GUI:          ${dashboardUrl}`);
    console.log(`  🤖 OpenAI Chat Completions: ${dashboardUrl}v1/chat/completions`);
    console.log(`  💬 Anthropic Messages:      ${dashboardUrl}v1/messages`);
    console.log(`  🔒 Bound to:                ${config.host}${process.env.PROXY_API_KEY ? ' (API auth ON)' : ''}`);
    console.log('=============================================================\n');

    logger.info(`[SERVER] CommandCode Proxy v4 running on ${dashboardUrl}`);
    scheduleUpdateChecks();

    // 绑定到非回环地址 = API 与管理面对整个局域网可见。未设共享密钥时必须讲清楚后果。
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !process.env.PROXY_API_KEY) {
      logger.warn(
        '[SECURITY] 绑定在非回环地址且未设置 PROXY_API_KEY：局域网内任何人都可以调用 API ' +
        '并管理本网关（增删账号、切换 Key、清空历史）。建议设置 PROXY_API_KEY，或改回 127.0.0.1。'
      );
      console.warn('\n⚠️  局域网暴露且未鉴权：请设置 PROXY_API_KEY（见 README）或改回 127.0.0.1。\n');
    }

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
