// =============================================================================
// 回归防线：工具结果里的图片，以及 stop / response_format 的转发。
// -----------------------------------------------------------------------------
// 1. tool_result 里的图片此前被适配器折成字面量丢掉。对真实上游直接打印生成出的
//    wire 体即可复现：
//      {"type":"tool-result", ... "output":{"type":"text","value":"a screenshot\n[image]"}}
//    图片字节从未离开代理 —— 截图 / 浏览器类 agent 的观察通道被静默销毁，
//    而客户端收不到任何提示。现改为提升成紧随其后的一条 user 消息（上游 wire 在
//    user 消息上接受 image part，这一点已实测），并在文本里明说图片另行附上。
// 2. stop / stop_sequences / response_format 此前声明在类型里却从不下发，客户端
//    要求"遇到 ``` 就停"会拿到标记之后的内容并照样计费。上游对未知 params 字段
//    是静默忽略而非拒绝（实测带与不带的响应逐字节相同、无 400），故转发安全；
//    是否真生效尚未在套餐内模型上验证 —— 这里锁的是"已下发"，不是"已生效"。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { CommandCodeAdapter } from '../src/adapters/commandcode/adapter.js';

const adapter = new CommandCodeAdapter();
const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9';
const DATA_URL = `data:image/png;base64,${B64}`;

const openAIToolMsg = (toolContent: unknown) => adapter.translateOpenAIRequest({
  model: 'claude-sonnet-5', stream: true, max_tokens: 32,
  messages: [
    { role: 'user', content: 'look at the screenshot' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: toolContent },
  ],
} as any);

describe('tool_result 里的图片不再被销毁', () => {
  it('OpenAI 入口：image_url 变成随后的 user 消息 image part', () => {
    const wire = openAIToolMsg([
      { type: 'text', text: 'a screenshot' },
      { type: 'image_url', image_url: { url: DATA_URL } },
    ]);
    const msgs = wire.params.messages as any[];
    const flat = JSON.stringify(msgs);

    expect(flat, '图片又被折成了字面量占位符').not.toContain('[image]');
    const tail = msgs[msgs.length - 1];
    expect(tail.role).toBe('user');
    expect(tail.content[0]).toMatchObject({ type: 'image', image: B64, mediaType: 'image/png' });

    const toolResult = msgs.find(m => m.role === 'tool')?.content?.[0];
    expect(toolResult.type).toBe('tool-result');
    expect(toolResult.output.value).toContain('a screenshot');
    expect(toolResult.output.value, '文本里应说明图片另行附上').toContain('1 张图片');
  });

  it('Anthropic 入口：tool_result 数组 content 里的图片走同一机制', () => {
    const wire = adapter.translateAnthropicRequest({
      model: 'claude-sonnet-5', max_tokens: 32, stream: true,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
          { type: 'text', text: 'see image' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: B64 } },
        ] }] },
      ],
    } as any);
    const msgs = wire.params.messages as any[];
    expect(JSON.stringify(msgs)).not.toContain('[image:');
    expect(JSON.stringify(msgs)).not.toContain('[image]');
    const tail = msgs[msgs.length - 1];
    expect(tail.role).toBe('user');
    expect(tail.content[0]).toMatchObject({ type: 'image', image: B64, mediaType: 'image/jpeg' });
  });

  it('无图片的工具结果行为一字不变（不加多余消息、不加提示语）', () => {
    const wire = openAIToolMsg('plain output');
    const msgs = wire.params.messages as any[];
    expect(msgs[msgs.length - 1].role).toBe('tool');
    expect(msgs[msgs.length - 1].content[0].output.value).toBe('plain output');
    expect(JSON.stringify(msgs)).not.toContain('张图片');
  });
});

describe('stop / response_format 下发', () => {
  it('OpenAI 的 stop 字符串归一成数组', () => {
    const wire = adapter.translateOpenAIRequest({
      model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }], stop: 'END',
    } as any);
    expect((wire.params as any).stop).toEqual(['END']);
  });

  it('Anthropic 的 stop_sequences 归一到同一个字段', () => {
    const wire = adapter.translateAnthropicRequest({
      model: 'm', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }], stop_sequences: ['```', '\n\n'],
    } as any);
    expect((wire.params as any).stop).toEqual(['```', '\n\n']);
  });

  it('response_format 原样转发', () => {
    const wire = adapter.translateOpenAIRequest({
      model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' },
    } as any);
    expect((wire.params as any).response_format).toEqual({ type: 'json_object' });
  });

  it('客户端没提这些选项时，上行体里不出现空字段', () => {
    const wire = adapter.translateOpenAIRequest({
      model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }],
    } as any);
    expect('stop' in (wire.params as any)).toBe(false);
    expect('response_format' in (wire.params as any)).toBe(false);
  });

  it('已有的采样参数不受影响', () => {
    const wire = adapter.translateOpenAIRequest({
      model: 'm', stream: true, temperature: 0.3, top_p: 0.9, stop: ['X'],
      messages: [{ role: 'user', content: 'hi' }],
    } as any);
    expect((wire.params as any).temperature).toBe(0.3);
    expect((wire.params as any).top_p).toBe(0.9);
    expect((wire.params as any).stop).toEqual(['X']);
  });
});
