// =============================================================================
// 回归防线：输入 token 估算口径。
// -----------------------------------------------------------------------------
// 1. /v1/messages/count_tokens 此前只认 `typeof tool_result.content === 'string'`，
//    而数组形态的 content 才是 agent 上下文的主体（文件内容、命令输出、截图）。
//    漏掉它 → count_tokens 大幅低报 → 客户端以为无需压缩上下文 → 上游以
//    context length 超限报错。既有的集成用例只喂了纯字符串消息，没覆盖到这条。
// 2. 两条路由的 inputTokens 用 estimateTextTokens(JSON.stringify(translated)) ——
//    把整个上行请求体按字符估，于是 config 元数据和**图片 base64 正文**全被算进
//    提示词：粘贴一张截图能量出几十万个假 input_tokens，并流进 message_start 与
//    usage 缺失时的成本估算。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let app: FastifyInstance;

beforeAll(async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-tokenest-'));
  // src 模块的 CONFIG_FILE_PATH 等是模块级常量，env 必须在首次求值前就位。
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.COMMANDCODE_PRICING_CACHE_PATH = path.join(stateDir, 'pricing.json');
  process.env.COMMANDCODE_ENV_FILE_PATH = path.join(stateDir, '.env');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  process.env.COMMANDCODE_API_KEY = 'ck-estimate-fixture-credential';

  const { messagesRoutes } = await import('../src/routes/messages.js');
  app = Fastify();
  await app.register(messagesRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

async function countTokens(messages: unknown[], extra: Record<string, unknown> = {}): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/messages/count_tokens',
    payload: { model: 'claude-sonnet-5', max_tokens: 64, messages, ...extra },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { input_tokens: number }).input_tokens;
}

describe('count_tokens 计入 agent 上下文的主体', () => {
  it('数组形态的 tool_result 内容被计入', async () => {
    const toolOutput = 'x'.repeat(1200); // ≈300 token
    const asArray = await countTokens([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: toolOutput }] }] },
    ]);
    expect(asArray, '数组 content 的工具输出被整个漏掉了').toBeGreaterThanOrEqual(250);

    // 同一个内容换成字符串形态，量级必须一致 —— 低报只发生在数组分支上。
    const asString = await countTokens([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: toolOutput }] },
    ]);
    expect(Math.abs(asArray - asString) <= 8).toBe(true);
  });

  it('图片按块计入固定额度，而不是 0', async () => {
    const { IMAGE_TOKEN_ALLOWANCE } = await import('../src/adapters/commandcode/upstream.js');
    const n = await countTokens([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100_000) } }] },
    ]);
    expect(n).toBeGreaterThanOrEqual(IMAGE_TOKEN_ALLOWANCE);
  });

  it('工具 schema 计入（Anthropic 口径包含它）', async () => {
    const withTools = await countTokens([{ role: 'user', content: 'hi' }], {
      tools: [{ name: 'read_file', description: 'd'.repeat(400), input_schema: { type: 'object' } }],
    });
    const withoutTools = await countTokens([{ role: 'user', content: 'hi' }]);
    expect(withTools - withoutTools).toBeGreaterThanOrEqual(90);
  });
});

describe('上行请求体的 input_tokens 估算只数进上下文的部分', () => {
  it('不把 config 元数据与图片 base64 当提示词', async () => {
    const up = await import('../src/adapters/commandcode/upstream.js');
    expect(typeof up.estimateWireInputTokens, '缺少 estimateWireInputTokens').toBe('function');

    const wire = {
      // config 是网关元数据，根本不进模型上下文。
      config: { date: 'z'.repeat(4000), locale: 'zh-CN', requestId: 'r'.repeat(4000) },
      memory: 'm'.repeat(4000),
      threadId: 't'.repeat(2000),
      params: {
        system: 'You are a coding agent.',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'short question' },
            // 20 万字符的 base64：按字符/4 会凭空造出 5 万 input_tokens。
            { type: 'image', image: 'A'.repeat(200_000), mediaType: 'image/png' },
          ],
        }],
      },
    };
    const est = up.estimateWireInputTokens(wire);
    expect(est).toBeGreaterThanOrEqual(up.IMAGE_TOKEN_ALLOWANCE); // 图片仍要计额度
    expect(est, 'base64 或 config 被当成提示词了').toBeLessThan(2000);
  });

  it('system / 消息文本 / 工具 schema 仍然计入', async () => {
    const up = await import('../src/adapters/commandcode/upstream.js');
    const empty = up.estimateWireInputTokens({ params: {} });
    const full = up.estimateWireInputTokens({
      params: {
        system: 'S'.repeat(800),
        messages: [{ role: 'user', content: 'T'.repeat(800) }],
        tools: [{ name: 'x', description: 'D'.repeat(800) }],
      },
    });
    expect(empty).toBe(0);
    // 三段各 200 token 左右，合计应在 500 以上、900 以内。
    expect(full).toBeGreaterThanOrEqual(500);
    expect(full).toBeLessThan(900);
  });
});
