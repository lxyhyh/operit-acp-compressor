# P7 源码审计记录（阶段1-3，commit b2c76100 基线）

## 阶段1：任务结束信号（真实存在）

**信号源**：`InputProcessingState.Completed`（Kotlin sealed class 终态）

发射链（全部宿主源码，文件已存 p7_audit/）：
1. `MessageProcessingDelegate.kt` L261-266：响应流正常结束（无异常）→ `finalInputStateAfterSend = EnhancedInputProcessingState.Completed`（此处位于 AI 消息落库 `onVariantReady` 之后 → 消息已持久化）
2. `MessageProcessingDelegate.kt` L230-233：`isTerminalInputState = Idle || Completed` → Completed 是终态
3. `ChatRuntimeHolder.kt` L89-141：`observeRuntimeHooks()` 监听 `inputProcessingStateByChatId` StateFlow，状态变化且去重后调 `ChatRuntimeHookRegistry.dispatchAsync(STATE_CHANGED, ...)`（L106 跳过 `__DEFAULT_CHAT__`）
4. `ChatRuntimeHookRegistry.kt` L72-79：`dispatchAsync` = `dispatchScope.launch`（SupervisorJob+Dispatchers.Default 独立协程）→ 不阻塞主链、不影响已结束的 LLM stream
5. `ToolPkgChatRuntimeHookBridge.kt` L40-72：桥接 `withContext(Dispatchers.IO)` 逐个调用插件的 `runToolPkgMainHook(event=chat_runtime, eventName="state_changed")`

事件载荷（`ChatRuntimeEventPayload`，toolpkg.d.ts L589-595 + Bridge L92-106）：
`chatId / slot / state / message / toolName / progress / isActive / activeChatIds / currentTurnToolInvocationCount / activeConversationCount / currentSessionToolCount / timestamp`

状态枚举（Bridge L108-121）：`idle/processing/connecting/receiving/executing_tool/tool_progress/processing_tool_result/summarizing/executing_plan/completed/error`

**任务书 A/B/C/D 判定**：`state=completed` 对应 **D（Agent/Task execution 完成）**——它在整个 send 周期（含工具循环全部 hop、AI 消息落库）结束后置位一次，isActive=false。宿主不区分"普通聊天"与"Agent 任务"（无单独 task-finished 事件），completed 即最高置信的结束信号。

**同周期只发一次**：ChatRuntimeHolder L109-112 `previousStates[chatId] == state` 去重 → 每个状态变化只派发一次。

## 阶段2：结束阶段 Hook 选择

插件可用（toolpkg.d.ts `ToolPkgStatic`）：
- `registerChatRuntimeHook`（@since 1.0.1）—— **选中**。在响应完成后、独立协程执行，不可能破坏 LLM stream。
- `registerChatMessageHook`（message_persisted，含 inputTokens/outputTokens/cachedInputTokens）—— 备选（可作 token 数据源，但语义是"消息落库"不是"任务结束"）。
- PromptFinalizeHook —— 仅作注入通道（见阶段3），**禁止**在其中 dispatch 新请求（P6.1 实锤断链）。

注意：本插件 main.ts 此前注释"ToolLifecycleHook 已移除（宿主崩溃）"——与 ChatRuntimeHook 无关，后者走 PackageManager.runToolPkgMainHook 正常通道（Bridge 源码可证）。

## 阶段3：如何让模型主动 Compress（关键结论）

**方案 A（任务结束后立刻注入指令）不可行**：completed 时刻没有任何活跃请求，注入无人消费；主动 dispatch 新请求违反设计约束（禁令+P6.1 断链实锤）。

**方案 B（采纳）：completed 时刻评估压力 → 置 pending → 下一次正常请求的 finalize 阶段注入一次性 SYSTEM task-end 压缩指令 → 模型在响应开头主动调用 acp_tools:compress → 插件捕获落块 → 状态机推进。**

- 零额外请求、零 dispatch、零打断（复用下一次正常请求）
- 压缩发生在"上一任务已结束、下一任务尚未产生内容"的间隙（请求第一个动作），满足「任务没有结束不触发」约束的对偶面「任务已结束才触发」
- 模型主动调用的是现有 `acp_tools:compress`（工具描述+system prompt 指南均已在位，本日 5 次成功先例）
- TaskEndCompressionState 保证单次：pending → delivered → (applied|expired)

## 阶段4/5/8 快评

- 阶段4：正常成功路径现状已是「模型 compress → applyCompression」（本日 5 次）；buildDeterministicSummary 仅剩 kernel 内部 fallback（模型 summary 为空的异常降级）→ 符合要求。P6 lfold 路径整体删除（阶段8）。
- 阶段5：Block 进投影已有强实证（本日 5 次落块：52K/26.5K/13.5K/15.5K tokens，trace project blocks 递增、effPct 下降、credit 累积；decompress 后恢复原文）。原生 summary 未启用（finalize 投影由本插件接管）。
- 阶段9：不碰宿主/kernel/proxy/工具包装。P7 新增全部在插件层。

## 风险

- completed 事件载荷无 history → 压力评估用持久化 state 的 lastEstimate/usage 快照
- 模型收到指令但拒绝执行 → pending 过期，无假块（Test4）

## 宿主版本依赖（2026-09-12 补充，实机排查结论）

**`registerChatRuntimeHook`（ToolPkg API 1.0.1）尚未进入任何正式发布版本。**

实机验证（2026-09-12 02:30-02:35）：
- 本机安装 Operit **1.12.1+5（versionCode 48）= 官方最新正式版 v1.12.1**（GitHub release 2026-08-08 发布）
- 对安装 APK 全量 strings 检索：`registerChatRuntimeHook`、`ChatRuntimeHookRegistry`、`ToolPkgChatRuntimeHookBridge` 均为 **0 次命中** → 该 API 在正式版中不存在
- GitHub 对照：
  - `v1.12.1` tag：`examples/types/toolpkg.d.ts` 无 `registerChatRuntimeHook`（0）；`ChatRuntimeHookRegistry.kt`/`ToolPkgChatRuntimeHookBridge.kt` 均 404（不存在）
  - `main` 分支（最新提交 2026-09-10，审计基线 b2c76100）：API 与实现类齐全 → 本审计基于 main 分支正确，但**该代码尚未发布**
- 结论：P7 机制依赖宿主发布含 ToolPkg API 1.0.1 的版本（预计 v1.13.0+）。在宿主升级前，插件侧守卫会正确走「API 不可用 → 状态机待机」分支，不产生任何副作用；升级后需重新实机验证 Test1-6。
