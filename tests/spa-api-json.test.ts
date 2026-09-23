// =============================================================================
// 回归防线：仪表盘的接口调用必须统一经过 apiJson，且失败要变成"看得见的失败"。
// -----------------------------------------------------------------------------
// 后端这轮把 /api/accounts/active|delete|rotation 等写端点从"无条件 {status:'success'}"
// 改成了配置写失败时返回 HTTP 500。但前端 18 处 fetch 里只有 2 处检查 res.ok，于是
// `data.accounts.map(...)` 拿到 {error:...} 直接 TypeError：整片列表停在旧数据上，
// "删除账号失败"在界面上的表现就是"点了没反应"。fetchStatus 更糟 —— 整个函数包在
// try{}catch{} 里，代理挂掉后头部状态胶囊可以连续几小时谎报"引擎运行中"。
//
// 这里既测 apiJson 的行为，也用一条结构断言锁死"不许再出现绕过封装的裸 fetch"。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf-8');

/**
 * 按大括号配平取出一个顶层函数源码（与 spa-badge-escape 同一手法）。
 * 注意把前导的 `async ` 一起带上：apiJson 是 async function，截掉 async 会让
 * 函数体里的 await 变成非法语法。
 */
function extractFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`function ${name} not found in public/index.html`);
  const start = src.slice(0, at).endsWith('async ') ? at - 'async '.length : at;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

type FetchStub = (url: string, opts?: unknown) => Promise<unknown>;
function load(fetchStub: FetchStub) {
  return new Function('fetch', `${extractFn(html, 'apiJson')}; return apiJson;`)(fetchStub) as
    (url: string, opts?: unknown) => Promise<{ ok: boolean; data: any; error: string | null }>;
}

const reply = (status: number, body: string) => ({
  ok: status >= 200 && status < 300, status, text: async () => body,
});

describe('结构约束', () => {
  it('全文件只允许封装内部出现一次裸 fetch', () => {
    const sites = [...html.matchAll(/\bfetch\(/g)].length;
    expect(sites, '新增网络调用请走 apiJson，否则失败会再次变成静默无反应').toBe(1);
  });

  it('没有任何调用点还在用 await (...).json() 的旧写法', () => {
    expect(html).not.toMatch(/await\s*\(?\s*await\s+fetch/);
  });
});

describe('apiJson 的失败面', () => {
  it('2xx + JSON 正常返回数据', async () => {
    const api = load(async () => reply(200, '{"accounts":[{"id":"a1"}]}'));
    const r = await api('/api/accounts');
    expect(r.ok).toBe(true);
    expect(r.data.accounts).toHaveLength(1);
  });

  it('HTTP 500 带 error 字符串 → ok:false 且把服务端原因原样带出', async () => {
    const api = load(async () => reply(500, '{"error":"删除失败：config.json 写入未成功"}'));
    const r = await api('/api/accounts/delete', { method: 'POST' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('config.json 写入未成功');
  });

  it('Fastify 默认的 500 文案也不会变成空白提示', async () => {
    const api = load(async () => reply(500, '{"statusCode":500,"error":"Internal Server Error"}'));
    expect((await api('/api/x')).error).toContain('Internal Server Error');
  });

  it('Anthropic 风格的嵌套 error 取到 message', async () => {
    const api = load(async () => reply(401, '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}'));
    expect((await api('/api/status')).error).toBe('bad key');
  });

  it('非 JSON 响应体不抛异常（HTML 错误页场景）', async () => {
    const api = load(async () => reply(502, '<html>502 Bad Gateway</html>'));
    const r = await api('/api/status');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('502');
  });

  it('2xx 但响应体为空 → 判为失败而不是把 null 往下传', async () => {
    const api = load(async () => reply(200, ''));
    expect((await api('/api/status')).ok).toBe(false);
  });

  it('fetch 本身抛错（代理进程已退出）→ ok:false 并说明连不上', async () => {
    const api = load(async () => { throw new Error('fetch failed'); });
    const r = await api('/api/status');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无法连接代理');
  });

  it('永不抛异常：调用点不需要再包 try/catch', async () => {
    const cases = [
      async () => reply(200, 'not json'),
      async () => reply(404, ''),
      async () => { throw new Error('boom'); },
    ];
    for (const stub of cases) {
      await expect(load(stub)('/api/whatever')).resolves.toMatchObject({ ok: expect.any(Boolean) });
    }
  });
});
