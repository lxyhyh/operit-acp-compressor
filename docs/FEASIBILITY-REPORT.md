# Operit 宿主能力调查 + 差距项可实施性报告

> 日期：2026-09-13 · 依据：宿主类型定义（operit-types/toolpkg.d.ts）+ 插件源码（src/）+ kernel 0.0.66 API + 已部署插件实测

---

## 1. Operit 宿主能力现状（调查结论）

### 1.1 插件接入面（已实锤）
插件通过 ToolPkg 协议接入 Operit，注册以下能力：

| 宿主 API | 插件用法 | 状态 |
|---|---|---|
| `ToolPkg.registerPromptFinalizeHook` | 发送前投影历史（preparedHistory 整体替换） | ✅ 使用中 |
| `ToolPkg.registerSystemPromptComposeHook` | 追加 ACP 系统提示 | ✅ 使用中 |
| `ToolPkg.registerPromptEstimateHistoryHook` | 估算链路投影（右上角计数） | ✅ 使用中 |
| `ToolPkg.registerPromptEstimateFinalizeHook` | 估算收尾（no-op，防 ANR） | ⚠️ 注册但 no-op |
| `ToolPkg.registerChatRuntimeHook` | 任务结束折叠 | ✅ 使用中 |
| `ToolPkg.registerToolLifecycleHook` | 工具生命周期 | ✅ 使用中 |
| `ToolPkg.registerToolboxUiModule` | 设置页 UI | ✅ 使用中 |
| `ToolPkg.ipc.on` | 配置读写 IPC | ✅ 使用中 |
| `ToolPkg.getConfigDir` | 配置目录 | ✅ 使用中 |
| `Tools.Files.*` | 文件读写 | ✅ 使用中 |
| `Tools.system.shell` / `Tools.android.executeShell` | 系统命令 | ✅ 使用中 |

### 1.2 宿主契约关键点（决定可实现性）

**PromptTurnKind**：`SYSTEM | USER | ASSISTANT | TOOL_CALL | TOOL_RESULT | SUMMARY` —— **有 TOOL_CALL/TOOL_RESULT 类型**，工具结果可被插件识别和替换。

**PromptFinalizeHook 返回**：`string | PromptTurn[] | PromptHookObjectResult`，其中 `PromptHookObjectResult` 含 `preparedHistory: PromptTurn[]` —— **可整体替换历史（含工具结果）**。

**Hook 事件 payload**：`stage | chatId | functionType | chatHistory | preparedHistory | systemPrompt | toolPrompt | availableTools | modelParameters` —— **availableTools 可读，可判断工具是否可见**。

**已知宿主限制**（插件 docs 记录）：
- **估算钩子不能重**：宿主主线程同步等待估算钩子返回，大 JSON 会 ANR（插件因此注册为 no-op）
- **工具循环 hop 不进 finalize**：Tool Loop 内部 `processToolResults` 直连 `serviceForFunction.sendMessage`，不经过 PromptFinalizeHook → **ACP 无法在工具循环 hop 注入 nudge / 压缩**
- **hook 在独立 runtime 调用**：模块级闭包状态不可见，每次调用自行 createEngine()（读文件）
- **IPC 需模块顶层注册**（错过窗口会 channel not registered）

---

## 2. 六项差距逐一可实施性评估

### 2.1 truncate-tools（巨型工具输出截断）
- **kernel API**：`truncateLargeToolOutputs(messages, tokenCount, config, countTokens, options)`
- **宿主依赖**：需要拿到 `TOOL_RESULT` 内容并在发送前替换
- **插件现状**：finalize 可拿到完整 turns（含 TOOL_RESULT），**宿主支持直接替换**
- **接入点**：`adapter.project()` 内、投影前对 TOOL_RESULT 大输出截断
- **评估**：✅ **可实现**（低风险）。宿主 turns 含 TOOL_RESULT，finalize 可替换。注意：截断会**丢失工具输出原文**，需在 block 里留痕（与 absorb 语义一致）；且截断粒度要可配置（minOutputTokens 等）。

### 2.2 render-refs（ref 渲染策略）
- **kernel API**：`renderVisibleRefs(messages, state, countTokens, strategy)` / `createRenderRefsNode(strategy)`
- **宿主依赖**：需要把 `<acp>` ref 标签注入消息文本
- **插件现状**：`PromptTurn` 只有 `kind/content/toolName/metadata`，**content 是字符串**，可注入 ref 标签
- **接入点**：project() 渲染阶段，strategy 用 `"text-only"`（只标 user/assistant 文本，不动工具参数——宿主是结构化内容）
- **评估**：✅ **可实现**（低成本）。但需验证宿主是否接受 content 里带 `<acp ref="m00123">` 标签（会不会被转义/过滤）；需小步验证。

### 2.3 turn-integrity（防拆工具链）
- **kernel API**：`computeTurnGroups`（0.0.66 新增，防止压缩拆散 TOOL_CALL→TOOL_RESULT 链）
- **宿主依赖**：turns 里有 TOOL_CALL/TOOL_RESULT 且压缩范围不能拆散它们
- **插件现状**：kernel 0.0.66 的 `computeTurnGroups` 在 `core.processTurn`/`applyCompression` 内部已生效（**只要内核升到 0.0.66 就自动有**）
- **评估**：✅ **已隐含实现**（内核升级后自动生效）。插件无需额外代码——0.0.66 的压缩边界计算已含 turn 完整性保护。需验证：插件 `foldSelectRange`/`emergency` 段选择是否也走 kernel 边界（应该走，因为都调 `core.applyCompression`）。

### 2.4 viableRanges（可行压缩范围过滤）
- **kernel API**：`viableRanges(state, ...)` → 返回可压缩范围（过滤掉太小的、受保护的）
- **宿主依赖**：无特殊依赖
- **插件现状**：nudge 提示模型压缩，模型可能选到不可行范围（浪费一次调用）
- **接入点**：`adapter.nudge` 文案生成时，用 viableRanges 过滤提示范围，或 status 报告里列出可行范围
- **评估**：✅ **可实现**（低成本）。纯 kernel 调用，无宿主限制。收益中等（减少无效压缩调用）。

### 2.5 block-map（T2/T3 蒸馏定位 block 跨度）
- **kernel API**：`resolveBlockSpan(block, byRaw)` / `activeBlockSpans(state)` / `formatCreatedBlocks(state, newBlocks)`
- **宿主依赖**：无特殊依赖
- **插件现状**：status 报告、nudge 文案里给模型 block 列表（模型需要知道"哪些 block 可以蒸馏"）
- **接入点**：`adapter.status()` / nudge 文案生成时，用 `activeBlockSpans` 列出 block 的 ref 跨度（m00001–m00097），模型就能正确传 `compress(b1..b5)` 做 T2
- **评估**：✅ **可实现**（低成本）。**当前 T2/T3 移植缺的关键拼图**——模型不知道 block 的边界，就没法精确蒸馏。这个补上后 T2/T3 才真正可用。

### 2.6 packs/surface-config（提示词包 + 分段覆盖）
- **kernel API**：`defaultPrompts/resolvePrompts/applySectionOverrides`、`packs` 模块
- **宿主依赖**：需要用户可配置的 UI 入口 + 配置存储
- **插件现状**：已有 `ToolPkg.registerToolboxUiModule` + IPC 配置读写（acp.get_config/set_config）+ `acp-config.json`
- **接入点**：UI 设置页加"提示词包"选择（预设 packs），config 里加 `promptPack` 字段，adapter 创建 engine 时用 `resolvePrompts` + `applySectionOverrides` 应用
- **评估**：✅ **可实现**（中成本）。宿主完全支持（UI + IPC + 配置都有）。收益高（用户可自定义压缩提示词风格/语言）。注意：**用户偏好铁律**——UI 必须走 ToolboxUiModule（registerToolboxUiModule + Compose DSL），不能只用配置文件。

---

## 3. 总结：可实现性总览

| # | 差距项 | 可实现性 | 成本 | 收益 | 宿主阻碍 |
|---|---|---|---|---|---|
| 1 | truncate-tools | ✅ 可实现 | 低 | 中（省 token） | 无（finalize 可替换 TOOL_RESULT） |
| 2 | render-refs | ✅ 可实现 | 低 | 中（ref 可追踪） | 需验证 content 标签兼容性 |
| 3 | turn-integrity | ✅ **已隐含** | 0 | 高（防拆链） | 无（内核 0.0.66 自带） |
| 4 | viableRanges | ✅ 可实现 | 低 | 中（减少无效调用） | 无 |
| 5 | block-map | ✅ 可实现 | 低 | **高（T2/T3 关键）** | 无 |
| 6 | packs/surface-config | ✅ 可实现 | 中 | 高（可定制） | 无（UI+IPC 都有） |

**全部 6 项都可实现，宿主没有任何硬阻碍。** 核心原因是：插件走的是 **PromptFinalizeHook 整体替换 preparedHistory** 的架构，宿主把历史（含 TOOL_RESULT）完整交给插件，插件改完再整体替换回去——这个"整段替换"给了插件最大自由度，kernel 的能力都能接入。

**唯一需要注意的宿主限制**：
1. 估算钩子必须轻量（no-op 策略保持）
2. 工具循环 hop 不进 finalize（T2/T3 蒸馏只能靠模型主动调 compress，不能靠宿主自动触发）
3. content 标签（render-refs 的 `<acp>`）需实测宿主是否保留

---

## 4. 建议实施顺序

1. **先做 #5 block-map**（T2/T3 关键拼图，让模型能精确蒸馏）—— 低成本高收益
2. **再做 #3 turn-integrity 验证**（确认内核 0.0.66 已生效，补测试）
3. **#4 viableRanges**（减少无效压缩）
4. **#2 render-refs**（先验证 content 标签兼容性）
5. **#1 truncate-tools**（收益中等，需配置项）
6. **#6 packs/surface-config**（收益高但成本中，最后做）

> 已确认可落地的内核能力全部依赖 acp-kernel@0.0.66（插件当前已升级），无需再升内核。
