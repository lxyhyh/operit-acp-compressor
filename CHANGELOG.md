# CHANGELOG

## [0.3.0] - 2026-09-07

### 架构重构（方向 1：宿主 hook 投影 + 工具走宿主通道，对齐 billion-context）

- **退役直连架构**：不再注册 AiProvider / 自建上游直连（provider/upstream/compress-loop 路径不再参与发送）。
  消除直连架构固有代价：上游单轮输出截断产生孤立 tool_call 时，插件补写 `[ACP] 工具调用被取消` 文本进历史的缺陷。
- **宿主 hook 投影**：注册 `PromptFinalizeHook`（发送前把历史投影为压缩视图，preparedHistory 整体替换），
  同一 send 周期幂等（fingerprint 去重，不重复 state mutation）。
- **ACP 工具走宿主工具通道**：新增 subpackage `acp_tools`（`dist/packages/acp_tools.js`，METADATA 声明
  compress/decompress/search_context/acp_status）；`ToolPromptComposeHook` 无条件注入 4 工具到模型可用列表；
  `SystemPromptComposeHook`（after 阶段）幂等追加中文 ACP 系统提示引导模型主动压缩。
  - compress 返回结构化干净中文说明（"压缩完成：创建 N 个 block，压缩 X tokens。"），界面可见、无内部标签。
- **不注册估算钩子**（宿主主线程同步等待估算钩子返回大 JSON 会 ANR；官方示例从不注册）。
- **新增 src/acp/**：adapter（投影/压缩/恢复/搜索/状态 + per-session 锁 + nudge 状态机）、
  lifecycle（hook 处理）、persistence（状态存 `acp-state/`，不复制 raw history）、
  messages（stableKey/toolCallId 配对/投影裁剪）、token（CJK 估算）、config（复用 acp-config.json）、
  paths/session/system-prompt/tools-meta。
- **摘要纯净**：preflight 自动折叠继续剔除 `[ACP]`/占位/记忆 JSON 噪音；投影路径剔除旧锚点残留。
- 测试 43/43 通过（新增 15 个 acp-core 用例覆盖新架构纯函数与 kernel 压缩闭环）；typecheck 0 错误。
- 产物：`dist/com.operit.acp_compressor-v0.3.0.toolpkg`（manifest + main.js + packages/acp_tools.js + ui）。

### 注意
- 使用新架构需在模型设置中把 provider 切回**原生 provider**（压缩由 hook 自动处理，模型仍可调用 compress 工具）；
  旧的 "ACP 压缩直连" provider 配置已不再被插件使用。
- 旧版 `sessions/`（v0.2.x 直连格式）与新 `acp-state/` 并存；新架构从空状态开始投影。

## [0.1.2] - 2026-09-06

### 修复（重要）

- **`<acp>` 标签泄漏到对话界面**：fold hook 此前以 `renderTags:"all"` 运行 processTurn，把 `mNNNNN` ref 标签**直接写进了返回宿主的历史文本**，导致界面/存储出现 `<acp tokens=...>mNNNNN</acp>` 内容。修复：
  - fold hook / 持久化 / 回显一律 `renderTags:"none"`（历史纯净，ref 只存在于 state 内部映射）
  - 新增 `renderRequestView()`：**仅在上游请求那一层**渲染带 `<acp>` 标签的请求视图（模型需要 ref 才能 compress；宿主/界面永远干净）
  - `historyHasAcpTags` 改为识别摘要占位元数据（SUMMARY/metadata.acpSummary），不再依赖标签文本
- 新增 2 个回归测试：fold 输出纯净（不含 `<acp>`）+ 请求视图含标签（仅模型侧）。共 17/17 通过。

### 说明

- 已安装旧版（0.1.0/0.1.1）期间，**当前会话的历史文本里可能已残留标签**——插件无法回滚宿主已存消息，标签会随旧消息保留在界面；新消息不再产生。如需彻底干净可新建会话。

## [0.1.1] - 2026-09-06

### 修复

- **配置页不出现**：UI 文件此前打在包根 `ui/`，而 main.js 在 `dist/` 下按相对 `./ui/...` require → 找不到 → 注册被静默跳过。已改为打包进 `dist/ui/settings/index.ui.js`（与真实包 message_insert 布局一致），模拟宿主注册链验证 ToolboxUiModule 成功。

### 新增

- **ACP 工具注入（模型主动压缩的前提）**：上游请求前把内核自带 schema（OpenAI 版 `ACP_TOOLS_OPENAI` / Anthropic 版四个 `{name, description, input_schema}`）合并进 tools——模型现在能看到并调用 `compress` / `decompress` / `search_context` / `acp_status`；宿主已有同名工具时去重。
- **系统提示协议说明**：折叠后历史若含 `<acp>` 标签，向第一条 SYSTEM 注入内核 `buildCompressSystemPrompt()`（原版协议文案：ref 标签含义、四工具用法、摘要历史勿当真）。
- **nudge 动作引导**：每轮请求前估算窗口占用，达阈值（≥50% 或已有压缩块）时在历史尾部追加一条 `[ACP]` USER 引导（85%+ 用强措辞），提示模型先 `acp_status` 再 `compress` 最旧段；过短会话不打扰。引导只注入本次请求视图，不污染持久化历史。
- 新增 `src/acp-guide.ts`（引导层）与 5 个自动化测试。

### 验证

- `npm test` 15/15（含工具注入去重 / Anthropic schema / 标签检测 / nudge 文案）。
- 实机安装成功、enabled=true、扫描 errors=0。

## [0.1.0] - 2026-09-06

首个可安装版本（从零开发落地）。

### 新增

- **acp-kernel 内嵌**：`acp-kernel@0.0.54`（纯 TS 压缩内核）完整内联进单文件 CJS bundle，无 `node:` 依赖。
- **QuickJS shim 层**：Intl.Segmenter / process.env / module.createRequire / crypto 纯 JS 垫片（实测 Operit QuickJS 无 Intl/process/crypto）。
- **发送前折叠 hook**：`registerPromptFinalizeHook` + `registerPromptEstimateFinalizeHook`，`before_send_to_model` 时 `processTurn` 折叠历史并整体替换返回。
- **会话状态桶**：按 chatId（来自 hook payload，实测跨轮稳定）分桶；`metadata.acpChatId` 传递给 provider 读回同桶；Tools.Files 持久化到插件目录 `sessions/`。
- **AiProvider「ACP 压缩直连」**：listModels / testConnection / calculateInputTokens（折叠后估算压住原生总结判定）/ sendMessage。
- **压缩循环**：sendMessage 内直连上游（OpenAI Chat / Anthropic Messages 双协议 + SSE 解析）；拦截 `compress` / `decompress` / `search_context` / `acp_status` 本地执行；非 ACP 工具调用以 Operit XML 约定回传。
- **preflight 兜底**：窗口 ≥85% 且历史足够长时自动折叠最早段（`preflight.ts`，fold hook 内接入）。
- **设置 UI**：Compose DSL 工具箱设置页（启用/上下文上限/nudge 阈值/硬限阈值/保护消息数），经 `ToolPkg.ipc` 读写 `acp-config.json`。
- **构建与打包**：`scripts/build.mjs`（esbuild CJS + shim banner + UI external）+ `scripts/package.mjs`（纯 Node ZIP → `.toolpkg`）。
- **自动化测试**：10 用例（kernel 往返 / fold 幂等 / OpenAI+Anthropic 协议编解码 / SSE 解析），`npm test` 全绿。
- **文档**：README / ARCHITECTURE / CHANGELOG / iteration-log / docs/IMPLEMENTATION_PLAN.md（实施方案留档）。

### 验证

- `tsc --noEmit` 0 错误；`npm test` 10/10。
- 产物检查：无 `node:` require；`registerToolPkg` 与全部 handler 模块导出。
- Node 模拟加载：`registerToolPkg()` 依次注册 FinalizeHook/EstimateFinalizeHook/AiProvider 返回 true。
- 真机安装（`debug_install_toolpkg`）：包出现在列表、enabled=true、扫描 errors=0、无注册错误日志。
