# HANDOFF.md — 接力开发文档

> 面向跨会话 / 跨 Agent 协同的仓库版接力文档；本机部署运维细节（部署路径、自启 Run 键、日志实录等机器专属信息）保留在本地 `HANDOFF.local.md`，经 `.git/info/exclude` 排除、不入库。

## 1. 项目概况与当前状态

- **项目定位**：CommandCode Proxy v4 —— 本地 OpenAI / Anthropic 双协议网关，透明代理 CommandCode AI（逆向其 CLI wire 协议 `/alpha/generate`），自带中文管理仪表盘与多账号轮换。
- **当前版本**：4.22.4（最近 tag `v4.22.4`，最近提交 `87b1a05`）。
- **服务形态**：仅绑回环 `127.0.0.1:9090`；浏览器打开根路径 `/` 为管理面板（用量、计费周期、账号轮换、模型目录、日志、引擎开关）。
- **常驻方式**：由会话外机制托管（HKCU Run 键 `CommandCodeProxy` → `start_hidden.ps1`，或计划任务触发）；**严禁挂在 ZCode 会话后台任务上**（见第 6 节）。

## 2. 技术栈与运行基线

- Node.js ≥ 20（v22 实测）；TypeScript + Fastify 5 + undici 7。
- 核心命令（仓库根执行）：
  - 安装依赖：`npm install`（需出站网络，走本机代理）
  - 构建：`npm run build`（tsc → `dist/`，入口 `dist/index.js`）
  - 启动：`npm start` / `node dist/index.js`；Windows 隐藏启动 `start_hidden.ps1`，控制台启动 `start.cmd`
  - 开发模式：`npm run dev`（tsx watch）
- 出站网络：经本机代理（`config.json` 的 `upstream.proxy`，端口随本机代理软件漂移、以实际监听为准）；`NO_PROXY=localhost,127.0.0.1,::1` 由程序启动时强制加固环回直连。
- API key：用户级环境变量 `COMMANDCODE_API_KEY` → `.env`（两者均含明文 key，勿提交勿外传）。

## 3. 核心架构与文件拓扑

- `src/routes/`：`chat.ts`（`/v1/chat/completions`）、`messages.ts`（`/v1/messages`）、`models.ts`（`/v1/models`，支持 `?plan=` 过滤）、`dashboard.ts`（管理面板 + `/api/usage/overview` + 引擎开关）、`sse-common.ts`（SSE 公共翻译）。
- `src/adapters/commandcode/`：`adapter.ts`（协议翻译）、`upstream.ts`（重试 / 空闲看门狗）、`pipeline/`。
- `src/utils/`：`config.ts`（账号 / OAuth / 轮换）、`quota-tracker.ts`、`usage-store.ts`、`security-guard.ts`（SSRF / DNS rebinding 防护）、`proxy-agent.ts`（出站代理 + 连通性探针）。
- **数据流**：客户端 → Fastify 路由 → adapter 翻译为 CommandCode wire 协议 → upstream（经出站代理或 IPv4 直连）→ `api.commandcode.ai` → SSE 翻译回传；用量落 `~/.commandcode/usage-history.jsonl`。
- 运行期文件（仓库根，均被 `.gitignore` 忽略）：`.env`、`config.json`、`models.json` / `pricing.json`（启动自动同步）、`logs/`（`proxy.log` 程序日志、`audit.log` 审计、`proxy.out.log` / `proxy.err.log` 控制台链日志——OEM 代码页中文可能乱码，不影响功能）。

## 4. 最近一轮变更与交付成果

- **4.22.2**：修复 fake-ip DNS 误拦上游（`BLOCKED_HOST` allowlist + `COMMANDCODE_UPSTREAM_ALLOWED_HOSTS` 白名单）。
- **4.22.3**：集成出站 HTTP/HTTPS 代理，修复 `fetch failed` 超时。
- **4.22.4**：全局 IPv4 优先 + 代理连通性探针 Auto-fallback（换设备 / 未开代理时的连接稳定性）。
- **本次会话**：新增本仓库版 `HANDOFF.md`（接力文档入库）；原机器专属运维文档拆分为 `HANDOFF.local.md` 继续本地维护。

## 5. 接力开发指引与待办（Next Steps / Backlog）

1. **[待用户决定] `start.cmd` 有未提交改动**（内置出站代理默认端口 7897 → 7900，共 3 行）。如需推送上游，按发布流程补 CHANGELOG / README / 版本号与 tag；本机部署不依赖该提交。
2. **免费验证模型会退役**：个别 `:free` 模型上游会下线（403），用量异常时先换其他 `:free` 模型验证再排查网关本身。
3. **账号轮换与配额**：账号池状态、计费周期与 5h/周上限以面板 `/api/usage/overview` 为准；排查「额度不对」先看该接口再动配置。

## 6. 关键避坑与运行约束

- **长驻服务严禁挂在 ZCode 会话后台任务上**：ZCode 应用重启会 `taskkill` 回收旧 runtime 进程树，连坐杀掉会话托管的常驻进程（2026-10-10 实录：9090 随会话退出静默消失、日志无关闭记录）。常驻必须由会话外机制托管（Run 键 / 计划任务触发 `start_hidden.ps1`）。
- **Git Bash 调 Windows 工具必须加 `MSYS_NO_PATHCONV=1`**：`taskkill /PID`、`reg export`、`schtasks /create` 等 `/` 开头参数会被 MSYS 当路径转换而报无效语法。
- **Git Bash + curl 传中文 JSON 会 400**（`FST_ERR_CTP_INVALID_CONTENT_LENGTH`）：验证用纯 ASCII 载荷或 `--data-binary @file`。
- **启动前确认 9090 空闲**：`netstat -ano | grep ":9090"`；端口被占时新实例会直接退出（预期行为）。
- **排查「服务为什么停了」的证据顺序**：`logs/proxy.log` 尾部（有无错误 / 关闭记录）→ ZCode 进程启动时间（`Get-Process ZCode | Select StartTime`）→ 两者时间接近即为 runtime 重启连坐。
- **代理端口会漂移**：`config.json` 的 `upstream.proxy` 是兜底，环境变量优先级更高；两者应保持同值。
