# ARCHITECTURE

## 目标

在 Operit 发送流水线内做渐进式、可逆的上下文压缩，避免「全量历史发送 + 原生硬中断总结」，且不改 Operit 本体。

## 模块职责

```
┌─────────────────────────────────────────────────────────────┐
│ ui/settings/index.ui.js   Compose DSL 设置页（独立 engine）   │
│   经 ToolPkg.ipc ↔ main（acp.get_config/set_config）          │
└──────────────────────────┬──────────────────────────────────┘
                           │ config（acp-config.json）
┌──────────────────────────▼──────────────────────────────────┐
│ main 上下文（registerToolPkg）                                │
│  registerPromptFinalizeHook  → fold.ts onFinalize            │
│  registerPromptEstimateFinalizeHook → 同上（估算路径）         │
└──────────────────────────┬──────────────────────────────────┘
                           │ before_send_to_model
┌──────────────────────────▼──────────────────────────────────┐
│ fold.ts：foldHistory                                         │
│  1) 超硬限(≥85%)+历史长 → preflight.ts 自动折叠最早段          │
│  2) processTurn(全部历史, session.state) → 折叠视图           │
│  3) 首条 metadata.acpChatId=chatId                            │
│  4) persistSession（插件目录 sessions/<chatId>.json）          │
└──────────────────────────┬──────────────────────────────────┘
                           │ preparedHistory（折叠后）
┌──────────────────────────▼──────────────────────────────────┐
│ provider 上下文（AiProvider acp_compressor）                  │
│  sendMessage:                                                │
│    chatId ← chatHistory[0].metadata.acpChatId                │
│    runCompressLoop:                                          │
│      循环(≤10轮)：                                           │
│        streamUpstream(config, history, tools)                │
│        ├ 有 compress/decompress/search_context/acp_status?   │
│        │   → 本地执行（applyCompression 等）→ 更新 state       │
│        │   → processTurn 折叠视图 → 继续下一轮                 │
│        └ 无 ACP 调用 →                                        │
│            ├ 非 ACP 工具调用 → XML 文本回传（宿主执行）         │
│            └ 返回 {text, usage}                               │
└─────────────────────────────────────────────────────────────┘
```

## 数据流与状态权威

- **状态权威**：`CompressionState`（acp-kernel）按 chatId 持久化为 JSON 到插件配置目录
  `sessions/<safe chatId>.json`。main 与 provider 上下文无共享内存态，以磁盘文件为桥。
- **chatId 稳定性**：fold hook 的 `eventPayload.chatId` 跨轮稳定（真机证据 cfbb8539-…）；
  provider payload 的 chatId 若为随机 executionChatId，则读回首条消息 `metadata.acpChatId`。
- **消息 id**：稳定指纹 `t<index>_<contentHash>`（FNV-1a 双种子，纯 JS），跨轮重发稳定，
  使 acp-kernel 的 ref 对账/幂等（不重复折叠）成立。

## 幂等三角保障

1. **稳定 id**：内容指纹 → 同一消息跨轮 id 不变。
2. **占位识别**：压缩后摘要占位 id=`acp_summary_<blockId>`、role=system、
   metadata{acpSummary,acpId}，再次 processTurn 时 syncBlocks 识别、prune 复用锚点。
3. **已覆盖消息去重**：applyCompression 把 covered raw id 记录进 block，重发原消息会被
   prune 移除并注入占位，不二次压缩（块套块由 tier 晋升规则处理）。

## 关键设计决策

| 决策 | 理由 |
|---|---|
| 内嵌 acp-kernel 而非代理 | Operit 的总结判定用本地估算、AiProvider 不传会话 id；代理方案身份漂移。Phase 0 验证 acp-kernel 纯 JS 可进 QuickJS（仅需 Intl.Segmenter shim）。 |
| CJS 单文件 bundle | 宿主以 CJS/script 加载 main.js（真实包均为 `exports.registerToolPkg`）；UI 文件独立 external require。 |
| handler 模块导出 | 宿主要求注册 handler 带 `__operit_toolpkg_module_path`，`resolveDurableFunctionRef` 需从模块 exports 解析函数 → main.ts re-export 全部 handler。 |
| Tools.Net.http 一次性请求 + 本地 SSE 解析 | Tools.Net 无流式 API（类型实测）；服务端流响应仍可整包取回后按 SSE 解析；分块回传用 sendIntermediateResult。 |
| 配置走 IPC + JSON | UI/main/provider 不同 engine；配置写入 acp-config.json，hook 读取。 |
| preflight 硬限兜底 | 模型一直不 compress 时 ≥85% 主动折叠最早段，防原生 token 超限中断。 |

## 风险与未决

- **真机长会话**：图片 base64 / 工作区 XML 逐轮是否与指纹一致（漂移则改用 metadata 序号锚定）。
- **Anthropic 分支**：协议层已单测，但未做端到端直连验证。
- **Ui 注册**：Compose DSL props 以运行时为准（真实 UI 尚未人工打开验证）。
- **enabled 开关**：config.enabled=false 时 hook 应跳过折叠（当前 hook 未读开关，见 TODO）。