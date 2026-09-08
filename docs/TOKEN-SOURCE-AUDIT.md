# TOKEN SOURCE AUDIT（V0.7.1 前置调查）

> 依据建议文档第 23 节：正式改代码前，先完成所有可用 token 数据源的审计。
> 审计时间：2026-09-08；针对 Operit 宿主 + com.operit.acp_compressor 插件现状。

## 1. 候选数据源总览

| # | 数据源 | 字段 | 获取位置 | 生命周期 | 真实度 | 精度 | 含 system prompt | 含 tools | 含 workspace | 含 cache | 含压缩前历史 |
|---|--------|------|----------|----------|--------|------|------------------|----------|--------------|----------|--------------|
| A | Projection Estimate | `tokenEstimate`（CJK 加权自算） | `src/acp/token.ts` | 每次 project 重算 | ❌ 预测 | 中（仅 turns 文本） | 看确认 | 否 | **否** | 否 | 否 |
| B | Host currentWindowSize | `chats.currentWindowSize` | 宿主 DB `app_database`（`chats` 表） | 随请求更新 | ✅ 宿主 tokenizer | 高 | 否（宿主核心消息窗口） | 未知 | 未知 | unknown | **否（压缩后窗口）** |
| C | Upstream usage（含 cached） | `inputTokens/cachedInputTokens` | 宿主 DB `message_variants` 表（每 variant） | 每次请求写入 | ✅ 真实 provider 记账 | 高 | 未知 | 未知 | 未知 | **含（>99% cached）** | 视 provider |
| D | messages.inputTokens | 每消息请求规模 | 宿主 DB `messages` 表 | 随请求写入 | ⚠️ 非累计 | 中 | - | - | - | - | - |

## 2. 关键实验证据（2026-09-08 实测）

### 2.1 宿主真实上下文 vs 插件估算 vs API 计费（会话 11f990c4，07:31 一轮）

| 指标 | 值 | 说明 |
|---|---|---|
| 插件 `tokenEstimate`（CJK 投影估算） | 154,018 | 只算 turns 文本 |
| host `currentWindowSize` | 90,765 | 宿主 tokenizer 对当前（已投影）窗口的计数 |
| API 计费 `inputTokens`（messages 表增量） | 约 3,459,621 | UI 展示的请求输入规模 |
| `message_variants.cachedInputTokens` | 173,952 / in=174,063 | **cached 命中率 >99.9%** |

**结论**：
- host `currentWindowSize` 是**压缩后**窗口（远小于压缩前历史），是可用于压力判定的"宿主视角真实值"。
- API 计费 input 的"几百万"大部分是 **cache 读取**（便宜，且非真实 context），按 Anthropic 规范需 `input + cache_read + cache_creation` 才是总 context；若把 prompt_tokens 当总览会 double-count（第 8 阶段协议感知正是为此）。
- `messages.inputTokens` 增量**正负剧烈跳变**（+293万/-292万/-639万），非单调累计 → **不能**当真实锚点；真实累计在 `chats.inputTokens`（仅总账，不适合作当前压力）。

### 2.2 hook payload 不含 token
`PromptHookEventPayload` 仅含 `chatHistory/preparedHistory/systemPrompt/toolPrompt/modelParameters/availableTools/metadata`，**无任何 usage/token**。
→ estimate/finalize 阶段宿主不把计数传给插件（第 5.2 节审计项）。

### 2.3 Tools.Chat 可达性
- `Tools.Chat.listChats()` → `ChatInfo{ inputTokens, outputTokens, ... }`：仅**累计**总账，无当前窗口值。
- `Tools.Chat.getMessages()` → 每条仅 `sender/content/timestamp`，**无 token**。
- `registerAiProvider.calculateInputTokens`：**供应商注册侧** handler，插件不接管 provider 链路，**不可调用**。
- 结论：宿主未通过正式 API 暴露"当前窗口 token" → 只能走 **HostUsageAdapter + DB fallback**（封装、只读、失败返回 undefined）。

### 2.4 per-Hop 触发时机
- trace 显示每次用户消息周期 hook 链触发 1 次 `before_finalize_prompt` 的 `project()`（尚未观察到宿主在单条用户消息内多次触发）。
- Provider 返回的多轮 tool-loop API 调用**不经过**最终 finalize hook；因此"每 Model Hop 都评估"在宿主当前 hook 模型下，插件实际只能覆盖**用户消息粒度**的评估点（第 15 阶段尽力而为，P0-9 需真实 E2E 复核）。

## 3. 设计决策（对应建议文档）

1. 新建 `src/acp/token-source.ts`：`TokenSource`/`UsageSample`/`TokenSnapshot` 类型（第 3 阶段）。
2. 新建 `src/acp/usage.ts`：`UsageManager`，per-session 隔离，`getEffectiveSnapshot()` 用 `max(correctedActual, host, estimate)`，含 `compressionCreditTokens` 生命周期（第 4-6、9 阶段）。
3. 新建 `src/acp/host-usage-adapter.ts`：`HostUsageAdapter` 接口 + `createOperitHostUsageAdapter()`（读取宿主 `chats.currentWindowSize`，WAL 兼容、只读、失败返回 undefined、**不允许因 DB 错误拖垮请求**、不缓存为永久 truth）（第 5 阶段）。
4. `pressure.ts` 改造：`PressureInput` 带 `estimatedTokens/actualTokens/hostTokens/compressionCreditTokens`，输出 `effectiveTokens/pressurePct/source/reason`；**严禁 `estimatedUsage` 冒充 `actualUsage`**（第 7 阶段）。
5. `normalizeUsage(protocol)`：Anthropic / OpenAI Chat / Responses 协议感知，防止 cached double-count（第 8 阶段）。
6. per-hop trace：输出 estimate/actual/host/credit/effective/pressure/source/decisionReason（第 13 阶段）。
7. state 字段语义拆分：`compressionCreditTokens`、`lastCompressionContextTokens`、`compressionBaselineTokens`、`creditBaseToken` 拆开，不再兼任（第 9 阶段）。

## 4. Audited：明确不可用/废弃
- ❌ `messages.inputTokens` 单条增量（非单调，回退巨幅）→ 不可作锚点。
- ❌ `chats.inputTokens`（累计总账，含压缩前历史）→ 不可作当前压力。
- ❌ fake `actualUsage = tokenEstimate/limit` → 删除（P0-2）。
- ❌ `registerAiProvider.calculateInputTokens`（供应商侧，插件不可调）。