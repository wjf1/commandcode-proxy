// =============================================================================
// 类型定义：三大协议的契约（按域拆分，此处聚合 re-export）
// -----------------------------------------------------------------------------
// 本目录定义了三套互相转换的数据结构（架构 Phase 1 起按域拆分，类型定义内容
// 零变化，全仓 import 路径保持 '../types/index.js' 不变）：
//   1. Gateway 配置（gateway.ts：GatewayConfig 及其文件形态 GatewayConfigFile、
//      账号 AccountInfo、日志条目 LogEntry）
//   2. OpenAI Chat Completions API（openai.ts：OpenAIChatRequest / OpenAIMessage / ...）
//   3. Anthropic Messages API（anthropic.ts：AnthropicRequest / AnthropicMessage / ...）
//   4. CommandCode 私有 wire 协议（upstream.ts：CCRequestBody / CCMessage / CCEvent / ...）
//      —— 逆向自官方 CLI，是翻译引擎的"归一化中间语"。
//   5. 模型元数据（models.ts：ModelItem / ModelPricing / ModelCaps / ModelDeal）
// 这些接口是翻译正确性的根基，改动需同步更新 adapter 与路由。
// =============================================================================
export * from './gateway.js';
export * from './openai.js';
export * from './anthropic.js';
export * from './upstream.js';
export * from './models.js';
