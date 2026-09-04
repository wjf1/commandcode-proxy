# CommandCode Proxy v4 <img src="https://img.shields.io/badge/version-4.0.0-6366f1" alt="v4">

> 中文 | [English](#english-anchor)

一个本地部署、完全兼容 **OpenAI Chat Completions** 与 **Anthropic Messages** 的 API 网关，为 **Command Code AI**（commandcode.ai）提供透明代理。任何 OpenAI 风格的客户端（Cursor、Continue、Aider、OpenWebUI、Hermes、你自己的代码）都能直接指向它，透明地使用 CommandCode 后端模型。

> 非官方社区工具。逆向自官方 CommandCode CLI wire 协议（`/alpha/generate`），与 CommandCode 无任何关联。

---

## ✨ 功能特性

- **OpenAI `/v1/chat/completions`** — 流式 SSE + 非流式，工具调用（并行工具、流式 `tool_calls` 增量），视觉（`image_url` base64/data-URL），`reasoning_effort` 映射，`max_completion_tokens`，透传上游 `totalUsage` 用量
- **Anthropic `/v1/messages`** — 流式块生命周期（`message_start` → `content_block_start/delta/stop` → `signature_delta` → `message_delta` → `message_stop`），`tool_use` / `tool_result` 往返，带签名兼容的 thinking 块，system 块数组
- **忠实还原 wire 翻译** — 经官方 CLI 源码逐行核对：原始 base64 图片块带 `mediaType`、`tool_search→search_tools` 别名、按模型细分推理档位 snap、终止性错误不重试列表（`model_not_in_plan`、`premium_credits_exhausted`、`insufficient credits`）
- **可靠性** — 429/5xx/网络错误指数退避重试，空闲流看门狗（不会无限挂起），客户端断开即取消，保证流干净收尾
- **多账号** — 仪表盘 OAuth 浏览器登录 + 手动输入 Key，5 小时额度轮换调度器（≥90% 自动切换）
- **安全默认** — 仅绑定 `127.0.0.1`（可用 `HOST` 显式开放局域网），可选 `PROXY_API_KEY` 共享密钥鉴权，XSS 加固仪表盘，CORS 仅对公共 API 表面开放
- **打包** — TypeScript 构建、esbuild 打包、`pkg` 生成单文件 Windows exe
- **中文仪表盘** — 内置界面为中文，含官方模型定价目录（上下文/输入/输出/缓存读/缓存写/能力/Deal），实时从 commandcode.ai 刷新
- **会话明细用量** — 面板的"用量与额度"标签页内置**会话明细**：逐会话记录 input/output token、耗时、成本、模型、状态，并给出按天趋势折线、模型分布饼图、今日/本周/本月成本卡片；持久化到本地 `~/.commandcode/usage-history.jsonl`，重启不丢

## 🚀 快速开始

```bash
npm install
npm run dev          # http://127.0.0.1:9090
```

或生产模式：

```bash
npm run build && npm start
```

或独立二进制：

```bash
npm run build:win    # dist/commandcode-proxy-v4.exe —— 零依赖运行
```

首次启动仪表盘会自动打开。可通过 **浏览器登录（OAuth）** 或粘贴 API Key 登录。密钥也会自动从 `~/.commandcode/auth.json` 或 `COMMANDCODE_API_KEY` 加载。

## 🧪 用法

```bash
# OpenAI 风格
curl http://127.0.0.1:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'

# Anthropic 风格
curl http://127.0.0.1:9090/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

客户端配置：OpenAI 风格设 base URL 为 `http://127.0.0.1:9090/v1`，Anthropic 风格设为 `http://127.0.0.1:9090`，密钥随意（若设置了 `PROXY_API_KEY` 则须一致）。

## ⚙️ 配置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `PORT` | `9090` | 监听端口 |
| `HOST` | `127.0.0.1` | 绑定地址（`0.0.0.0` 暴露到局域网） |
| `PROXY_API_KEY` | 未设置 | 要求 `/v1/*` 携带该密钥（Bearer 或 `x-api-key`） |
| `COMMANDCODE_API_KEY` | 取自 auth.json | 上游密钥兜底 |
| `COMMANDCODE_API_BASE` | `https://api.commandcode.ai` | 上游服务地址 |
| `COMMANDCODE_VERSION` | `1.27.1` | CLI 版本标识头 |
| `ROTATION_MODE` | `manual` | `auto-quota` 启用 30 分钟额度检查 |
| `NO_OPEN_BROWSER` | 未设置 | 设为 `1` 跳过仪表盘自动打开 |

持久化配置存于可执行文件旁的 `config.json`。

## 🛠 开发

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest —— 单元 + 集成（mock 上游）
npm run build:exe    # esbuild 打包
npm run build:win    # Windows exe
```

测试会拉起一个 mock CommandCode 上游，端到端跑通真实 HTTP 面：流式 chunk 形状、工具调用往返、推理档位 snap、Anthropic 块生命周期。

详见 [HERMES_TEST_PROMPT.md](./HERMES_TEST_PROMPT.md) 了解 agent 驱动的自测方案（让 LLM agent 穿过代理跑真实行为验证）。

## 🏗 架构

```
src/
├── index.ts                      # 启动引导、额度轮换调度、可选鉴权钩子
├── types/index.ts                # OpenAI / Anthropic / CC-wire 契约
├── adapters/commandcode/
│   ├── adapter.ts                # 翻译引擎（两种协议 ↔ CC wire，含中文注释）
│   └── upstream.ts               # HTTP 客户端：重试、空闲看门狗、中止
├── routes/
│   ├── chat.ts                   # POST /v1/chat/completions
│   ├── messages.ts               # POST /v1/messages
│   ├── models.ts                 # GET /v1/models、refresh
│   └── dashboard.ts              # 中文 SPA + 管理 API
└── utils/
    ├── config.ts                 # 账号、OAuth 流程、额度轮换
    ├── models.ts                 # 目录同步 + 模糊模型名解析
    ├── usage-store.ts            # 会话明细持久化 + 聚合统计
    └── logger.ts                 # 净化环形缓冲日志
```

## 📄 免责声明与许可证

本项目通过观察官方 CLI 的网络行为来与私有 API 互通。上游协议变动时可能失效，使用可能受 CommandCode 服务条款约束。请用自己的账号与凭据使用。

本项目使用 **MIT 许可证** 发布，详见 [LICENSE](./LICENSE)。

---

## <a id="english-anchor"></a>English

A local, fully-compatible **OpenAI Chat Completions** and **Anthropic Messages** API gateway for CommandCode AI. Point any OpenAI-style client (Cursor, Continue, Aider, OpenWebUI, Hermes, your own code) at it and use CommandCode backend models transparently.

> Unofficial, community tool. Reverse-engineered from the official CommandCode CLI wire protocol (`/alpha/generate`). Not affiliated with CommandCode.

### Features

- **OpenAI `/v1/chat/completions`** — streaming SSE + non-streaming, tool calling (parallel tools, streamed `tool_calls` deltas), vision (`image_url` base64/data-URL), `reasoning_effort` mapping, `max_completion_tokens`, usage passthrough from upstream `totalUsage`
- **Anthropic `/v1/messages`** — streaming block lifecycle (`message_start` → `content_block_start/delta/stop` → `signature_delta` → `message_delta` → `message_stop`), `tool_use` / `tool_result` round-trip, thinking blocks with signature compatibility, system block arrays
- **Faithful wire translation** verified against the original CLI source: raw-base64 image parts with `mediaType`, `tool_search→search_tools` aliasing, per-model effort tier snapping, terminal-error no-retry list (`model_not_in_plan`, `premium_credits_exhausted`, `insufficient credits`)
- **Reliability** — exponential-backoff retries on 429/5xx/network errors, idle-stream watchdog (no infinite hangs), client-disconnect cancellation, clean stream termination guaranteed
- **Multi-account** — dashboard OAuth browser login + manual key entry, 5-hour quota rotation scheduler (auto-switch ≥90%)
- **Secure defaults** — binds `127.0.0.1` only (opt-in LAN via `HOST`), optional `PROXY_API_KEY` shared-secret auth, XSS-hardened dashboard, CORS limited to the public API surface
- **Packaging** — TypeScript build, esbuild bundle, single-file Windows exe via `pkg`
- **Chinese dashboard** — built-in Chinese UI with official model pricing catalog (context/input/output/cache read/cache write/caps/deals) refreshed live from commandcode.ai
- **Per-session usage history** — the dashboard's Usage tab includes a **session detail view**: records input/output tokens, latency, cost, model, and status per request, visualized with a daily trend line, model-distribution doughnut, and today/week/month cost cards; persisted to `~/.commandcode/usage-history.jsonl`, survives restarts

### Quick Start

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

### Configuration

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

### Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest — unit + integration (mock upstream)
npm run build:exe    # esbuild bundle
npm run build:win    # Windows exe
```

### Disclaimer

This project interoperates with a private API by observing the official CLI's network behavior. It may break when the upstream protocol changes, and usage may be subject to CommandCode's terms of service. Use with your own account and credentials.
