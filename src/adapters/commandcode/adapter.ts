import crypto from 'node:crypto';
import {
  OpenAIChatRequest,
  OpenAIMessage,
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  CCRequestBody,
  CCMessage,
  CCContentPart,
  CCTool,
  CCToolChoice,
  CCEvent,
  StreamEncoderState,
} from '../../types/index.js';
import { resolveModelName } from '../../utils/models.js';
import { logger } from '../../utils/logger.js';

// ─── Reasoning effort mapping (per CLI wire contract) ─────────────────────────

const Qn = ['low', 'medium', 'high', 'xhigh', 'max'];
const Xn = ['low', 'medium', 'high', 'xhigh'];
const Zn = ['low', 'medium', 'high'];
const er = ['high', 'max'];

// Original CLI (fr map): GLM-5.3 supports low/high/max — not the er set.
const OFFICIAL_REASONING_MAP: Record<string, string[]> = {
  'claude-sonnet-5': Qn,
  'claude-sonnet-4-6': Qn,
  'claude-fable-5': Qn,
  'claude-opus-5': Qn,
  'claude-opus-4-8': Qn,
  'claude-opus-4-7': Qn,
  'gpt-5.6-sol': Qn,
  'gpt-5.6-terra': Qn,
  'gpt-5.6-luna': Qn,
  'gpt-5.5': Xn,
  'gpt-5.4': Xn,
  'gpt-5.3-codex': Xn,
  'gpt-5.4-mini': Zn,
  'deepseek/deepseek-v4-pro': er,
  'deepseek/deepseek-v4-flash': er,
  'zai-org/GLM-5.3': ['low', 'high', 'max'],
  'zai-org/GLM-5.2': er,
  'zai-org/GLM-5': er,
  'google/gemini-3.7-flash': Zn,
  'google/gemini-3.6-flash': Zn,
  'google/gemini-3.5-flash': Zn,
  'google/gemini-3.5-flash-lite': Zn,
  'google/gemini-3.1-flash-lite': Zn,
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'xai/grok-4.6': Xn,
  'xai/grok-4.5': Zn,
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
};

const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 5,
};

export class CommandCodeAdapter {
  // Original CLI toWireToolName: 'tool_search' is aliased to 'search_tools'.
  private static toWireToolName(name: string): string {
    return name === 'tool_search' ? 'search_tools' : name;
  }

  /**
   * OpenAI/Anthropic tool defs → CC wire tools (name, description, input_schema).
   * Matches original CLI toWireTools exactly — no `strict` field. Capped at 15.
   */
  private static convertTools(tools?: OpenAIChatRequest['tools']): CCTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.slice(0, 15).map(t => {
      if (t.type === 'custom' && t.custom) {
        return {
          name: CommandCodeAdapter.toWireToolName(t.custom.name),
          description: t.custom.description || '',
          input_schema: t.custom.parameters || { type: 'object', properties: {} },
        };
      }
      return {
        name: CommandCodeAdapter.toWireToolName(t.function!.name),
        description: t.function!.description || '',
        input_schema: t.function!.parameters || { type: 'object', properties: {} },
      };
    });
  }

  private static convertToolChoice(tc?: OpenAIChatRequest['tool_choice']): CCToolChoice | undefined {
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

  private static convertAnthropicToolChoice(tc?: AnthropicRequest['tool_choice']): CCToolChoice | undefined {
    if (!tc || tc.type === 'auto' || tc.type === 'none') return undefined;
    if (tc.type === 'any') return { type: 'any' };
    if (tc.type === 'tool' && tc.name) return { type: 'tool', name: tc.name };
    return undefined;
  }

  // ── Reasoning effort resolution ────────────────────────────────────────────

  resolveReasoningEffort(model: string, requested?: any, thinkingConfig?: any): string | undefined {
    if (thinkingConfig && thinkingConfig.type === 'enabled') {
      const budget = thinkingConfig.budget_tokens ?? 2048;
      if (budget >= 16000) return 'max';
      if (budget >= 8000) return 'high';
      if (budget >= 4000) return 'medium';
      return 'low';
    }

    let supported = OFFICIAL_REASONING_MAP[model];
    if (!supported) {
      const modelLower = model.toLowerCase();
      if (
        modelLower.includes('deepseek') ||
        modelLower.includes('glm-') ||
        modelLower.includes('grok') ||
        modelLower.includes('reasoner') ||
        modelLower.includes('thinking') ||
        modelLower.includes('o1') ||
        modelLower.includes('o3') ||
        modelLower.includes('qwq') ||
        modelLower.includes('laguna') ||
        modelLower.includes('inkling') ||
        modelLower.includes('step') ||
        modelLower.includes('kimi') ||
        modelLower.includes('qwen') ||
        modelLower.includes('claude-sonnet') ||
        modelLower.includes('claude-opus') ||
        modelLower.includes('gpt-5')
      ) {
        supported = ['low', 'medium', 'high', 'xhigh', 'max'];
      }
    }

    if (!supported) return undefined;

    // Original CLI: no requested effort → no reasoning_effort field at all
    // (supportsThinking gates it; there is no default-medium).
    if (requested == null) return undefined;

    let effortStr = String(requested).toLowerCase();
    if (typeof requested === 'number') {
      if (requested >= 6) effortStr = 'ultra';
      else if (requested === 5) effortStr = 'max';
      else if (requested === 4) effortStr = 'high';
      else if (requested === 3) effortStr = 'medium';
      else if (requested === 2) effortStr = 'low';
      else effortStr = 'minimal';
    }

    if (supported.includes(effortStr)) return effortStr;

    // Snap to the closest supported tier at or below the request.
    const reqRank = EFFORT_RANK[effortStr] ?? 2;
    const atOrBelow = supported.filter(e => (EFFORT_RANK[e] ?? 2) <= reqRank);
    if (atOrBelow.length > 0) {
      return atOrBelow.reduce((best, e) => (EFFORT_RANK[e] > EFFORT_RANK[best] ? e : best));
    }
    return supported[0] || 'medium';
  }

  // ── Message pruning ────────────────────────────────────────────────────────

  /**
   * Drop tool-call/tool-result pairs whose call id never appeared as a call —
   * upstream 400s on dangling tool results. Never drops plain text content.
   */
  private pruneDanglingTools(messages: CCMessage[]): CCMessage[] {
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

  // ── OpenAI → CC ────────────────────────────────────────────────────────────

  translateOpenAIRequest(req: OpenAIChatRequest, opts?: { threadId?: string }): CCRequestBody {
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

    for (const m of req.messages || []) {
      if (m.role === 'system' || m.role === 'developer') {
        const textContent = typeof m.content === 'string' ? m.content : this.contentPartsToText(m.content);
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
          parts.push({ type: 'text', text: typeof m.content === 'string' ? m.content : this.contentPartsToText(m.content) });
        }
        if (m.reasoning_content) {
          parts.push({ type: 'reasoning', text: m.reasoning_content });
        }
        if (m.tool_calls && m.tool_calls.length > 0) {
          for (const tc of m.tool_calls) {
            let parsedInput: Record<string, unknown> = {};
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
        const outputVal = typeof m.content === 'string' ? m.content : this.contentPartsToText(m.content);
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
      }
    }

    const finalMessages = this.pruneDanglingTools(ccMessages);
    const targetModel = resolveModelName(req.model || '');
    const convertedTools = CommandCodeAdapter.convertTools(req.tools);
    const reasoningEffort = this.resolveReasoningEffort(targetModel, req.reasoning_effort, req.thinking);

    return {
      config: this.buildWireConfig(),
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
        ...(req.tool_choice ? { tool_choice: CommandCodeAdapter.convertToolChoice(req.tool_choice) } : {}),
        stream: true,
        max_tokens: req.max_completion_tokens ?? req.max_tokens ?? 64000,
        ...(req.temperature != null ? { temperature: req.temperature } : {}),
        ...(req.top_p != null ? { top_p: req.top_p } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
    };
  }

  // ── Anthropic → CC (full fidelity, fixes v3's dropped tool_results) ────────

  /**
   * Convert Anthropic Messages → CC wire. Key conversions v3 missed:
   *  - user tool_result blocks → tool messages with matching toolCallId
   *  - base64/url image blocks → CC image parts
   *  - thinking/redacted_thinking history → reasoning parts
   *  - system blocks array → joined text (not JSON.stringify)
   *  - tool_result is_error → [ERROR] prefix so the model sees the failure
   */
  translateAnthropicRequest(req: AnthropicRequest, opts?: { threadId?: string }): CCRequestBody {
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
            const resultText = this.anthropicResultToText(block);
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.is_error ? `[ERROR] ${resultText}` : resultText,
            });
          } else if (block.type === 'text') {
            (regularParts as any[]).push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            (regularParts as any[]).push({ type: 'image_url', image_url: { url: this.anthropicImageToDataUrl(block) } });
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
      stream: req.stream,
      tools: req.tools?.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: undefined,
      thinking: req.thinking?.type === 'enabled' ? req.thinking : undefined,
      reasoning_effort: undefined,
    };

    if (req.tool_choice) {
      const mapped = CommandCodeAdapter.convertAnthropicToolChoice(req.tool_choice);
      if (mapped) openAIReq.tool_choice = mapped as any;
    }

    const wire = this.translateOpenAIRequest(openAIReq, opts);
    return wire;
  }

  private anthropicResultToText(block: Extract<AnthropicContentBlock, { type: 'tool_result' }>): string {
    if (typeof block.content === 'string') return block.content;
    if (!Array.isArray(block.content)) return '';
    const out: string[] = [];
    for (const part of block.content) {
      if (part.type === 'text') out.push(part.text);
      else if (part.type === 'image') out.push(`[image: ${this.anthropicImageToDataUrl(part).slice(0, 64)}...]`);
    }
    return out.join('\n');
  }

  private anthropicImageToDataUrl(block: Extract<AnthropicContentBlock, { type: 'image' }>): string {
    if (block.source.type === 'url') return block.source.url;
    return `data:${block.source.media_type};base64,${block.source.data}`;
  }

  /** Anthropic base64 image → raw wire shape (original CLI format). */
  private anthropicImageToWire(block: Extract<AnthropicContentBlock, { type: 'image' }>): CCContentPart {
    if (block.source.type === 'url') {
      return { type: 'image', image: block.source.url, mediaType: 'image/png' } as any;
    }
    return { type: 'image', image: block.source.data, mediaType: block.source.media_type } as any;
  }

  private contentPartsToText(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((p: any) => (p.type === 'text' ? p.text : p.type === 'image_url' ? '[image]' : ''))
        .filter(Boolean)
        .join('\n');
    }
    return String(content ?? '');
  }

  // ── Wire config (CLI fingerprint) ──────────────────────────────────────────

  private buildWireConfig() {
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

  // ── Stream encoder state ───────────────────────────────────────────────────

  createStreamEncoderState(model: string): StreamEncoderState {
    return {
      id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
      created: Math.floor(Date.now() / 1000),
      model,
      toolCallIndex: 0,
      toolCallIdToIndex: new Map<string, number>(),
      sawFinish: false,
      hasEmittedText: false,
      promptTokens: 0,
      completionTokens: 0,
      thinkingState: 'none',
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  // ── CC event → OpenAI SSE chunk ────────────────────────────────────────────

  encodeOpenAIChunk(event: CCEvent, state: StreamEncoderState): string[] {
    const chunks: string[] = [];

    if (event.type === 'start') {
      chunks.push(this.openAIDelta(state, { role: 'assistant', content: '' }, null));
      return chunks;
    }

    if (event.type === 'error' || (event as any).error) {
      const errObj = (event as any).error || event;
      const errMsg =
        typeof errObj === 'string'
          ? errObj
          : errObj?.message ||
            (errObj as any)?.code ||
            (errObj as any)?.error ||
            '';
      const msgStr = typeof errMsg === 'string' ? errMsg : errMsg?.message || '';
      if (msgStr && msgStr !== 'unknown') {
        state.hasEmittedText = true;
        chunks.push(this.openAIDelta(state, { content: `\n[Upstream Error: ${msgStr}]\n` }, null));
      }
      return chunks;
    }

    if (event.type === 'reasoning-delta') {
      const text = event.text || event.data?.text;
      if (text) {
        state.hasEmittedText = true;
        state.outputTokens += Math.ceil(text.length / 4);
        chunks.push(this.openAIDelta(state, { reasoning_content: text } as any, null));
      }
      return chunks;
    }

    if (event.type === 'text-delta') {
      let rawText = event.text || event.data?.text || '';
      if (!rawText) return chunks;
      state.outputTokens += Math.ceil(rawText.length / 4);

      // Some models emit  thinking tags inline — split into reasoning_content.
      if (rawText.includes(' thinking') || state.thinkingState === 'in_think') {
        if (rawText.includes(' thinking') && rawText.includes(' response')) {
          const m = rawText.match(/ thinking([\s\S]*?)<\/think>/);
          if (m) {
            state.hasEmittedText = true;
            chunks.push(this.openAIDelta(state, { reasoning_content: m[1] } as any, null));
            rawText = rawText.replace(/ thinking[\s\S]*?<\/think>/, '');
          }
        } else if (rawText.includes(' thinking')) {
          state.thinkingState = 'in_think';
          const thinkContent = rawText.split(' thinking')[1] || '';
          if (thinkContent) {
            state.hasEmittedText = true;
            chunks.push(this.openAIDelta(state, { reasoning_content: thinkContent } as any, null));
          }
          return chunks;
        } else if (rawText.includes(' response')) {
          state.thinkingState = 'done';
          const parts = rawText.split(' response');
          if (parts[0]) {
            state.hasEmittedText = true;
            chunks.push(this.openAIDelta(state, { reasoning_content: parts[0] } as any, null));
          }
          rawText = parts[1] || '';
        } else if (state.thinkingState === 'in_think') {
          state.hasEmittedText = true;
          chunks.push(this.openAIDelta(state, { reasoning_content: rawText } as any, null));
          return chunks;
        }
      }

      if (rawText) {
        state.hasEmittedText = true;
        chunks.push(this.openAIDelta(state, { content: rawText }, null));
      }
      return chunks;
    }

    if (event.type === 'tool-call' || event.type === 'tool-call-delta') {
      state.hasEmittedText = true;
      const toolCallId = (event.toolCallId || event.data?.toolCallId) as string || `call_${crypto.randomUUID().slice(0, 8)}`;
      let idx = state.toolCallIdToIndex.get(toolCallId);
      if (idx === undefined) {
        idx = state.toolCallIndex++;
        state.toolCallIdToIndex.set(toolCallId, idx);
      }

      const toolName = (event.toolName || event.data?.toolName || event.name || event.data?.name) as string || 'tool';
      const input = event.input ?? event.data?.input ?? event.arguments ?? event.data?.arguments;
      const argsStr = typeof input === 'string' ? input : input ? JSON.stringify(input) : '';

      chunks.push(
        `data: ${JSON.stringify({
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: state.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: idx,
                    id: toolCallId,
                    type: 'function',
                    function: { name: toolName, arguments: argsStr },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      return chunks;
    }

    if (event.type === 'finish' || event.type === 'finish-step') {
      state.sawFinish = true;
      // Original CLI: usage lives at event.totalUsage; data.usage is legacy.
      const usage = event.totalUsage ?? event.data?.usage;
      if (usage) {
        if (usage.inputTokens) state.inputTokens = usage.inputTokens;
        if (usage.outputTokens) state.outputTokens = usage.outputTokens;
      }
      const rawFR = event.finishReason || event.data?.finishReason || (state.toolCallIdToIndex.size > 0 ? 'tool-calls' : 'stop');
      const finishReason =
        rawFR === 'tool-calls' || rawFR === 'tool_calls'
          ? 'tool_calls'
          : rawFR === 'length' || rawFR === 'max_tokens'
            ? 'length'
            : 'stop';
      chunks.push(this.openAIDelta(state, {}, finishReason));
      chunks.push('data: [DONE]\n\n');
      return chunks;
    }

    return chunks;
  }

  private openAIDelta(state: StreamEncoderState, delta: Record<string, unknown>, finishReason: string | null): string {
    return `data: ${JSON.stringify({
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  }

  // ── CC events → final Anthropic message (non-streaming) ────────────────────

  buildAnthropicResponse(events: CCEvent[], msgId: string, modelName: string, inputTokens: number) {
    let fullText = '';
    let reasoningText = '';
    const toolCalls: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = [];
    let outputTokens = 0;
    let stopReason: string | null = null;

    for (const event of events) {
      if (event.type === 'text-delta') {
        const txt = event.text || event.data?.text;
        if (txt) {
          fullText += txt;
          outputTokens += Math.ceil(txt.length / 4);
        }
      } else if (event.type === 'reasoning-delta') {
        const txt = event.text || event.data?.text;
        if (txt) {
          reasoningText += txt;
          outputTokens += Math.ceil(txt.length / 4);
        }
      } else if (event.type === 'tool-call' || event.type === 'tool-call-delta') {
        const id = ((event.toolCallId || event.data?.toolCallId) as string) || `toolu_${crypto.randomUUID().slice(0, 8)}`;
        const name = ((event.toolName || event.data?.toolName) as string) || 'tool';
        const input = (event.input ?? event.data?.input ?? {}) as Record<string, unknown>;
        const existing = toolCalls.find(t => t.id === id);
        if (existing) {
          // tool-call-delta may stream argument fragments
          if (typeof input === 'string') {
            (existing as any)._args = ((existing as any)._args || '') + input;
          } else {
            existing.input = { ...existing.input, ...input };
          }
        } else {
          toolCalls.push({ type: 'tool_use', id, name, input });
        }
      } else if (event.type === 'finish' || event.type === 'finish-step') {
        // Original CLI: totalUsage at top level; rawFinishReason ?? finishReason.
        const usage = event.totalUsage ?? event.data?.usage;
        if (usage) {
          if (usage.inputTokens) inputTokens = usage.inputTokens;
          if (usage.outputTokens) outputTokens = usage.outputTokens;
        }
        const rawFR = event.rawFinishReason || event.finishReason || event.data?.finishReason;
        if (rawFR === 'tool-calls' || rawFR === 'tool_calls') stopReason = 'tool_use';
        else if (rawFR === 'length' || rawFR === 'max_tokens') stopReason = 'max_tokens';
        else if (rawFR) stopReason = 'end_turn';
      } else if (event.type === 'error') {
        const errObj = event.error || event;
        const errMsg =
          typeof errObj === 'string'
            ? errObj
            : ((errObj as any)?.message as string | undefined) || '';
        if (errMsg && errMsg !== 'unknown') {
          fullText += `\n[Upstream Error: ${errMsg}]\n`;
        }
      }
    }

    for (const tc of toolCalls as any[]) {
      if (typeof tc.input === 'string') {
        try {
          tc.input = JSON.parse((tc as any)._args || tc.input || '{}');
        } catch {
          tc.input = { raw: (tc as any)._args || tc.input };
        }
        delete (tc as any)._args;
      }
    }

    const content: any[] = [];
    if (reasoningText) content.push({ type: 'thinking', thinking: reasoningText, signature: '' });
    if (fullText) content.push({ type: 'text', text: fullText });
    content.push(...toolCalls);
    if (content.length === 0) content.push({ type: 'text', text: '' });

    return {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content,
      model: modelName,
      stop_reason: stopReason || (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }
}
