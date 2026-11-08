# AGENTS.md — commandcode-proxy

## 项目概览

本地 OpenAI Chat Completions 与 Anthropic Messages 双协议兼容网关（Command Code AI 上游），带中文管理面板：
多账号轮换、用量计费、模型目录、翻译加固、重试与空闲超时。TypeScript + Fastify 实现，监听 127.0.0.1:9090。
当前版本 **v4.22.4**（2026-10-01），测试 48 套件 / 626 用例。

## 构建与测试命令

Node >= 20，ESM（`"type": "module"`）。运行时依赖仅 `fastify` + `undici`。以下命令均来自 `package.json` scripts 与 `.github/workflows/ci.yml`：

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式（tsx watch `src/index.ts`） |
| `npm run build` | TypeScript 编译（tsc → dist） |
| `npm start` | 运行编译产物（node dist/index.js） |
| `npm test` | vitest run（pretest 先执行 build） |
| `npm run typecheck` | tsc --noEmit |
| `npm run lint` | eslint . |
| `npm run test:coverage` | vitest 覆盖率（CI 门禁 statements >= 65%） |
| `npm run build:win` | esbuild 打包 + pkg 出 Windows 单文件 exe |

CI（ci.yml）顺序：`npm ci` → lint → typecheck → build → vitest run → coverage → 上传 dist。发版由 release.yml 自动发布，推送后需按规范核验标题与正文。

## 代码风格约定

- TypeScript 严格模式，源码分层 `src/adapters`（协议翻译）、`src/routes`（HTTP 端点）、`src/utils`、`src/types`，入口 `src/index.ts`。
- 测试为 vitest（`tests/*.test.ts`），含快照测试（adapter）与安全守卫用例（dns-rebinding、log-redaction、key 掩码等）——改协议翻译必须同步快照。
- 中文注释与管理面板文案；日志脱敏（key 掩码）是硬要求，新增字段输出前先看 `tests/log-redaction.test.ts`。
- eslint（typescript-eslint flat config）+ typecheck 双检，提交前两者全绿。

## 提交与发布规范

- Conventional Commits + 中文描述，近期实例：`feat(network): ...`、`fix(startup): ...`、`refactor(upstream): ...`、`chore(release): 4.22.0 —— ...`；功能性分支以 merge commit 入 main。
- 变更记录写入 `CHANGELOG.md`（`[Unreleased]` + 版本段）；仓库版 `HANDOFF.md` 随代码维护，机器专属运维细节放本地 `HANDOFF.local.md`（git 排除，不入库）。
- 发布走 annotated tag：`git tag -a vX.Y.Z -m "vX.Y.Z: <中文核心摘要>"`，推送后核验 GitHub Release 标题与中文正文对齐 CHANGELOG。

## 项目专属注意

1. **长驻服务严禁挂 ZCode 会话后台任务**：ZCode 重启会 taskkill 回收进程树连坐杀掉 9090（2026-10-10 实录）。常驻必须由会话外机制托管（计划任务 `start_hidden.ps1`）。
2. **启动前确认 9090 空闲**（`netstat -ano | grep ":9090"`），端口被占时新实例直接退出属预期行为；排查停机先看 `logs/proxy.log` 尾部。
3. **Git Bash 调 Windows 工具加 `MSYS_NO_PATHCONV=1`**（taskkill /PID 等会被路径转换破坏）；**curl 传中文 JSON 会 400**，验证用 `--data-binary @file`。
4. **代理端口会漂移**：`config.json` 的 `upstream.proxy` 与环境变量应保持同值，环境变量优先级更高；出站网络已带 IPv4 优先 + 代理探针 Auto-fallback（4.22.4）。
