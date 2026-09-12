// =============================================================================
// 管理仪表盘（/api/* 后端接口；SPA 本体在 public/index.html）
// -----------------------------------------------------------------------------
// - 提供中文管理界面：概览、账号与鉴权、用量与额度、模型、实时日志五个标签页
// - /api/* 为管理员接口：状态、网关开关、日志、账号增删改、OAuth/手动登录、
//   用量聚合等
// - 安全要点：
//   * CORS 只对公共 API 表面（/v1/*、/health）开放；/api/* 不发 CORS 头，
//     防止浏览器里的随机网页驱动管理操作
//   * esc() 对所有动态渲染进 SPA 的 HTML 做转义，防止 XSS
// =============================================================================
import fs from 'fs';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { logger, LOG_FILE_PATH } from '../utils/logger.js';
import { getUpdateState } from '../utils/update-check.js';
import { getProjectRootDir } from '../utils/config.js';
import { isSameOriginIfPresent } from './sse-common.js';
import {
  loadConfig,
  resolveBodyLimit,
  CONFIG_FILE_PATH,
  getGatewayRunning,
  setGatewayRunning,
  loginNewAccount,
  startBrowserLoginFlow,
  logoutAccount,
  setActiveAccount,
  setRotationMode,
  fetchLiveUsageStatsCached,
  getActiveApiKey,
  defaultAccountName,
} from '../utils/config.js';
import { getCachedModels, MODELS_FILE_PATH } from '../utils/models.js';
import { planName, planTier } from '../utils/plans.js';
import { PROXY_VERSION } from '../utils/version.js';
import { getUsageHistory, getUsageStats, clearUsageHistory, describeBillingWindow, getTimeOfDayModels, USAGE_FILE_PATH, getTodaySpendUsd } from '../utils/usage-store.js';
import { getQuotaProjection } from '../utils/quota-tracker.js';
import { notify } from '../utils/notifier.js';

const startTimestamp = Date.now();

export async function dashboardRoutes(fastify: FastifyInstance) {
  // 仅对公共 API 表面（/v1/*）开放 CORS。管理 /api/* 路由不发 CORS 头，
  // 这样浏览器里的随机网页就无法驱动它们。
  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/') || req.url === '/health') {
      reply.header('Access-Control-Allow-Origin', '*');
    }
    // 防跨站驱动管理操作：CORS 只能阻止"读响应"，阻止不了"发请求"。
    // 校验逻辑见 isSameOriginIfPresent（纯函数，tests/guard.test.ts 锁定）。
    if (req.url.startsWith('/api/') && !['GET', 'OPTIONS', 'HEAD'].includes(req.method)) {
      if (!isSameOriginIfPresent(req.headers.origin as string | undefined, req.headers.host as string | undefined)) {
        return reply.status(403).send({ error: 'Cross-origin admin request rejected' });
      }
    }
    // 仪表盘 HTML 与管理 API 禁用缓存：升级后浏览器不会再用旧页面调新接口。
    if (req.url === '/' || req.url.startsWith('/api/') || req.url.startsWith('/?')) {
      reply.header('Cache-Control', 'no-cache');
    }
  });
  fastify.options('/v1/*', async (_req, reply) => {
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version')
      .status(204)
      .send();
  });

  // ── 本地化静态资源（原 CDN：tailwind / font-awesome / chart.js）────────────
  // 离线或 CDN 被墙时仪表盘不再掉样式、丢图表。文件随仓库 public/vendor/ 分发，
  // pkg 打包时列入 assets。
  const VENDOR_DIR = path.join(getProjectRootDir(), 'public', 'vendor');
  const DASHBOARD_HTML_PATH = path.join(getProjectRootDir(), 'public', 'index.html');
  const VENDOR_TYPES: Record<string, string> = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };
  fastify.get('/assets/vendor/*', async (req, reply) => {
    const rel = decodeURIComponent(String((req.params as any)['*'] || ''));
    if (!rel || rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) {
      return reply.status(404).send();
    }
    const file = path.join(VENDOR_DIR, ...rel.split('/'));
    try {
      const data = await fs.promises.readFile(file);
      const ext = path.extname(file).toLowerCase();
      return reply
        .header('Content-Type', VENDOR_TYPES[ext] || 'application/octet-stream')
        .header('Cache-Control', 'public, max-age=86400')
        .send(data);
    } catch {
      return reply.status(404).send();
    }
  });

  fastify.get('/api/status', async () => {
    const config = loadConfig();
    const uptimeSec = Math.floor((Date.now() - startTimestamp) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const activeAcc = config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];

    return {
      status: 'active',
      version: PROXY_VERSION,
      running: getGatewayRunning(),
      uptime: `${hrs}h ${mins}m ${secs}s`,
      port: config.port,
      host: config.host,
      apiBase: config.ccApiBase,
      cliVersion: config.ccVersion,
      rotationMode: config.rotationMode,
      activeAccountId: config.activeAccountId || activeAcc?.id || '',
      activeAccountName: activeAcc?.name || 'None',
      accountsCount: config.accounts.length,
      hasApiKey: !!getActiveApiKey(),
      modelsCount: getCachedModels().length,
      authRequired: !!process.env.PROXY_API_KEY,
      // 绑定非回环地址 = API 与管理面对局域网可见；未设 PROXY_API_KEY 时前端要醒目警示
      boundNonLoopback: !['127.0.0.1', 'localhost', '::1'].includes(config.host),
      // 版本更新检查（尽力而为，离线时 latest 为 null）
      update: getUpdateState(),
    };
  });

  // 只读运行配置视图：一眼可查部署参数（不含任何密钥）。
  fastify.get('/api/config', async () => {
    const config = loadConfig();
    return {
      version: PROXY_VERSION,
      port: config.port,
      host: config.host,
      apiBase: config.ccApiBase,
      cliVersion: config.ccVersion,
      rotationMode: config.rotationMode,
      accountsCount: config.accounts.length,
      upstream: {
        timeoutMs: config.upstreamTimeoutMs,
        idleTimeoutMs: config.idleTimeoutMs,
        maxRetries: config.maxRetries,
      },
      limits: {
        maxBodyMb: Math.round(resolveBodyLimit() / 1048576),
        todaySpendUsd: Math.round(getTodaySpendUsd() * 100) / 100,
        maxUpstreamConcurrency: process.env.MAX_UPSTREAM_CONCURRENCY || 'unlimited',
        dailyBudgetUsd: process.env.DAILY_BUDGET_USD || 'off',
      },
      paths: {
        config: CONFIG_FILE_PATH,
        log: LOG_FILE_PATH,
        usageHistory: USAGE_FILE_PATH,
        modelsCache: MODELS_FILE_PATH,
      },
      update: getUpdateState(),
    };
  });

  fastify.post('/api/gateway/toggle', async (req: any) => {
    const body = req.body || {};
    if (body.running !== undefined) {
      setGatewayRunning(body.running);
      logger.info(`[DASHBOARD] Gateway engine toggled: ${body.running ? 'STARTED' : 'STOPPED'}`);
      // 引擎暂停意味着所有经过代理的请求都会被拒，用户多半不在面板前。
      if (body.running === false) {
        notify('engine-paused', 'CommandCode 引擎已暂停', '代理将拒绝新的 /v1/* 请求，直到在面板恢复', 'warn');
      }
    }
    return { status: 'success', running: getGatewayRunning() };
  });

  fastify.get('/api/logs', async () => ({ logs: logger.getLogs() }));

  fastify.post('/api/logs/clear', async () => {
    logger.clearLogs();
    logger.info('[DASHBOARD] Log console cleared.');
    return { status: 'success' };
  });

  fastify.get('/api/accounts', async () => {
    const config = loadConfig();
    const safeAccounts = config.accounts.map(a => ({
      id: a.id,
      name: a.name,
      userName: a.userName,
      email: a.email,
      addedAt: a.addedAt,
      apiKeyMasked: a.apiKey ? `${a.apiKey.slice(0, 8)}...${a.apiKey.slice(-4)}` : 'None',
      isActive: a.id === config.activeAccountId,
    }));
    return {
      activeAccountId: config.activeAccountId,
      rotationMode: config.rotationMode,
      accounts: safeAccounts,
    };
  });

  fastify.post('/api/accounts/active', async (req: any, reply) => {
    const { accountId } = req.body || {};
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    setActiveAccount(accountId);
    return { status: 'success', activeAccountId: accountId };
  });

  fastify.post('/api/accounts/delete', async (req: any, reply) => {
    const { accountId } = req.body || {};
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    logoutAccount(accountId);
    return { status: 'success' };
  });

  fastify.post('/api/accounts/rotation', async (req: any, reply) => {
    const { rotationMode } = req.body || {};
    if (rotationMode !== 'manual' && rotationMode !== 'auto-quota') {
      return reply.status(400).send({ error: 'rotationMode must be manual|auto-quota' });
    }
    setRotationMode(rotationMode);
    return { status: 'success', rotationMode };
  });

  fastify.post('/api/auth/manual-login', async (req: any, reply) => {
    const { apiKey, name } = req.body || {};
    if (!apiKey) return reply.status(400).send({ error: 'API key is required' });
    try {
      const acc = await loginNewAccount(String(apiKey), name ? String(name).slice(0, 60) : undefined);
      return { status: 'success', account: acc };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.post('/api/auth/browser-login', async (_req, reply) => {
    try {
      logger.info('[DASHBOARD] Triggering CLI Browser OAuth Login flow...');
      const newAcc = await startBrowserLoginFlow(5959);
      return { status: 'success', account: newAcc };
    } catch (err: any) {
      logger.error(`[DASHBOARD] Browser Login flow error: ${err.message}`);
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.get('/api/usage/aggregate', async () => {
    const config = loadConfig();
    const targetAccounts =
      config.accounts.length > 0
        ? config.accounts
        : [{ id: 'acc_default', name: defaultAccountName(getActiveApiKey(), ''), apiKey: getActiveApiKey() }];

    const results = await Promise.all(
      targetAccounts.map(async (acc: any) => {
        const stats = await fetchLiveUsageStatsCached(acc.apiKey, config.ccApiBase, config.ccVersion);
        const who = stats.whoami?.user;
        return {
          account: {
            id: acc.id,
            name: acc.name || (who ? who.name || who.userName : defaultAccountName(acc.apiKey, '')),
            userName: acc.userName || who?.userName || 'system_user',
            email: acc.email || who?.email || 'System Auth Key',
            isActive: acc.id === config.activeAccountId || targetAccounts.length === 1,
            apiKeyMasked: acc.apiKey ? `${acc.apiKey.slice(0, 8)}...${acc.apiKey.slice(-4)}` : 'None',
          },
          ...stats,
        };
      })
    );
    return { accountsUsage: results };
  });

  // ─── 官方用量总览（对齐 commandcode.ai usage 页数据源）────────────────────────
  //
  // 页面的 Total Tokens / Total Runs / Usage Limits 分别来自
  // /internal/usage/summary 与 /internal/billing/credits（仅认 Web Cookie），
  // 这里改走字段一致的 CLI 通道 /alpha/usage/summary 与 /alpha/billing/credits。
  fastify.get('/api/usage/overview', async () => {
    const config = loadConfig();
    const acc = config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];
    if (!acc || !acc.apiKey) {
      return { error: 'No active Command Code account' };
    }
    const stats = await fetchLiveUsageStatsCached(acc.apiKey, config.ccApiBase, config.ccVersion);
    const s = stats.summary || {};
    const credits = stats.credits?.credits || {};
    const wl = stats.credits?.windowLimits || {};
    const monthlyUsed = Number(s.totalMonthlyCredits) || 0;
    const monthlyRemaining = Number(credits.monthlyCredits) || 0;
    const pct = (used: unknown, cap: unknown) => {
      const u = Number(used) || 0;
      const c = Number(cap) || 0;
      return c > 0 ? Math.min(100, Math.round((u / c) * 1000) / 10) : 0;
    };

    // ── 套餐与计费周期（/alpha/billing/subscriptions）──────────────────────────
    // 订阅额度在续费时刷新，未用完的部分不会结转，因此周期信息对"要不要升档"
    // 的判断很关键；之前这里只取了 credits/summary，完全没读订阅周期。
    const sub: any = stats.subscription?.data ?? stats.subscription ?? {};
    const planId = typeof sub.planId === 'string' ? sub.planId : '';
    const tier = planTier(planId);
    const toMs = (v: unknown): number => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const t = Date.parse(v);
        if (Number.isFinite(t)) return t;
      }
      return 0;
    };
    const periodStart = toMs(sub.currentPeriodStart);
    const periodEnd = toMs(sub.currentPeriodEnd);
    const cycle = (() => {
      if (!periodStart || !periodEnd || periodEnd <= periodStart) return null;
      const totalDays = (periodEnd - periodStart) / 86_400_000;
      const elapsedDays = Math.min(Math.max((Date.now() - periodStart) / 86_400_000, 0), totalDays);
      return {
        totalDays: Math.round(totalDays * 100) / 100,
        daysElapsed: Math.round(elapsedDays * 100) / 100,
        daysLeft: Math.max(0, Math.ceil((periodEnd - Date.now()) / 86_400_000)),
        cyclePct: Math.round((elapsedDays / totalDays) * 1000) / 10,
      };
    })();

    return {
      account: {
        id: acc.id,
        name: acc.name || stats.whoami?.user?.name || defaultAccountName(acc.apiKey, ''),
        userName: acc.userName || stats.whoami?.user?.userName || '',
      },
      plan: planId
        ? {
            planId,
            name: planName(planId),
            status: sub.status || '',
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
            monthlyCredits: tier?.monthlyCredits,
            fiveHourCap: tier?.fiveHourCap,
            weeklyCap: tier?.weeklyCap,
            currentPeriodStart: periodStart || null,
            currentPeriodEnd: periodEnd || null,
            ...(cycle ?? {}),
          }
        : null,
      summary: {
        totalTokens: Number(s.totalTokens) || 0,
        totalTokensIn: Number(s.totalTokensIn) || 0,
        totalTokensOut: Number(s.totalTokensOut) || 0,
        totalRuns: Number(s.totalCount) || 0,
        completedCount: Number(s.completedCount) || 0,
        failedCount: Number(s.failedCount) || 0,
        successRate: Number(s.successRate) || 0,
        totalCost: Number(s.totalCost) || 0,
        periodBasis: s.periodBasis || 'billing-period',
      },
      limits: {
        fiveHour: wl.fiveHour
          ? { used: wl.fiveHour.used, cap: wl.fiveHour.cap, pct: pct(wl.fiveHour.used, wl.fiveHour.cap), exceeded: !!wl.fiveHour.exceeded, resetAt: wl.fiveHour.resetAt || 0 }
          : null,
        weekly: wl.weekly
          ? { used: wl.weekly.used, cap: wl.weekly.cap, pct: pct(wl.weekly.used, wl.weekly.cap), exceeded: !!wl.weekly.exceeded, resetAt: wl.weekly.resetAt || 0 }
          : null,
        monthly: {
          used: monthlyUsed,
          remaining: monthlyRemaining,
          cap: Math.round((monthlyUsed + monthlyRemaining) * 100) / 100,
          pct: pct(monthlyUsed, monthlyUsed + monthlyRemaining),
        },
      },
      sources: {
        tokensAndRuns: '/alpha/usage/summary',
        limits: '/alpha/billing/credits',
      },
    };
  });

  // ─── 会话明细历史 ────────────────────────────────────────────────────────────

  fastify.get('/api/usage/history', async () => {
    const records = getUsageHistory();
    const stats = getUsageStats();
    const limit = 200;
    return {
      total: stats.total,
      today: stats.today,
      week: stats.week,
      month: stats.month,
      byDay: stats.byDay,
      byModel: stats.byModel,
      byModelPerf: stats.byModelPerf,
      byProject: stats.byProject,
      bySession: stats.bySession,
      attribution: stats.attribution,
      recent: records.slice(-limit).reverse(),
      quotaProjection: getQuotaProjection(),
      // 峰谷计费状态：受分时价影响的模型此刻按哪档计费、何时切换。
      billing: {
        window: describeBillingWindow(),
        models: getTimeOfDayModels(),
      },
    };
  });

  fastify.post('/api/usage/clear', async () => {
    clearUsageHistory();
    return { status: 'success' };
  });

  // ─── 仪表盘 SPA ────────────────────────────────────────────────────────────

  // ── 仪表盘 SPA ────────────────────────────────────────────────────────────
  // 页面本体是静态文件 public/index.html（v4.9.3 起从模板字符串迁出，可独立
  // 编辑与测试）；pkg 打包时列入 assets。禁用缓存：升级后浏览器不会再用旧
  // 页面调新接口。
  fastify.get('/', async (_req, reply) => {
    try {
      const html = await fs.promises.readFile(DASHBOARD_HTML_PATH, 'utf-8');
      return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
    } catch (err: any) {
      logger.error(`[DASHBOARD] Failed to load public/index.html: ${err.message}`);
      return reply.status(500).send('Dashboard assets missing: public/index.html not found.');
    }
  });
}
