// =============================================================================
// 回归防线：OAuth 登录端点不得把明文上游 apiKey 回传前端。
// -----------------------------------------------------------------------------
// 批次 A 修掉了 /api/auth/manual-login（注释写着"明文 apiKey 绝不出接口"），
// 但兄弟端点 /api/auth/browser-login 直接 `return { account: newAcc }`，而
// startBrowserLoginFlow 透传的是 loginNewAccount 的 AccountInfo —— 带完整凭据。
// 同一个收口规则在两个端点上只落实了一个，正是复制粘贴掩码表达式的代价。
//
// 只 mock 上游 OAuth 流程本身（要真起 5959 回调端口），路由与掩码逻辑全走真实代码。
// =============================================================================
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({ key: 'ck-oauth-fixture-key-4455-do-not-leak' }));

vi.mock('../src/utils/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/config.js')>();
  return {
    ...actual,
    startBrowserLoginFlow: async () => ({
      id: 'acc_oauth',
      name: 'Command Code (OAuth Tester)',
      apiKey: hoisted.key,
      userName: 'oauthtester',
      email: 'oauth@example.com',
      addedAt: new Date().toISOString(),
    }),
  };
});

let app: FastifyInstance;

beforeAll(async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-oauthmask-'));
  // 路径必须在 src 模块首次求值前就位（CONFIG_FILE_PATH 等是模块级常量）。
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.COMMANDCODE_PRICING_CACHE_PATH = path.join(stateDir, 'pricing.json');
  process.env.COMMANDCODE_ENV_FILE_PATH = path.join(stateDir, '.env');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  delete process.env.COMMANDCODE_API_KEY;

  const { dashboardRoutes } = await import('../src/routes/dashboard.js');
  app = Fastify();
  await app.register(dashboardRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('POST /api/auth/browser-login 凭据外泄', () => {
  it('响应体任何位置都不出现明文 apiKey', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/browser-login' });
    expect(res.statusCode).toBe(200);
    expect(res.body, 'OAuth 端点把 bearer token 原样发给了浏览器').not.toContain(hoisted.key);
  });

  it('账号以掩码回传，且 SPA 要读的字段还在', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/browser-login' });
    const account = res.json().account;

    expect(account.apiKey).toBeUndefined();
    expect(account.apiKeyMasked).toBe(`${hoisted.key.slice(0, 8)}...${hoisted.key.slice(-4)}`);
    // index.html 的 startBrowserLogin() 依赖这些字段刷新账号列表。
    expect(account.id).toBe('acc_oauth');
    expect(account.name).toBe('Command Code (OAuth Tester)');
  });
});
