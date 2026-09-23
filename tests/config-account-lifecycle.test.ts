// =============================================================================
// 回归防线：账号生命周期与配置落盘的真值。
// -----------------------------------------------------------------------------
// 1. saveConfigFile 此前返回 void 且吞掉一切异常，所有仪表盘写端点于是无条件报
//    success：exe 装在 Program Files、只读盘、杀软锁文件时用户看到"账号已添加"，
//    重启后账号消失且请求仍在用旧 Key。
// 2. 删账号只删了 config.json 里的条目：`.env` 因为在无活跃 Key 时被条件跳过而
//    原样留着上一条凭据，下次启动被重新导入并合成 acc_default —— "已删除的账号"
//    继续烧那个账号的额度。进程内也一样：getActiveApiKey() 会回落到 env。
// 3. syncEnvFile 把 COMMANDCODE_API_BASE 写死成公网默认值，而 env 的优先级高于
//    config.json —— 自建上游/镜像端点在一次账号操作后会在下次重启被静默改回默认。
// =============================================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ACCOUNT_KEY = 'ck-lifecycle-fixture-key-8899';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'ccproxy-lc-'));

/**
 * config.ts 的 CONFIG_FILE_PATH / ENV_FILE_PATH 是模块级常量，只能在 import 前
 * 通过 env 影响，所以每个用例都要 resetModules 换一个干净实例。
 */
async function freshConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import('../src/utils/config.js');
  return mod;
}

const cleanupEnv = () => {
  for (const k of ['COMMANDCODE_CONFIG_PATH', 'COMMANDCODE_ENV_FILE_PATH', 'COMMANDCODE_API_KEY',
    'COMMANDCODE_API_BASE', 'COMMANDCODE_MODELS_CACHE_PATH', 'COMMANDCODE_PRICING_CACHE_PATH',
    'USAGE_HISTORY_PATH']) {
    delete process.env[k];
  }
};
afterEach(cleanupEnv);

describe('saveConfigFile 落盘结果可信度', () => {
  it('目标不可写时返回 false，而不是静默"成功"', async () => {
    const dir = scratch();
    // 指向一个不存在的子目录：writeFileSync 必然 ENOENT。
    const mod = await freshConfig({
      COMMANDCODE_CONFIG_PATH: path.join(dir, 'no-such-dir', 'config.json'),
      COMMANDCODE_ENV_FILE_PATH: path.join(dir, '.env'),
    });
    expect(mod.saveConfigFile({ port: 9091 })).toBe(false);
  });

  it('写入成功时返回 true 且内容真的落盘', async () => {
    const dir = scratch();
    const cfgPath = path.join(dir, 'config.json');
    const mod = await freshConfig({
      COMMANDCODE_CONFIG_PATH: cfgPath,
      COMMANDCODE_ENV_FILE_PATH: path.join(dir, '.env'),
    });
    expect(mod.saveConfigFile({ port: 9092 })).toBe(true);
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).port).toBe(9092);
  });
});

describe('删除最后一个账号不得留下可用凭据', () => {
  it('.env 里的 COMMANDCODE_API_KEY 随账号一起消失，进程内兜底也被收掉', async () => {
    const dir = scratch();
    const cfgPath = path.join(dir, 'config.json');
    const envPath = path.join(dir, '.env');
    process.env.COMMANDCODE_API_KEY = ACCOUNT_KEY;
    const mod = await freshConfig({
      COMMANDCODE_CONFIG_PATH: cfgPath,
      COMMANDCODE_ENV_FILE_PATH: envPath,
    });

    expect(mod.saveConfigFile({
      accounts: [{ id: 'acc_a', name: 'A', apiKey: ACCOUNT_KEY, addedAt: new Date().toISOString() }],
      activeAccountId: 'acc_a',
    })).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toContain(ACCOUNT_KEY);

    expect(mod.logoutAccount('acc_a')).toBe(true);

    // 旧实现：删完最后一个账号时 saveConfigFile 条件性跳过 syncEnvFile，
    // .env 里的凭据原封不动 → 下次启动 loadEnvFileOnce 把它再导回来。
    const envAfter = readFileSync(envPath, 'utf-8');
    expect(envAfter).not.toContain(ACCOUNT_KEY);
    expect(process.env.COMMANDCODE_API_KEY).toBeUndefined();
    // 本次运行内也不能继续用那条 Key 发请求。
    expect(mod.getActiveApiKey()).not.toBe(ACCOUNT_KEY);
  });
});

describe('.env 不把上游端点固化成公网默认', () => {
  it('config.json 未指定 apiBase 时，不写 COMMANDCODE_API_BASE 行', async () => {
    const dir = scratch();
    const envPath = path.join(dir, '.env');
    const mod = await freshConfig({
      COMMANDCODE_CONFIG_PATH: path.join(dir, 'config.json'),
      COMMANDCODE_ENV_FILE_PATH: envPath,
      COMMANDCODE_API_KEY: ACCOUNT_KEY,
    });
    mod.saveConfigFile({
      accounts: [{ id: 'acc_b', name: 'B', apiKey: ACCOUNT_KEY, addedAt: new Date().toISOString() }],
      activeAccountId: 'acc_b',
    });
    // 旧实现无条件写 COMMANDCODE_API_BASE=<公网默认>，而 env 优先级高于 config.json，
    // 于是自建上游端点在一次账号操作后于下次重启被静默改回公网默认。
    const env = readFileSync(envPath, 'utf-8');
    expect(env).not.toMatch(/^COMMANDCODE_API_BASE=/m);
    expect(env).not.toMatch(/^COMMANDCODE_VERSION=/m);
    expect(env).toContain(ACCOUNT_KEY);
  });

  it('config.json 显式指定了自建端点时，.env 如实镜像该值', async () => {
    const dir = scratch();
    const cfgPath = path.join(dir, 'config.json');
    const envPath = path.join(dir, '.env');
    const mod = await freshConfig({
      COMMANDCODE_CONFIG_PATH: cfgPath,
      COMMANDCODE_ENV_FILE_PATH: envPath,
      COMMANDCODE_API_KEY: ACCOUNT_KEY,
    });
    mod.saveConfigFile({
      accounts: [{ id: 'acc_c', name: 'C', apiKey: ACCOUNT_KEY, addedAt: new Date().toISOString() }],
      activeAccountId: 'acc_c',
      upstream: { apiBase: 'http://127.0.0.1:59999' },
    });
    expect(readFileSync(envPath, 'utf-8')).toContain('COMMANDCODE_API_BASE=http://127.0.0.1:59999');
    // 默认部署（未指定）行为不变的直接证据：上一用例里根本没有这一行。
    expect(existsSync(cfgPath)).toBe(true);
  });
});
