# CommandCode Proxy v4

A local, fully-compatible **OpenAI Chat Completions** and **Anthropic Messages** API gateway for CommandCode AI. Point any OpenAI-style client (Cursor, Continue, Aider, OpenWebUI, Hermes, your own code) at it and use CommandCode backend models transparently.

> Unofficial, community tool. Reverse-engineered from the official CommandCode CLI wire protocol (`/alpha/generate`). Not affiliated with CommandCode.

---

## Features

- **OpenAI `/v1/chat/completions`** — streaming SSE + non-streaming, tool calling (parallel tools, streamed `tool_calls` deltas), vision (`image_url` base64/data-URL), `reasoning_effort` mapping, `max_completion_tokens`, usage passthrough from upstream `totalUsage`
- **Anthropic `/v1/messages`** — streaming block lifecycle (`message_start` → `content_block_start/delta/stop` → `signature_delta` → `message_delta` → `message_stop`), `tool_use` / `tool_result` round-trip, thinking blocks with signature compatibility, system block arrays
- **Faithful wire translation** verified against the original CLI source: raw-base64 image parts with `mediaType`, `tool_search→search_tools` aliasing, per-model effort tier snapping, terminal-error no-retry list (`model_not_in_plan`, `premium_credits_exhausted`, `insufficient credits`)
- **Reliability** — exponential-backoff retries on 429/5xx/network errors, idle-stream watchdog (no infinite hangs), client-disconnect cancellation, clean stream termination guaranteed
- **Multi-account** — dashboard OAuth browser login + manual key entry, 5-hour quota rotation scheduler (auto-switch ≥90%)
- **Secure defaults** — binds `127.0.0.1` only (opt-in LAN via `HOST`), optional `PROXY_API_KEY` shared-secret auth, XSS-hardened dashboard, CORS limited to the public API surface
- **Packaging** — TypeScript build, esbuild bundle, single-file Windows exe via `pkg`

## Quick Start

```bash
npm install
npm run dev          # http://127.0.0.1:9090
```

or production:

```bash
npm run build && npm start
```

or the standalone binary:

```bash
npm run build:win    # dist/commandcode-proxy-v4.exe — runs with zero dependencies
```

On first launch the dashboard opens automatically. Log in via **Browser (OAuth)** or paste an API key. Keys are also auto-loaded from `~/.commandcode/auth.json` or `COMMANDCODE_API_KEY`.

## Usage

```bash
# OpenAI style
curl http://127.0.0.1:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'

# Anthropic style
curl http://127.0.0.1:9090/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

Client configuration: set base URL to `http://127.0.0.1:9090/v1` (OpenAI) or `http://127.0.0.1:9090` (Anthropic), any dummy API key (unless `PROXY_API_KEY` is set).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `9090` | Listen port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` exposes to LAN) |
| `PROXY_API_KEY` | unset | Require this key on `/v1/*` (Bearer or `x-api-key`) |
| `COMMANDCODE_API_KEY` | from auth.json | Upstream key fallback |
| `COMMANDCODE_API_BASE` | `https://api.commandcode.ai` | Upstream base |
| `COMMANDCODE_VERSION` | `1.27.1` | CLI version header |
| `ROTATION_MODE` | `manual` | `auto-quota` enables 30-min quota checks |
| `NO_OPEN_BROWSER` | unset | Set `1` to skip dashboard auto-open |

Persistent config lives in `config.json` next to the executable.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest — unit + integration (mock upstream)
npm run build:exe    # esbuild bundle
npm run build:win    # Windows exe
```

Tests spin up a mock CommandCode upstream and exercise the real HTTP surface end-to-end: streaming chunk shapes, tool-call round trips, effort-tier snapping, Anthropic block lifecycle.

See [HERMES_TEST_PROMPT.md](./HERMES_TEST_PROMPT.md) for an agent-driven self-test plan (run an LLM agent through the proxy to validate real-world behavior).

## Architecture

```
src/
├── index.ts                      # bootstrap, quota scheduler, optional auth hook
├── types/index.ts                # OpenAI / Anthropic / CC-wire contracts
├── adapters/commandcode/
│   ├── adapter.ts                # translation engine (both protocols ↔ CC wire)
│   └── upstream.ts               # HTTP client: retries, idle watchdog, aborts
├── routes/
│   ├── chat.ts                   # POST /v1/chat/completions
│   ├── messages.ts               # POST /v1/messages
│   ├── models.ts                 # GET /v1/models, refresh
│   └── dashboard.ts              # SPA + admin APIs
└── utils/
    ├── config.ts                 # accounts, OAuth flow, quota rotation
    ├── models.ts                 # catalog sync + fuzzy model resolution
    └── logger.ts                 # sanitized ring-buffer logger
```

## Disclaimer

This project interoperates with a private API by observing the official CLI's network behavior. It may break when the upstream protocol changes, and usage may be subject to CommandCode's terms of service. Use with your own account and credentials.
