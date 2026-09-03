# Hermes — Proxy Self-Test Mission (you are the client)

You are Hermes, an AI agent running THROUGH a local proxy gateway. Your traffic flows:
`you → http://127.0.0.1:9090/v1/chat/completions (OpenAI-compatible) → CommandCode upstream`.

The proxy was built to be a drop-in replacement for the OpenAI Chat Completions API. Your job:
**use yourself as the test subject**. Exercise every capability a real OpenAI client would use,
watch for anything that feels broken, and report it precisely so the proxy can be fixed.

Do NOT test the dashboard, security, or source code. Only test the API behavior you experience
as a client. Everything you need is at `http://127.0.0.1:9090`.

---

## How to run tests

- If you have a code/shell tool: write small Node.js scripts in `hermes-tmp/` that call the API
  directly with `fetch` and dump RAW responses (especially raw SSE lines for streaming tests).
  Raw evidence beats your impressions.
- If you only have your own chat loop: run each scenario as a real conversation and report
  exactly what you received vs expected.
- Run scenarios in order. After each, log: request JSON, raw response (or first/last chunks),
  verdict `PASS / FAIL / PARTIAL`, and one-line issue description.
- Streaming test rule: always inspect the RAW SSE text — `data: {...}` lines and the final
  `data: [DONE]`. Chunk order and shape matter as much as content.
- Tool-loop safety rule: never loop a tool call more than 5 times. If the model (you) keeps
  requesting tools without resolving, or tool results never reach you, STOP and report — that
  is exactly the kind of bug we're hunting.

## Endpoints

- `POST /v1/chat/completions` — main target
- `POST /v1/messages` — Anthropic-style (secondary; test if time permits)
- `GET  /v1/models` — list available model ids first; pick 2-3 for your tests (one claude, one gpt, one other)
- `GET  /health` — confirm proxy is up before starting

---

## Test Plan (execute all, in order)

### T1 — Basic non-streaming chat
Send: small messages array, `max_tokens: 100`, `stream: false`.
Verify: response has `id` starting `chatcmpl-`, `object: "chat.completion"`, `choices[0].message.role === "assistant"`, non-empty `content`, `finish_reason: "stop"`, and a `usage` object with non-zero `prompt_tokens`/`completion_tokens`.
Report: exact usage numbers (tells us if upstream usage or estimates are used).

### T2 — Basic streaming
Same but `stream: true`.
Verify against OpenAI spec:
- First chunk: `delta: {role: "assistant", content: ""}`
- Middle chunks: `delta: {content: "..."}` pieces that concatenate into sensible text
- Last data chunk: `delta: {}` with `finish_reason: "stop"`
- Very last line: `data: [DONE]`
- All chunks share the same `id`/`created`/`model`
Report: chunk count, any chunk missing fields, any ` thinking` text leaking into `content`.

### T3 — Reasoning / thinking visibility
Send with `reasoning_effort: "high"` (and separately omit it).
Verify: if the model reasons, deltas may arrive as `delta: {reasoning_content: "..."}` — that is
correct behavior. FAIL if: reasoning text appears inside `content`, or ` thinking` tags appear
raw in content, or setting `reasoning_effort` changes nothing at all across 3 tries.
Also test `reasoning_effort: "max"`, `"low"`, and an invalid value like `"turbo"` — the proxy
should snap invalid/unsupported values to a supported tier, never error.

### T4 — Tool calling: single call round-trip (CRITICAL)
Define a tool, e.g. `get_weather({city: string})`. Send a message that should trigger it
("What's the weather in Chennai? Use the tool.").
Verify:
- Response has `finish_reason: "tool_calls"` (NOT "stop")
- `message.tool_calls[0]` has `id`, `type: "function"`, `function.name === "get_weather"`,
  and `function.arguments` that parse as valid JSON
- `message.content` may also have text — that's fine
Then: send the follow-up turn with your assistant message (including tool_calls) AND a
`role: "tool"` message with `tool_call_id` matching, content `"28°C sunny"`.
Verify: the model uses the tool result in its answer (proves tool results survive the proxy).
FAIL patterns to watch: tool_calls never arrive; `finish_reason` is "stop" instead of
"tool_calls"; arguments JSON truncated or wrapped in prose; second turn acts like it never
saw the tool result; proxy errors 400/500 on the follow-up.

### T5 — Tool calling: streaming shape
Same as T4 but `stream: true`.
Verify: tool call arrives as `delta: {tool_calls: [{index: 0, id, type: "function", function: {name, arguments}}]}`,
and the final chunk has `finish_reason: "tool_calls"`.
Report: whether arguments arrive complete in one chunk or fragmented (both are OK if they
concatenate to valid JSON — verify by concatenating).

### T6 — Parallel tool calls (if the model supports it)
Ask something requiring 2 tools ("weather in Chennai AND weather in Delhi") with two tools defined.
Verify: two tool_calls with distinct `index` values (0 and 1) and distinct ids; both answerable
with two `role: "tool"` messages in the follow-up.

### T7 — Multi-turn conversation memory
3+ turn conversation with a fact planted in turn 1 ("my favorite color is teal"), tested in turn 3.
Verify: the model recalls it. FAIL if context is lost (proxy mangling history).

### T8 — System prompt handling
Set a system prompt ("Always answer in exactly 3 words. You are Picobot.").
Verify: behavior follows the system prompt. FAIL if ignored entirely.

### T9 — Vision / image input (if model list shows a vision-capable model)
Send content array: `[{type: "text", text: "What is in this image?"}, {type: "image_url", image_url: {url: "data:image/png;base64,<tiny 8x8 png>"}}]`.
Verify: no 400/500 error, model responds about the image (even vaguely). Report exact error if any.

### T10 — Model resolution
Request a model with a vendor prefix (e.g. `"openai/gpt-5.6-sol"` if `gpt-5.6-sol` exists) and
an unknown model (`"definitely-not-a-real-model"`).
Verify: prefix version works (proxy strips/aliases); unknown falls back to a valid model rather
than erroring — and the RESPONSE `model` field tells you which was actually used.

### T11 — Edge inputs
- Very long message (~20k chars): should not error.
- Special characters/emoji/RTL text: round-trip intact.
- `max_tokens: 1`: response truncated, `finish_reason` should be `"length"` (report if "stop").
- Empty assistant content in history + tool_calls (content: null): follow-up must still work.
- `temperature: 0` and `top_p: 0.1`: accepted without error.

### T12 — Error behavior
- Request with `messages: []` → expect OpenAI-style 400 error JSON.
- Request with a paused/stopped engine (if dashboard allows toggling) → expect clean 503 error JSON, not a hang.
- If any upstream error surfaces mid-stream, verify it arrives as a content chunk containing
  `[Upstream Error: ...]` followed by a proper finish + [DONE] (stream must always terminate cleanly).

---

## Report format (final deliverable)

```
# Hermes Proxy Test Report
## Setup (models used, date, proxy /health output)
## Results Table: T1..T12 → PASS/FAIL/PARTIAL → one-line note
## Detailed Issues (for each FAIL/PARTIAL):
- Test: T#
- What I sent: <exact request JSON>
- What I got: <exact raw response/SSE excerpt>
- Expected (OpenAI behavior): <one line>
- Suspected cause (client-side guess): <one line, e.g. "tool results likely dropped in translation">
- Severity: Critical / High / Medium / Low
## Streaming observations (chunk shapes seen, anomalies)
## Overall verdict: which flows are safe for daily use, which are broken
```

Rules: be honest and specific — "it felt weird" is useless, raw JSON is gold. If everything
passes, say so; a clean bill of health is also a result. Do not fix anything yourself; report only.
