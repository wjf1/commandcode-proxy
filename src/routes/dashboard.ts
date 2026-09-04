// =============================================================================
// 管理仪表盘（SPA + /api/* 后端接口）
// -----------------------------------------------------------------------------
// - 提供中文管理界面：概览、账号与鉴权、用量与额度、模型、实时日志五个标签页
// - /api/* 为管理员接口：状态、网关开关、日志、账号增删改、OAuth/手动登录、
//   用量聚合等
// - 安全要点：
//   * CORS 只对公共 API 表面（/v1/*、/health）开放；/api/* 不发 CORS 头，
//     防止浏览器里的随机网页驱动管理操作
//   * esc() 对所有动态渲染进 SPA 的 HTML 做转义，防止 XSS
// =============================================================================
import { FastifyInstance } from 'fastify';
import { logger } from '../utils/logger.js';
import {
  loadConfig,
  getGatewayRunning,
  setGatewayRunning,
  loginNewAccount,
  startBrowserLoginFlow,
  logoutAccount,
  setActiveAccount,
  setRotationMode,
  fetchLiveUsageStats,
  getActiveApiKey,
} from '../utils/config.js';
import { getCachedModels } from '../utils/models.js';
import { getUsageHistory, getUsageStats, clearUsageHistory } from '../utils/usage-store.js';

const startTimestamp = Date.now();

/** HTML 转义 —— 所有动态渲染进 SPA 的值都必须经过它。 */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function dashboardRoutes(fastify: FastifyInstance) {
  // 仅对公共 API 表面（/v1/*）开放 CORS。管理 /api/* 路由不发 CORS 头，
  // 这样浏览器里的随机网页就无法驱动它们。
  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/') || req.url === '/health') {
      reply.header('Access-Control-Allow-Origin', '*');
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

  fastify.get('/api/status', async () => {
    const config = loadConfig();
    const uptimeSec = Math.floor((Date.now() - startTimestamp) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const activeAcc = config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];

    return {
      status: 'active',
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
    };
  });

  fastify.post('/api/gateway/toggle', async (req: any) => {
    const body = req.body || {};
    if (body.running !== undefined) {
      setGatewayRunning(body.running);
      logger.info(`[DASHBOARD] Gateway engine toggled: ${body.running ? 'STARTED' : 'STOPPED'}`);
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
        : [{ id: 'acc_default', name: 'Default System Account', apiKey: getActiveApiKey() }];

    const results = await Promise.all(
      targetAccounts.map(async (acc: any) => {
        const stats = await fetchLiveUsageStats(acc.apiKey, config.ccApiBase, config.ccVersion);
        const who = stats.whoami?.user;
        return {
          account: {
            id: acc.id,
            name: acc.name || (who ? who.name || who.userName : 'Default System Account'),
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
      recent: records.slice(-limit).reverse(),
    };
  });

  fastify.post('/api/usage/clear', async () => {
    clearUsageHistory();
    return { status: 'success' };
  });

  // ─── 仪表盘 SPA ────────────────────────────────────────────────────────────

  fastify.get('/', async (_req, reply) => {
    reply.header('Content-Type', 'text/html');
    return `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CommandCode 代理控制器 v4</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}.tab-btn.active{border-bottom:2px solid #6366f1;color:#818cf8;font-weight:600}</style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col">

<header class="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-50">
  <div class="flex items-center space-x-3">
    <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20"><i class="fa-solid fa-bolt text-lg"></i></div>
    <div>
      <h1 class="font-bold text-lg leading-tight text-white flex items-center gap-2">CommandCode 代理 <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">v4</span></h1>
      <p class="text-xs text-slate-400">OpenAI Chat 与 Anthropic Messages 兼容网关</p>
    </div>
  </div>
  <div class="flex items-center space-x-4">
    <div class="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-xs">
      <span id="statusDot" class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
      <span id="statusText" class="font-medium text-slate-300">检测中...</span>
    </div>
    <button onclick="toggleEngine()" class="px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition shadow-md shadow-emerald-600/20"><i class="fa-solid fa-power-off"></i> <span id="toggleBtnText">切换</span></button>
  </div>
</header>

<nav class="border-b border-slate-800 bg-slate-900/40 px-6 flex space-x-8 text-sm text-slate-400">
  <button onclick="switchTab('overview')" id="tab-overview" class="tab-btn active py-3 flex items-center gap-2"><i class="fa-solid fa-gauge-high"></i> 概览</button>
  <button onclick="switchTab('accounts')" id="tab-accounts" class="tab-btn py-3 flex items-center gap-2"><i class="fa-solid fa-users-gear"></i> 账号与鉴权</button>
  <button onclick="switchTab('usage')" id="tab-usage" class="tab-btn py-3 flex items-center gap-2"><i class="fa-solid fa-chart-pie"></i> 用量与额度</button>
  <button onclick="switchTab('models')" id="tab-models" class="tab-btn py-3 flex items-center gap-2"><i class="fa-solid fa-cubes"></i> 模型</button>
  <button onclick="switchTab('logs')" id="tab-logs" class="tab-btn py-3 flex items-center gap-2"><i class="fa-solid fa-terminal"></i> 实时日志</button>
</nav>

<main class="flex-1 p-6 max-w-7xl w-full mx-auto space-y-6">

<section id="content-overview" class="space-y-6">
  <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">网关服务</p><h3 id="statPort" class="text-xl font-bold text-white mt-1">Port :9090</h3><p id="statUptime" class="text-xs text-indigo-400 mt-2">运行时间：0s</p></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">当前账号</p><h3 id="statAccount" class="text-xl font-bold text-white mt-1">None</h3><p id="statAccountsCount" class="text-xs text-slate-400 mt-2">0 个账号已注册</p></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">安全</p><h3 id="statBind" class="text-xl font-bold text-emerald-400 mt-1">127.0.0.1</h3><p id="statAuth" class="text-xs text-slate-400 mt-2">API 鉴权：关闭</p></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">可用模型</p><h3 id="statModels" class="text-xl font-bold text-white mt-1">0</h3><p class="text-xs text-emerald-400 mt-2"><i class="fa-solid fa-check"></i> 可用于对话</p></div>
  </div>
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
    <h2 class="text-md font-semibold text-white mb-4 flex items-center gap-2"><i class="fa-solid fa-link text-indigo-400"></i> 已启用的 API 接口</h2>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="p-4 bg-slate-950/60 border border-slate-800 rounded-lg"><span class="text-xs font-bold px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">POST</span><span class="font-mono text-sm text-slate-200 ml-2">/v1/chat/completions</span><p class="text-xs text-slate-400 mt-2">OpenAI 对话补全 — 工具、视觉、推理</p></div>
      <div class="p-4 bg-slate-950/60 border border-slate-800 rounded-lg"><span class="text-xs font-bold px-2 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20">POST</span><span class="font-mono text-sm text-slate-200 ml-2">/v1/messages</span><p class="text-xs text-slate-400 mt-2">Anthropic Messages — 工具调用、思考块</p></div>
      <div class="p-4 bg-slate-950/60 border border-slate-800 rounded-lg"><span class="text-xs font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">GET</span><span class="font-mono text-sm text-slate-200 ml-2">/v1/models</span><p class="text-xs text-slate-400 mt-2">上游实时模型目录</p></div>
    </div>
  </div>
</section>

<section id="content-accounts" class="space-y-6 hidden">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-lg font-bold text-white">多账号管理</h2>
      <p class="text-xs text-slate-400">使用 Command Code CLI 浏览器授权登录，或直接粘贴 API Key</p>
    </div>
    <div class="flex space-x-3">
      <button onclick="startBrowserLogin()" id="browserAuthBtn" class="px-4 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-lg text-xs font-semibold flex items-center gap-2 shadow-lg shadow-indigo-600/20"><i class="fa-solid fa-globe"></i> 浏览器登录（OAuth）</button>
      <button onclick="showLoginModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-2 border border-slate-700"><i class="fa-solid fa-key"></i> 手动输入 Key</button>
    </div>
  </div>
  <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl flex items-center justify-between">
    <div>
      <h3 class="text-sm font-semibold text-white">账号轮换策略</h3>
      <p class="text-xs text-slate-400">自动额度模式每 30 分钟检查 5 小时额度窗口，使用率 ≥90% 时自动切换</p>
    </div>
    <select id="rotationSelect" onchange="changeRotationMode(this.value)" class="bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 outline-none font-semibold">
      <option value="manual">手动选择</option>
      <option value="auto-quota">自动额度保护（30 分钟检查）</option>
    </select>
  </div>
  <div id="accountsGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
</section>

<section id="content-usage" class="space-y-6 hidden">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-lg font-bold text-white">实时用量与额度</h2>
      <p class="text-xs text-slate-400">各账号的实时余额与额度窗口</p>
    </div>
    <select id="usageAccountSelect" onchange="renderUsageForAccount(this.value)" class="bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 outline-none font-semibold"></select>
  </div>
  <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">月度额度</p><h3 id="creditMonthly" class="text-2xl font-extrabold text-emerald-400 mt-1">$0.00</h3></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">已购买</p><h3 id="creditPurchased" class="text-2xl font-extrabold text-indigo-400 mt-1">$0.00</h3></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">免费额度</p><h3 id="creditFree" class="text-2xl font-extrabold text-cyan-400 mt-1">$0.00</h3></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">总消费</p><h3 id="creditTotalCost" class="text-2xl font-extrabold text-purple-400 mt-1">$0.00</h3></div>
  </div>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
    <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-3">
      <div class="flex items-center justify-between"><h3 class="font-bold text-sm text-white"><i class="fa-solid fa-clock text-indigo-400"></i> 5 小时窗口</h3><span id="window5hText" class="text-xs font-semibold text-slate-300">$0.00 / $0.00</span></div>
      <div class="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800"><div id="window5hBar" class="bg-indigo-500 h-2.5 rounded-full transition-all duration-500" style="width:0%"></div></div>
      <p id="window5hReset" class="text-[11px] text-slate-400 text-right">重置时间：--</p>
    </div>
    <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-3">
      <div class="flex items-center justify-between"><h3 class="font-bold text-sm text-white"><i class="fa-solid fa-calendar-week text-violet-400"></i> 每周窗口</h3><span id="windowWeeklyText" class="text-xs font-semibold text-slate-300">$0.00 / $0.00</span></div>
      <div class="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800"><div id="windowWeeklyBar" class="bg-violet-500 h-2.5 rounded-full transition-all duration-500" style="width:0%"></div></div>
      <p id="windowWeeklyReset" class="text-[11px] text-slate-400 text-right">重置时间：--</p>
    </div>
  </div>

  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-md font-semibold text-white flex items-center gap-2"><i class="fa-solid fa-list-check text-indigo-400"></i> 会话明细</h2>
        <p class="text-xs text-slate-400 mt-0.5">经过本网关的每次请求：token、耗时、成本、模型、状态（持久化到本地）</p>
      </div>
      <button onclick="clearUsageHistory()" class="px-3 py-1.5 bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-200 text-xs rounded-lg flex items-center gap-1.5 border border-slate-700 transition"><i class="fa-solid fa-trash-can"></i> 清空历史</button>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
      <div class="bg-slate-950/60 border border-slate-800 p-4 rounded-lg"><p class="text-[11px] text-slate-400 font-medium">今日 Token</p><h3 id="usageTodayToken" class="text-lg font-bold text-white mt-1">--</h3><p id="usageTodayRuns" class="text-[11px] text-slate-400 mt-1">-- 次请求</p></div>
      <div class="bg-slate-950/60 border border-slate-800 p-4 rounded-lg"><p class="text-[11px] text-slate-400 font-medium">本周成本</p><h3 id="usageWeekCost" class="text-lg font-bold text-emerald-400 mt-1">--</h3><p id="usageWeekToken" class="text-[11px] text-slate-400 mt-1">--</p></div>
      <div class="bg-slate-950/60 border border-slate-800 p-4 rounded-lg"><p class="text-[11px] text-slate-400 font-medium">本月成本</p><h3 id="usageMonthCost" class="text-lg font-bold text-emerald-400 mt-1">--</h3><p id="usageMonthToken" class="text-[11px] text-slate-400 mt-1">--</p></div>
      <div class="bg-slate-950/60 border border-slate-800 p-4 rounded-lg"><p class="text-[11px] text-slate-400 font-medium">累计</p><h3 id="usageTotalToken" class="text-lg font-bold text-white mt-1">--</h3><p id="usageTotalRuns" class="text-[11px] text-slate-400 mt-1">-- 次请求 · <span id="usagePricingNote" class="text-amber-400 hidden"><i class="fa-solid fa-triangle-exclamation"></i> 未同步定价</span></p></div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
      <div class="bg-slate-950/60 border border-slate-800 p-4 rounded-lg">
        <h3 class="font-bold text-xs text-white mb-3"><i class="fa-solid fa-chart-line text-indigo-400"></i> 每日 Token 趋势</h3>
        <div class="h-56"><canvas id="usageTrendChart"></canvas></div>
      </div>
      <div class="bg-slate-950/60 border border-slate-800 p-4 rounded-lg">
        <h3 class="font-bold text-xs text-white mb-3"><i class="fa-solid fa-chart-pie text-violet-400"></i> 模型分布</h3>
        <div class="h-56"><canvas id="usageModelChart"></canvas></div>
      </div>
    </div>

    <div class="mt-4 bg-slate-950/40 border border-slate-800 rounded-lg overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-slate-800">
        <h3 class="font-bold text-xs text-white"><i class="fa-solid fa-table-list text-emerald-400"></i> 请求明细</h3>
        <span id="usageRecentCount" class="text-[11px] text-slate-400"></span>
      </div>
      <div class="overflow-x-auto max-h-[360px] overflow-y-auto">
        <table class="w-full text-xs text-left">
          <thead class="bg-slate-950/60 text-slate-400 sticky top-0 z-10">
            <tr>
              <th class="px-3 py-2 font-medium">时间</th>
              <th class="px-3 py-2 font-medium">模型</th>
              <th class="px-3 py-2 font-medium text-right">输入</th>
              <th class="px-3 py-2 font-medium text-right">输出</th>
              <th class="px-3 py-2 font-medium text-right">耗时</th>
              <th class="px-3 py-2 font-medium text-right">成本</th>
              <th class="px-3 py-2 font-medium">状态</th>
              <th class="px-3 py-2 font-medium">模式</th>
            </tr>
          </thead>
          <tbody id="usageTableBody" class="divide-y divide-slate-800/60"></tbody>
        </table>
        <p id="usageEmpty" class="text-center text-slate-500 text-xs py-8 hidden">暂无会话记录，触发一次对话后在这里查看。</p>
      </div>
    </div>
  </div>
</section>

<section id="content-models" class="space-y-4 hidden">
  <div class="flex items-center justify-between">
    <div><h2 class="text-lg font-bold text-white">上游实时模型</h2><p class="text-xs text-slate-400">官方定价目录 · 价格单位：人民币（元）/ 每 1M tokens</p></div>
    <button onclick="loadModels(true)" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg flex items-center gap-1.5"><i class="fa-solid fa-rotate"></i> 获取最新模型</button>
  </div>
  <div id="modelsList" class="grid grid-cols-1 md:grid-cols-3 gap-3"></div>
</section>

<section id="content-logs" class="space-y-4 hidden">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-bold text-white">网关事件控制台</h2>
    <div class="flex items-center space-x-2">
      <button onclick="clearLogs()" class="px-3 py-1.5 bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-200 text-xs rounded-lg flex items-center gap-1.5 border border-slate-700 transition"><i class="fa-solid fa-trash-can"></i> 清空日志</button>
      <button onclick="loadLogs()" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg flex items-center gap-1.5 border border-slate-700 transition"><i class="fa-solid fa-rotate"></i> 刷新日志</button>
    </div>
  </div>
  <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-300 h-[500px] overflow-y-auto space-y-1" id="logsBox"><p class="text-slate-500">正在初始化日志控制台...</p></div>
</section>

</main>

<div id="loginModal" class="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center hidden">
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 max-w-md w-full shadow-2xl space-y-4">
    <h3 class="text-base font-bold text-white flex items-center gap-2"><i class="fa-solid fa-key text-indigo-400"></i> 添加 Command Code API Key</h3>
    <div class="space-y-3">
      <div><label class="text-xs text-slate-300 block mb-1">账号昵称（可选）</label><input type="text" id="loginNickname" placeholder="例如：工作账号" class="w-full bg-slate-950 border border-slate-700 text-xs rounded-lg p-2.5 text-white outline-none focus:border-indigo-500"></div>
      <div><label class="text-xs text-slate-300 block mb-1">Command Code API Key</label><input type="password" id="loginApiKey" placeholder="user_..." class="w-full bg-slate-950 border border-slate-700 text-xs rounded-lg p-2.5 text-white outline-none focus:border-indigo-500"></div>
      <div id="loginError" class="text-xs text-rose-400 hidden"></div>
    </div>
    <div class="flex justify-end space-x-2 pt-2">
      <button onclick="hideLoginModal()" class="px-4 py-2 bg-slate-800 text-slate-300 rounded-lg text-xs font-medium">取消</button>
      <button onclick="submitLogin()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold">登录并保存</button>
    </div>
  </div>
</div>

<script>
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
let currentTab = 'overview';
let selectedUsageAccountId = '';
let globalUsageCache = [];

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('content-' + tab).classList.remove('hidden');
  currentTab = tab;
  if (tab === 'accounts') loadAccounts();
  if (tab === 'usage') { loadUsageInit(); loadUsageHistory(); }
  if (tab === 'models') loadModels(false);
  if (tab === 'logs') loadLogs();
}

async function fetchStatus() {
  try {
    const data = await (await fetch('/api/status')).json();
    const dot = document.getElementById('statusDot'), txt = document.getElementById('statusText'), btn = document.getElementById('toggleBtnText');
    if (data.running) { dot.className='w-2.5 h-2.5 rounded-full bg-emerald-500'; txt.innerText='引擎运行中'; txt.className='font-medium text-emerald-400'; btn.innerText='停止引擎'; }
    else { dot.className='w-2.5 h-2.5 rounded-full bg-rose-500'; txt.innerText='引擎已停止'; txt.className='font-medium text-rose-400'; btn.innerText='启动引擎'; }
    document.getElementById('statPort').innerText = 'Port :' + data.port;
    document.getElementById('statUptime').innerText = '运行时间：' + data.uptime;
    document.getElementById('statAccount').innerText = data.activeAccountName || '无';
    document.getElementById('statAccountsCount').innerText = '已注册 ' + data.accountsCount + ' 个账号';
    document.getElementById('statBind').innerText = data.host === '0.0.0.0' ? '0.0.0.0（局域网！）' : data.host;
    document.getElementById('statAuth').innerText = 'API 鉴权：' + (data.authRequired ? '开' : '关');
    document.getElementById('statModels').innerText = data.modelsCount;
    document.getElementById('rotationSelect').value = data.rotationMode;
  } catch {}
}

async function toggleEngine() {
  const data = await (await fetch('/api/status')).json();
  await fetch('/api/gateway/toggle', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ running: !data.running }) });
  fetchStatus();
}

async function startBrowserLogin() {
  const btn = document.getElementById('browserAuthBtn');
  const original = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在等待浏览器授权...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/browser-login', { method:'POST' });
    const data = await res.json();
    if (res.ok && data.status === 'success') { alert('登录成功：' + data.account.name); loadAccounts(); fetchStatus(); }
    else alert('浏览器登录失败：' + (data.error || '未知错误'));
  } catch (e) { alert('浏览器登录失败：' + e.message); }
  finally { btn.innerHTML = original; btn.disabled = false; }
}

function showLoginModal(){ document.getElementById('loginModal').classList.remove('hidden'); }
function hideLoginModal(){ document.getElementById('loginModal').classList.add('hidden'); }

async function submitLogin() {
  const apiKey = document.getElementById('loginApiKey').value.trim();
  const name = document.getElementById('loginNickname').value.trim();
  const errEl = document.getElementById('loginError');
  if (!apiKey) { errEl.innerText='API Key 不能为空'; errEl.classList.remove('hidden'); return; }
  const res = await fetch('/api/auth/manual-login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ apiKey, name }) });
  const data = await res.json();
  if (res.ok && data.status === 'success') { hideLoginModal(); document.getElementById('loginApiKey').value=''; loadAccounts(); fetchStatus(); }
  else { errEl.innerText = data.error || '登录失败'; errEl.classList.remove('hidden'); }
}

async function loadAccounts() {
  const data = await (await fetch('/api/accounts')).json();
  const grid = document.getElementById('accountsGrid');
  grid.innerHTML = data.accounts.map(acc =>
    '<div class="bg-slate-900 border ' + (acc.isActive ? 'border-indigo-500 shadow-lg shadow-indigo-500/10' : 'border-slate-800') + ' p-5 rounded-xl space-y-3">' +
      '<div class="flex items-center justify-between">' +
        '<div class="flex items-center space-x-3">' +
          '<div class="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold text-xs">' + esc((acc.name||'?').charAt(0).toUpperCase()) + '</div>' +
          '<div><h4 class="font-bold text-sm text-white flex items-center gap-2">' + esc(acc.name) +
          (acc.isActive ? ' <span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">当前</span>' : '') +
          '</h4><p class="text-xs text-slate-400">' + esc(acc.userName ? '@'+acc.userName : (acc.email || 'API Key')) + '</p></div>' +
        '</div>' +
        '<div class="flex items-center space-x-2">' +
          (!acc.isActive ? '<button onclick="setActiveAcc(\\'' + esc(acc.id) + '\\')" class="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-indigo-400 rounded-lg border border-slate-700">设为当前</button>' : '') +
          '<button onclick="deleteAcc(\\'' + esc(acc.id) + '\\')" class="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition"><i class="fa-solid fa-trash-can text-xs"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">' +
        '<span>Key：<code class="font-mono text-slate-300">' + esc(acc.apiKeyMasked) + '</code></span>' +
        '<span>添加于：' + esc(new Date(acc.addedAt).toLocaleDateString()) + '</span>' +
      '</div>' +
    '</div>'
  ).join('');
}

async function setActiveAcc(id){ await fetch('/api/accounts/active',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:id})}); loadAccounts(); fetchStatus(); }
async function deleteAcc(id){ if(!confirm('确定移除该账号？'))return; await fetch('/api/accounts/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:id})}); loadAccounts(); fetchStatus(); }
async function changeRotationMode(mode){ await fetch('/api/accounts/rotation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rotationMode:mode})}); fetchStatus(); }

async function loadUsageInit() {
  const data = await (await fetch('/api/usage/aggregate')).json();
  globalUsageCache = data.accountsUsage || [];
  const select = document.getElementById('usageAccountSelect');
  select.innerHTML = globalUsageCache.map(u => '<option value="' + esc(u.account.id) + '">' + esc(u.account.name) + ' (' + esc(u.account.apiKeyMasked) + ')' + (u.account.isActive?' [当前]':'') + '</option>').join('');
  if (!selectedUsageAccountId && globalUsageCache.length > 0) selectedUsageAccountId = globalUsageCache[0].account.id;
  select.value = selectedUsageAccountId;
  renderUsageForAccount(selectedUsageAccountId);
}

function renderUsageForAccount(accId) {
  selectedUsageAccountId = accId;
  const t = globalUsageCache.find(u => u.account.id === accId) || globalUsageCache[0];
  if (!t) return;
  const credits = t.credits?.credits || {};
  document.getElementById('creditMonthly').innerText = '$' + (credits.monthlyCredits||0).toFixed(2);
  document.getElementById('creditPurchased').innerText = '$' + (credits.purchasedCredits||0).toFixed(2);
  document.getElementById('creditFree').innerText = '$' + (credits.freeCredits||0).toFixed(2);
  document.getElementById('creditTotalCost').innerText = '$' + (t.summary?.totalCost||0).toFixed(2);

  const w5h = t.credits?.windowLimits?.fiveHour;
  if (w5h) {
    document.getElementById('window5hText').innerText = '$' + w5h.used.toFixed(2) + ' / $' + w5h.cap.toFixed(2);
    const ratio = w5h.cap > 0 ? (w5h.used/w5h.cap)*100 : 0;
    const bar = document.getElementById('window5hBar');
    bar.style.width = Math.min(100,ratio)+'%';
    bar.className = ratio>=90?'bg-rose-500 h-2.5 rounded-full':ratio>=70?'bg-amber-500 h-2.5 rounded-full':'bg-indigo-500 h-2.5 rounded-full';
    const mins = w5h.resetAt ? Math.max(0,Math.ceil((w5h.resetAt-Date.now())/60000)) : 0;
    document.getElementById('window5hReset').innerText = '重置时间：'+mins+' 分钟';
  }
  const wk = t.credits?.windowLimits?.weekly;
  if (wk) {
    document.getElementById('windowWeeklyText').innerText = '$' + wk.used.toFixed(2) + ' / $' + wk.cap.toFixed(2);
    const ratio = wk.cap > 0 ? (wk.used/wk.cap)*100 : 0;
    const bar = document.getElementById('windowWeeklyBar');
    bar.style.width = Math.min(100,ratio)+'%';
    bar.className = ratio>=90?'bg-rose-500 h-2.5 rounded-full':'bg-violet-500 h-2.5 rounded-full';
    const hrs = wk.resetAt ? Math.max(0,Math.ceil((wk.resetAt-Date.now())/3600000)) : 0;
    document.getElementById('windowWeeklyReset').innerText = '重置时间：'+hrs+' 小时';
  }
}

function fmtPrice(v){ if(v===undefined||v===null) return '--'; if(v===0) return 'FREE'; var c=v*6.72; c=c>=100?Math.round(c):Math.round(c*100)/100; return '¥' + c; }
function fmtCtx(v){ if(!v) return '--'; if(v>=1000000){ var x=(v/1000000); return (x%1===0?x:x.toFixed(1)) + 'M'; } if(v>=1000){ var k=v/1000; return (k%1===0?k:k.toFixed(1)) + 'K'; } return String(v); }
async function loadModels(force) {
  if (force) { await fetch('/v1/models/refresh', { method:'POST' }).catch(()=>{}); }
  const data = await (await fetch('/v1/models')).json();
  const c = document.getElementById('modelsList');
  c.innerHTML = (data.data||[]).map(m => {
    const p = m.pricing||{};
    const caps = m.caps||{};
    let tags = '';
    if (m.onGoPlan) tags += '<span class="text-[10px] px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-semibold">GO</span>';
    if (m.deal && m.deal.free) tags += '<span class="text-[10px] px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 font-semibold">FREE</span>';
    else if (m.deal && m.deal.discountPercent) tags += '<span class="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold">DEAL ' + m.deal.discountPercent + '%</span>';
    if (!tags) tags = '<span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">可用</span>';
    const capsStr = '文字' + (caps.text?'✓':'✗') + ' · 视觉' + (caps.vision?'✓':'✗') + ' · 推理' + (caps.reasoning?'✓':'✗');
    return '<div class="p-3 bg-slate-900 border border-slate-800 rounded-lg">' +
      '<div class="flex items-start justify-between gap-2">' +
        '<div class="min-w-0"><p class="font-bold text-xs text-white break-all">' + esc(m.id) + '</p>' +
        '<p class="text-[11px] text-slate-400 mt-0.5">提供商：' + esc(m.owned_by) + '</p></div>' +
        '<div class="flex gap-1 flex-wrap justify-end">' + tags + '</div>' +
      '</div>' +
      '<div class="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-slate-400">' +
        '<span>上下文：<span class="text-slate-200">' + fmtCtx(m.context_window || m.context_length) + '</span></span>' +
        '<span>输入：<span class="text-slate-200">' + fmtPrice(p.input) + '</span></span>' +
        '<span>输出：<span class="text-slate-200">' + fmtPrice(p.output) + '</span></span>' +
        '<span>缓存读：<span class="text-slate-200">' + fmtPrice(p.cacheRead) + '</span></span>' +
        '<span>缓存写：<span class="text-slate-200">' + fmtPrice(p.cacheWrite) + '</span></span>' +
        '<span class="text-slate-500">' + capsStr + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function loadLogs() {
  const data = await (await fetch('/api/logs')).json();
  const box = document.getElementById('logsBox');
  box.innerHTML = data.logs.map(l => {
    const lc = l.level==='error'?'text-rose-400':l.level==='warn'?'text-amber-400':'text-slate-300';
    return '<p class="'+lc+' font-mono text-[11px] py-0.5 break-all"><span class="text-slate-500">['+esc(l.timestamp)+']</span> '+esc(l.message)+'</p>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function clearLogs(){ await fetch('/api/logs/clear',{method:'POST'}); loadLogs(); }

// ─── 会话明细 ────────────────────────────────────────────────────────────────
let usageTrendChart = null;
let usageModelChart = null;
let usageHistoryCache = null;

function fmtTokens(n){ if(!n) return '0'; if(n>=1000000){var x=n/1000000; return (x%1===0?x:x.toFixed(1))+'M';} if(n>=1000){var k=n/1000; return (k%1===0?k:k.toFixed(1))+'K';} return String(n); }
function fmtUsd(v){ return '$' + (v||0).toFixed(4); }
function fmtMs(ms){ if(!ms) return '--'; if(ms>=60000){var m=Math.floor(ms/60000),s=(ms%60000)/1000; return m+'m '+s.toFixed(1)+'s';} if(ms>=1000) return (ms/1000).toFixed(1)+'s'; return Math.round(ms)+'ms'; }
function fmtTime(ts){ try { const d=new Date(ts); return d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); } catch { return ts; } }

async function loadUsageHistory(){
  usageHistoryCache = await (await fetch('/api/usage/history')).json();
  const data = usageHistoryCache;
  const s = data.total;

  document.getElementById('usageTodayToken').innerText = fmtTokens(data.today.input + data.today.output) + ' token';
  document.getElementById('usageTodayRuns').innerText = data.today.runs + ' 次请求';
  document.getElementById('usageWeekCost').innerText = fmtUsd(data.week.cost);
  document.getElementById('usageWeekToken').innerText = fmtTokens(data.week.input + data.week.output) + ' token · ' + data.week.runs + ' 次';
  document.getElementById('usageMonthCost').innerText = fmtUsd(data.month.cost);
  document.getElementById('usageMonthToken').innerText = fmtTokens(data.month.input + data.month.output) + ' token · ' + data.month.runs + ' 次';
  document.getElementById('usageTotalToken').innerText = fmtTokens(s.inputTokens + s.outputTokens) + ' token';
  document.getElementById('usageTotalRuns').innerText = s.runs + ' 次请求 · 失败 ' + s.failures;

  const hasAnyPricing = (data.recent||[]).some(r => r.hasPricing);
  document.getElementById('usagePricingNote').classList.toggle('hidden', hasAnyPricing);
  document.getElementById('usageRecentCount').innerText = '最近 ' + (data.recent||[]).length + ' 条';

  renderUsageTable(data.recent||[]);
  renderUsageCharts(data);
}

function renderUsageTable(recent){
  const body = document.getElementById('usageTableBody');
  const empty = document.getElementById('usageEmpty');
  if (!recent.length) { body.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  body.innerHTML = recent.map(r => {
    const badge = r.status === 'FAILED'
      ? '<span class="px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">失败</span>'
      : '<span class="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">完成</span>';
    const pc = r.hasPricing ? '' : '<span class="text-amber-400" title="未同步官方定价">*</span>';
    const mode = r.mode === 'messages' ? 'Messages' : 'Chat';
    return '<tr class="hover:bg-slate-800/40 transition">' +
      '<td class="px-4 py-2.5 whitespace-nowrap text-slate-300">' + esc(fmtTime(r.timestamp)) + '</td>' +
      '<td class="px-4 py-2.5 text-slate-200 font-mono">' + esc(r.model) + '</td>' +
      '<td class="px-4 py-2.5 text-right text-slate-300">' + fmtTokens(r.inputTokens) + '</td>' +
      '<td class="px-4 py-2.5 text-right text-slate-300">' + fmtTokens(r.outputTokens) + '</td>' +
      '<td class="px-4 py-2.5 text-right text-slate-400">' + fmtMs(r.timingMs) + '</td>' +
      '<td class="px-4 py-2.5 text-right text-emerald-400">' + fmtUsd(r.costUsd) + pc + '</td>' +
      '<td class="px-4 py-2.5">' + badge + '</td>' +
      '<td class="px-4 py-2.5 text-slate-400">' + mode + '</td>' +
    '</tr>';
  }).join('');
}

function renderUsageCharts(data){
  // 每日趋势
  const tctx = document.getElementById('usageTrendChart').getContext('2d');
  if (usageTrendChart) usageTrendChart.destroy();
  usageTrendChart = new Chart(tctx, {
    type: 'line',
    data: {
      labels: data.byDay.map(d => d.date),
      datasets: [
        { label:'输入', data: data.byDay.map(d => d.inputTokens), borderColor:'#818cf8', backgroundColor:'rgba(129,140,248,.1)', fill:true, tension:.3, pointRadius:2 },
        { label:'输出', data: data.byDay.map(d => d.outputTokens), borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.1)', fill:true, tension:.3, pointRadius:2 }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{ labels:{ color:'#94a3b8', font:{size:11} } }, tooltip:{ backgroundColor:'#0f172a', borderColor:'#334155', borderWidth:1 } },
      scales:{ x:{ ticks:{ color:'#64748b', font:{size:10} }, grid:{ color:'rgba(51,65,85,.3)' } }, y:{ ticks:{ color:'#64748b', font:{size:10} }, grid:{ color:'rgba(51,65,85,.3)' }, beginAtZero:true } }
    }
  });

  // 模型分布
  const mctx = document.getElementById('usageModelChart').getContext('2d');
  if (usageModelChart) usageModelChart.destroy();
  const palette = ['#818cf8','#34d399','#f59e0b','#f472b6','#38bdf8','#a78bfa','#fb923c'];
  usageModelChart = new Chart(mctx, {
    type: 'doughnut',
    data: {
      labels: data.byModel.map(m => m.model),
      datasets: [{
        data: data.byModel.map(m => m.runs),
        backgroundColor: data.byModel.map((_,i) => palette[i % palette.length]),
        borderColor:'#0f172a', borderWidth:2
      }]
    },
    options: {
      responsive:true, maintainAspectRatio:false, cutout:'55%',
      plugins:{ legend:{ labels:{ color:'#94a3b8', font:{size:11} } }, tooltip:{ backgroundColor:'#0f172a', borderColor:'#334155', borderWidth:1, callbacks:{ label: c => ' ' + c.label + ' · ' + c.parsed + ' 次' } } }
    }
  });
}

async function clearUsageHistory(){
  if(!confirm('确定清空全部会话历史？此操作不可撤销。')) return;
  await fetch('/api/usage/clear',{method:'POST'});
  loadUsageHistory();
}

fetchStatus();
setInterval(fetchStatus, 5000);
setInterval(() => { if(currentTab === 'usage') loadUsageHistory(); }, 30000);
</script>
</body>
</html>`;
  });
}
