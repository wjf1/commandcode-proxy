// =============================================================================
// GET /api/features —— 运行能力开关只读端点
// -----------------------------------------------------------------------------
// fastify.inject 端到端（不监听端口），模式与 guard.test.ts / prompt-versions.test.ts
// 一致。/api/features 是纯只读视图：env 判定逻辑必须与各能力模块"调用时读 env"
// 的行为逐条对齐，因此每个用例自行设置/清理 env，afterAll 统一还原，避免串扰
// 同进程其它测试文件。
//
// 安全红线：WEBHOOK_URL 只回 enabled，URL 本身（内网地址、token 参数）绝不出现在
// 响应体里 —— 有专测锁死。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import os from 'os';
import path from 'path';
import { dashboardRoutes } from '../src/routes/dashboard.js';

describe('GET /api/features', () => {
  let app: Fastify.FastifyInstance;
  /** 本文件触碰过的 env → 进入前的值，afterAll 原样还原。 */
  const saved = new Map<string, string | undefined>();
  const FEATURE_ENVS = [
    'RATE_LIMIT_RPM', 'RATE_LIMIT_TPM',
    'MODEL_ALLOWLIST', 'MODEL_BLOCKLIST',
    'AUDIT_LOG', 'AUDIT_LOG_PATH',
    'PROMPT_VERSIONS', 'PROMPTS_DIR',
    'WEBHOOK_URL', 'WEBHOOK_COST_USD', 'WEBHOOK_ERROR_RATE',
    'HEALTH_CHECK_INTERVAL_MS',
  ];

  function setEnv(k: string, v: string | undefined): void {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  beforeAll(async () => {
    // 默认 env 基线：与运行能力相关的 env 全部清空，测试进程里残留的值不算数。
    for (const k of FEATURE_ENVS) setEnv(k, undefined);
    app = Fastify();
    await app.register(dashboardRoutes);
    await app.ready();
  });

  afterAll(async () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.close();
  });

  const get = () => app.inject({ method: 'GET', url: '/api/features' });

  // ── 默认 env 下的默认状态 ────────────────────────────────────────────────────
  it('默认 env：健康检查开（默认 5 分钟）、webhook/限流/模型访问/prompt 版本关、审计开', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // 健康检查：默认开启，间隔 300000ms；测试进程未跑过探活 → channel 无样本。
    expect(body.healthCheck).toMatchObject({ enabled: true, intervalMs: 300000 });
    expect(body.healthCheck.channel).toMatchObject({
      lastResult: null,
      consecutiveFailures: 0,
      uptimePercent: 100,
    });

    // webhook：未配置 WEBHOOK_URL = 关闭，阈值均为 null。
    expect(body.webhook).toEqual({ enabled: false, costThreshold: null, errorRateThreshold: null });

    // prompt 版本：默认关闭，但 dir 始终给出（解析后的目录）。
    expect(body.promptVersions.enabled).toBe(false);
    expect(typeof body.promptVersions.dir).toBe('string');
    expect(body.promptVersions.dir.length).toBeGreaterThan(0);

    // 限流与模型访问：均未设置 = 完全关闭。
    expect(body.rateLimit).toEqual({ rpm: null, tpm: null });
    expect(body.modelAccess).toEqual({ mode: 'off', list: [] });

    // 审计日志：AUDIT_LOG 未设 = 默认开启，路径指向默认 audit.log。
    expect(body.auditLog.enabled).toBe(true);
    expect(body.auditLog.path.endsWith('audit.log')).toBe(true);
  });

  // ── 设置各 env 后的状态变化 ──────────────────────────────────────────────────
  it('限流与模型访问：设置 env 后回显数值/名单，非法值回退关闭', async () => {
    setEnv('RATE_LIMIT_RPM', '60');
    setEnv('RATE_LIMIT_TPM', '100000');
    setEnv('MODEL_ALLOWLIST', ' ModelA , modelb ,');
    let body = (await get()).json();
    expect(body.rateLimit).toEqual({ rpm: 60, tpm: 100000 });
    // 与 model-access.ts 的 parseList 一致：trim + 小写化 + 去空项；allowlist 优先。
    expect(body.modelAccess).toEqual({ mode: 'allowlist', list: ['modela', 'modelb'] });

    setEnv('MODEL_ALLOWLIST', undefined);
    setEnv('MODEL_BLOCKLIST', 'GPT-4O');
    body = (await get()).json();
    expect(body.modelAccess).toEqual({ mode: 'blocklist', list: ['gpt-4o'] });

    // 非法值：0 与非数字按 rate-limit.ts 的 intEnv 判定回退"未设置"。
    setEnv('MODEL_BLOCKLIST', undefined);
    setEnv('RATE_LIMIT_RPM', '0');
    setEnv('RATE_LIMIT_TPM', 'not-a-number');
    body = (await get()).json();
    expect(body.rateLimit).toEqual({ rpm: null, tpm: null });
  });

  it('健康检查与审计：HEALTH_CHECK_INTERVAL_MS=0 关闭探活；AUDIT_LOG=off 关闭审计；路径可覆盖', async () => {
    setEnv('HEALTH_CHECK_INTERVAL_MS', '0');
    setEnv('AUDIT_LOG', 'off');
    const auditPath = path.join(os.tmpdir(), 'features-endpoint-test', 'audit.log');
    setEnv('AUDIT_LOG_PATH', auditPath);
    setEnv('PROMPT_VERSIONS', 'on');
    setEnv('PROMPTS_DIR', os.tmpdir());

    const body = (await get()).json();
    expect(body.healthCheck.enabled).toBe(false);
    expect(body.healthCheck.intervalMs).toBe(0);
    expect(body.auditLog).toEqual({ enabled: false, path: path.resolve(auditPath) });
    // PROMPT_VERSIONS=on 且 PROMPTS_DIR 为绝对路径时，dir 原样返回（与 prompt-versions.ts 一致）。
    expect(body.promptVersions).toEqual({ enabled: true, dir: os.tmpdir() });
  });

  // ── 安全红线：WEBHOOK_URL 不回显 ────────────────────────────────────────────
  it('WEBHOOK_URL 只回 enabled，URL 与 token 绝不出现在响应体里', async () => {
    setEnv('WEBHOOK_URL', 'https://hook.internal.invalid/webhook?token=secret-token-123');
    setEnv('WEBHOOK_COST_USD', '5');
    setEnv('WEBHOOK_ERROR_RATE', '0.1');
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('hook.internal.invalid');
    expect(res.body).not.toContain('secret-token-123');
    const body = res.json();
    expect(body.webhook).toEqual({ enabled: true, costThreshold: 5, errorRateThreshold: 0.1 });
  });

  it('WEBHOOK_COST_USD / WEBHOOK_ERROR_RATE 非法值回落 null（判定与 webhook-alerts.ts 一致）', async () => {
    setEnv('WEBHOOK_COST_USD', 'abc');
    setEnv('WEBHOOK_ERROR_RATE', '');
    const body = (await get()).json();
    expect(body.webhook.costThreshold).toBeNull();
    expect(body.webhook.errorRateThreshold).toBeNull();
  });
});
