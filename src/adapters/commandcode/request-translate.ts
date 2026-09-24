// =============================================================================
// 请求侧协议翻译（原 adapter.ts 职责模块化）
// -----------------------------------------------------------------------------
// translateOpenAIRequest：OpenAI Chat Completions → CC wire
// translateAnthropicRequest：Anthropic Messages → OpenAI 中间形态 → CC wire
// 连同全部私有辅助（工具定义/选择转换、悬空工具清理、图片与工具结果处理、
// wire config 指纹）。原样搬迁，逻辑零改动；adapter.ts 的 CommandCodeAdapter
// 委托至此。
// =============================================================================
import crypto from 'node:crypto';
import {
  OpenAIChatRequest,
  OpenAIMessage,
  AnthropicRequest,
  AnthropicContentBlock,
  CCRequestBody,
  CCMessage,
  CCContentPart,
  CCTool,
  CCToolChoice,
} from '../../types/index.js';
import { resolveModelName } from '../../utils/models.js';
import { clampMaxTokens, resolveReasoningEffort } from './reasoning.js';

// Original CLI toWireToolName: 'tool_search' is aliased to 'search_tools'.
function toWireToolName(name: string): string {
  return name === 'tool_search' ? 'search_tools' : name;
}

/**
 * OpenAI/Anthropic 工具定义 → CC wire 工具定义（name/description/input_schema）。
 * 与原版 CLI 的 toWireTools 完全一致 —— 不包含 strict 字段。
 * 不再截断：DSH Desktop 等 Agent 宿主会下发 30+ 个工具（read/write/pwsh/web_search 等排在列表后段），截断会让模型调用到被丢弃的工具而被上游拒绝。上游按收到的清单校验，全部透传即可。
 */
function convertTools(tools?: OpenAIChatRequest['tools']): CCTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => {
    if (t.type === 'custom' && t.custom) {
      return {
        name: toWireToolName(t.custom.name),
        description: t.custom.description || '',
        input_schema: t.custom.parameters || { type: 'object', properties: {} },
      };
    }
    return {
      name: toWireToolName(t.function!.name),
      description: t.function!.description || '',
      input_schema: t.function!.parameters || { type: 'object', properties: {} },
    };
  });
}

function convertToolChoice(tc?: OpenAIChatRequest['tool_choice']): CCToolChoice | undefined {
  if (!tc || tc === 'auto' || tc === 'none') return undefined;
  if (tc === 'required') return { type: 'any' };
  if (typeof tc === 'object') {
    // Already-converted CC shape (from the Anthropic path) passes through.
    if ((tc as any).type === 'any' || (tc as any).type === 'tool') {
      return tc as unknown as CCToolChoice;
    }
    if (tc.type === 'function') {
      return { type: 'tool', name: tc.function.name };
    }
  }
  return undefined;
}

function convertAnthropicToolChoice(tc?: AnthropicRequest['tool_choice']): CCToolChoice | undefined {
  if (!tc || tc.type === 'auto' || tc.type === 'none') return undefined;
  if (tc.type === 'any') return { type: 'any' };
  if (tc.type === 'tool' && tc.name) return { type: 'tool', name: tc.name };
  return undefined;
}

// ── 消息清理（pruneDanglingTools）──────────────────────────────────────────

/**
 * 移除"悬空的 tool-call/tool-result 对"——即某个 tool-result 的 call id 从未
 * 出现过对应的 tool-call。上游对这种悬空的结果会直接 400。纯文本内容永不丢弃。
 */
function pruneDanglingTools(messages: CCMessage[]): CCMessage[] {
  const validIds = new Set<string>();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool-call' && part.toolCallId) {
          validIds.add(part.toolCallId);
        }
      }
    }
  }

  const pruned: CCMessage[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      pruned.push(msg);
      continue;
    }
    const filtered = msg.content.filter(
      part =>
        (part.type !== 'tool-call' && part.type !== 'tool-result') ||
        (part.toolCallId != null && validIds.has(part.toolCallId))
    );
    if (filtered.length > 0) {
      pruned.push({ role: msg.role, content: filtered });
    }
  }
  return pruned;
}

// ── OpenAI → CC 翻译 ──────────────────────────────────────────────────────

/**
 * 把 OpenAI Chat Completions 请求翻译成 CC wire 请求体。
 * 关键映射：
 *  - system/developer 角色 → 拼接为顶层 system 字段
 *  - assistant.tool_calls → CC 的 tool-call 内容块
 *  - role=tool/function → CC 的 tool-result 内容块（相邻 tool-result 合并）
 *  - image_url（data URL）→ CC 的原始 base64 图片块（去掉 data: 前缀）
 *  - reasoning_effort → 经 resolveReasoningEffort 映射
 */
export function translateOpenAIRequest(req: OpenAIChatRequest, opts?: { threadId?: string }): CCRequestBody {
  let system = '';
  const ccMessages: CCMessage[] = [];
  const toolNameById = new Map<string, string>();

  for (const m of req.messages || []) {
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function) toolNameById.set(tc.id, tc.function.name);
      }
    }
  }

  // 工具结果里带出来的图片：wire 的 image part 只有 user 消息支持，所以先攒着，
  // 循环结束后作为紧随其后的 user 消息插入。
  const pendingToolImages: CCContentPart[] = [];

  for (const m of req.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      const textContent = typeof m.content === 'string' ? m.content : contentPartsToText(m.content);
      system = system ? `${system}\n\n${textContent}` : textContent;
    } else if (m.role === 'user') {
      if (typeof m.content === 'string') {
        ccMessages.push({ role: 'user', content: m.content });
      } else if (Array.isArray(m.content)) {
        const parts: CCContentPart[] = [];
        for (const p of m.content) {
          if (p.type === 'text') {
            parts.push({ type: 'text', text: p.text || '' });
          } else if (p.type === 'image_url') {
            // Original CLI wire shape: {type:'image', image:<raw base64>,
            // mediaType} — NOT a data URL. Strip any data: prefix.
            const url = p.image_url?.url || '';
            const dataUrlMatch = /^data:([^;]+);base64,(.*)$/.exec(url);
            if (dataUrlMatch) {
              parts.push({ type: 'image', image: dataUrlMatch[2], mediaType: dataUrlMatch[1] } as any);
            } else {
              parts.push({ type: 'image', image: url, mediaType: 'image/png' } as any);
            }
          }
        }
        ccMessages.push({ role: 'user', content: parts.length > 0 ? parts : '' });
      }
    } else if (m.role === 'assistant') {
      const parts: CCContentPart[] = [];
      if (m.content) {
        parts.push({ type: 'text', text: typeof m.content === 'string' ? m.content : contentPartsToText(m.content) });
      }
      if (m.reasoning_content) {
        parts.push({ type: 'reasoning', text: m.reasoning_content });
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          let parsedInput: Record<string, unknown>;
          try {
            parsedInput =
              typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments || '{}')
                : tc.function.arguments || {};
          } catch {
            parsedInput = { raw: tc.function.arguments };
          }
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: parsedInput,
          });
        }
      }
      ccMessages.push({ role: 'assistant', content: parts.length > 0 ? parts : '' });
    } else if (m.role === 'tool' || m.role === 'function') {
      const toolName = toolNameById.get(m.tool_call_id || '') || m.name || 'tool';
      const { text: outputVal, images } = flattenToolResult(m.content);
      const toolResultPart: CCContentPart = {
        type: 'tool-result',
        toolCallId: m.tool_call_id || '',
        toolName,
        output: { type: 'text', value: outputVal },
      };
      const lastMsg = ccMessages[ccMessages.length - 1];
      if (lastMsg && lastMsg.role === 'tool' && Array.isArray(lastMsg.content)) {
        (lastMsg.content as CCContentPart[]).push(toolResultPart);
      } else {
        ccMessages.push({ role: 'tool', content: [toolResultPart] });
      }
      pendingToolImages.push(...images);
    }
  }

  // 工具结果里的图片提升为一条 user 消息（旧实现把它们折成 `[image]` 字面量丢掉）。
  // 放在工具消息之后而不是之内，是因为上游 wire 只在 user 消息上接受 image part。
  if (pendingToolImages.length > 0) {
    ccMessages.push({ role: 'user', content: pendingToolImages });
  }

  const finalMessages = pruneDanglingTools(ccMessages);
  const targetModel = resolveModelName(req.model || '');
  const convertedTools = convertTools(req.tools);
  const reasoningEffort = resolveReasoningEffort(targetModel, req.reasoning_effort, req.thinking);

  return {
    config: buildWireConfig(),
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'auto-accept',
    threadId: opts?.threadId || crypto.randomUUID(),
    params: {
      model: targetModel,
      messages: finalMessages,
      system: system || undefined,
      ...(convertedTools && convertedTools.length > 0 ? { tools: convertedTools } : {}),
      ...(req.tool_choice ? { tool_choice: convertToolChoice(req.tool_choice) } : {}),
      stream: true,
      max_tokens: clampMaxTokens(req.max_completion_tokens ?? req.max_tokens ?? 64000),
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.top_p != null ? { top_p: req.top_p } : {}),
      // 上游对未知 params 字段是「静默忽略、而非拒绝」—— 已对真实上游实测：带这些
      // 字段与不带的响应逐字节相同，没有任何 400 / unrecognized_keys。因此转发是
      // 安全的。但在套餐内模型上是否真的生效**尚未验证**，不要当成已支持的特性宣传。
      ...(req.stop ? { stop: Array.isArray(req.stop) ? req.stop : [req.stop] } : {}),
      ...(req.response_format ? { response_format: req.response_format } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    },
  };
}

// ── Anthropic → CC 翻译（全保真，修复 v3 丢失 tool_results 的问题）───────────

/**
 * 把 Anthropic Messages 请求 → CC wire。相比 v3 修复的关键点：
 *  - user 的 tool_result 块 → tool 消息（带匹配的 toolCallId），不再被丢弃
 *  - base64/url 图片块 → CC 图片块
 *  - thinking/redacted_thinking 历史 → reasoning 块
 *  - system 块数组 → 拼接文本（不是 JSON.stringify）
 *  - tool_result 的 is_error → 加 "[ERROR] " 前缀，让模型看到失败
 * 实现上先转为 OpenAI 中间形态，再走 translateOpenAIRequest。
 */
export function translateAnthropicRequest(req: AnthropicRequest, opts?: { threadId?: string }): CCRequestBody {
  const openAIMessages: OpenAIMessage[] = [];

  if (req.system) {
    const systemText =
      typeof req.system === 'string'
        ? req.system
        : req.system.map(b => b.text).join('\n\n');
    if (systemText) {
      openAIMessages.push({ role: 'system', content: systemText });
    }
  }

  for (const m of req.messages || []) {
    const blocks: AnthropicContentBlock[] =
      typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];

    // Split user blocks into text/image segments and tool_results.
    if (m.role === 'user') {
      const regularParts: OpenAIMessage['content'] = [];
      const toolResults: OpenAIMessage[] = [];

      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const { text: resultText, images } = anthropicResultToParts(block);
          const body = block.is_error ? `[ERROR] ${resultText}` : resultText;
          // 图片作为 image_url part 挂在同一条 tool 消息上，由 translateOpenAIRequest
          // 统一提升成随后的 user 消息 —— 两条入口只保留一份图片处理逻辑。
          const parts: any[] = [
            { type: 'text', text: body },
            ...images.map(url => ({ type: 'image_url', image_url: { url } })),
          ];
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: images.length ? parts : body,
          });
        } else if (block.type === 'text') {
          (regularParts as any[]).push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          (regularParts as any[]).push({ type: 'image_url', image_url: { url: anthropicImageToDataUrl(block) } });
        }
        // Wire conversion to the raw shape happens in translateOpenAIRequest.
      }

      for (const tr of toolResults) {
        openAIMessages.push(tr);
      }
      if (regularParts.length > 0) {
        openAIMessages.push({ role: 'user', content: regularParts });
      }
    } else {
      // Assistant turn: text + thinking + tool_use blocks → ONE assistant
      // message with optional reasoning_content and tool_calls.
      let textContent = '';
      let reasoning = '';
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += (textContent ? '\n' : '') + block.text;
        } else if (block.type === 'thinking') {
          reasoning += (reasoning ? '\n' : '') + block.thinking;
        }
        // redacted_thinking: no plaintext to preserve — skip.
      }

      const toolUses = blocks.filter(
        (b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
      );

      if (textContent || reasoning || toolUses.length > 0) {
        const msg: OpenAIMessage = { role: 'assistant', content: textContent || null };
        if (reasoning) (msg as any).reasoning_content = reasoning;
        if (toolUses.length > 0) {
          msg.tool_calls = toolUses.map(b => ({
            id: b.id,
            type: 'function' as const,
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          }));
        }
        openAIMessages.push(msg);
      }
    }
  }

  const openAIReq: OpenAIChatRequest = {
    model: req.model,
    messages: openAIMessages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    // Anthropic 的 stop_sequences 归一到 OpenAI 的 stop，下游只有一份转发逻辑。
    ...(req.stop_sequences?.length ? { stop: req.stop_sequences } : {}),
    stream: req.stream,
    tools: req.tools?.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    tool_choice: undefined,
    thinking: req.thinking?.type === 'enabled' ? req.thinking : undefined,
    reasoning_effort: undefined,
  };

  if (req.tool_choice) {
    const mapped = convertAnthropicToolChoice(req.tool_choice);
    if (mapped) openAIReq.tool_choice = mapped as any;
  }

  const wire = translateOpenAIRequest(openAIReq, opts);
  return wire;
}

/**
 * tool_result 的内容拆成「文本 + 图片」两部分。
 *
 * 旧实现把图片压成 base64 的前 64 字符混进文本（`[image: data:image/png;base64,iVBOR…]`），
 * 于是截图/浏览器类 agent 的观察通道在代理里被静默销毁：模型什么也没看到，
 * 客户端也收不到任何提示。改成随结果一起带下去，由 translateOpenAIRequest 提升到
 * 紧随其后的 user 消息里（wire 在 user 消息上支持 image part，这一点已对上游实测）。
 */
function anthropicResultToParts(
  block: Extract<AnthropicContentBlock, { type: 'tool_result' }>
): { text: string; images: string[] } {
  if (typeof block.content === 'string') return { text: block.content, images: [] };
  if (!Array.isArray(block.content)) return { text: '', images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of block.content) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image') images.push(anthropicImageToDataUrl(part));
  }
  return { text: texts.join('\n'), images };
}

function anthropicImageToDataUrl(block: Extract<AnthropicContentBlock, { type: 'image' }>): string {
  if (block.source.type === 'url') return block.source.url;
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

/** Anthropic base64 image → raw wire shape (original CLI format). */
function anthropicImageToWire(block: Extract<AnthropicContentBlock, { type: 'image' }>): CCContentPart {
  if (block.source.type === 'url') {
    return { type: 'image', image: block.source.url, mediaType: 'image/png' } as any;
  }
  return { type: 'image', image: block.source.data, mediaType: block.source.media_type } as any;
}

function contentPartsToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p.type === 'text' ? p.text : p.type === 'image_url' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

/**
 * 工具结果内容 → { 文本, 图片 wire part }。
 *
 * contentPartsToText 把图片折成字面量 `[image]`，用在 system/assistant 上是合理的
 * （那里本就不该出现图），但工具结果正是 agent 看截图的唯一通道，必须把图片留住。
 */
function flattenToolResult(content: unknown): { text: string; images: CCContentPart[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts: string[] = [];
  const images: CCContentPart[] = [];
  for (const p of content as any[]) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text') {
      if (p.text) texts.push(p.text);
      continue;
    }
    if (p.type !== 'image_url' && p.type !== 'image') continue;
    const url: string = p.image_url?.url ?? (typeof p.image === 'string' ? p.image : '');
    if (!url) continue;
    // 与 user 消息同一套 wire 形状：裸 base64 + mediaType，不是 data URL。
    const dataUrl = /^data:([^;]+);base64,(.*)$/.exec(url);
    images.push(dataUrl
      ? { type: 'image', image: dataUrl[2], mediaType: dataUrl[1] }
      : { type: 'image', image: url, mediaType: 'image/png' });
  }
  // 文本里明说图片另行附上，而不是静默替换成一个占位符。
  const note = images.length
    ? `\n[本次工具结果包含 ${images.length} 张图片，已作为紧随其后的用户消息单独附上]`
    : '';
  return { text: texts.join('\n') + note, images };
}

// ── wire config（CLI 指纹，伪装成本地 git 仓库以匹配 CLI 行为）────────────────

function buildWireConfig() {
  return {
    date: new Date().toISOString().split('T')[0],
    environment: process.platform,
    workingDir: process.cwd(),
    availableTools: [],
    structure: [],
    isGitRepo: true,
    currentBranch: 'master',
    mainBranch: 'master',
    gitStatus: 'Working tree clean',
    recentCommits: [],
    os: process.platform === 'win32' ? 'windows' : process.platform,
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
  };
}
