# operit-acp-plugin

在 Operit（Android AI Agent）内实现**渐进式、可逆的上下文压缩**的 ToolPkg 插件：把 acp-kernel（billion-context 的压缩内核）内嵌为 Operit 插件，在 Operit 发送流水线内折叠历史，使实际发送给模型的历史从「全量」降为「摘要占位 + 新内容」，且不触发原生硬中断总结、不重复压缩。

## 一句话简介

模型在长任务中通过 `compress` / `decompress` / `search_context` / `acp_status` 工具主动管理自己的上下文；插件在发送前折叠、直连上游、拦截 ACP 工具调用本地执行——对话不中断、压缩可逆。

## 安装与启用

1. 构建：`npm install && npm run build && npm run package`（产物 `dist/com.operit.acp_compressor-v*.toolpkg`）
2. Operit → 包管理 → 导入 `.toolpkg`（开发期可用 `operit_editor:debug_install_toolpkg`）
3. 重启 Operit（UI 实例缓存）
4. 工具箱 → 「ACP 上下文压缩」设置页可调阈值；模型设置中选择「ACP 压缩直连」Provider 并使用上游端点/密钥

> 建议：Operit 设置 → 上下文与总结 → 关闭「按消息条数触发总结」，把上下文管理交给本插件。

## 运行方式（架构）

```
Operit 发送流水线
  ↓ registerPromptFinalizeHook(before_send_to_model)
  ↓ 折叠：processTurn(全量历史) → 摘要占位 + 新消息      [state 按 chatId 持久化]
  ↓ AiProvider acp_compressor.sendMessage
  ↓ 直连上游（OpenAI Chat / Anthropic Messages，SSE 解析）
  ↓ 模型调用 compress? → 本地 applyCompression → 折叠视图 → 重发
  ↓ 模型调用其他工具? → 以 Operit XML 约定文本回传（宿主执行）
  ↓ 返回最终文本
```

## 目录说明

```
operit-acp-plugin/
├── manifest.json          # ToolPkg 清单（main=dist/main.js）
├── src/
│   ├── main.ts            # 入口：注册 IPC + fold hook + AiProvider + UI
│   ├── kernel.ts          # acp-kernel 封装（processTurn/applyCompression/decompress/search/status）
│   ├── fold.ts            # finalize hook：发送前折叠（含 preflight 兜底）
│   ├── state.ts           # 按 chatId 的压缩状态桶 + 持久化（Tools.Files）
│   ├── compress-loop.ts   # sendMessage 内压缩循环（拦截 compress → 本地执行 → 重发）
│   ├── provider.ts        # AiProvider：listModels/testConnection/calculateInputTokens/sendMessage
│   ├── upstream.ts        # 上游直连：OpenAI/Anthropic body + SSE 解析
│   ├── nudge.ts           # 窗口阈值判断（nudge / hard-limit）
│   ├── preflight.ts       # 超硬限主动折叠兜底
│   ├── config.ts          # acp-config.json 读写（IPC 供 UI 调）
│   ├── types.ts           # PromptTurn ⇄ CoreMessage 转换 / 指纹 id / 估算
│   └── shims/             # QuickJS 环境 shim（Intl.Segmenter / module / crypto / process）
├── ui/settings/index.ui.js  # Compose DSL 设置页（启用/阈值/上下文上限/保护条数）
├── scripts/
│   ├── build.mjs          # esbuild：TS → CJS 单文件 dist/main.js（含 acp-kernel 内联 + shim）
│   └── package.mjs        # 纯 Node ZIP 打包 .toolpkg
├── tests/                 # Node 自动化测试（.mts，10 用例）
├── docs/                  # 实施方案（IMPLEMENTATION_PLAN.md）/ 架构说明
└── operit-types/          # 官方 Operit types 快照
```

## 依赖

- `acp-kernel@0.0.54`（MIT，ranxianglei）——唯一运行时依赖，纯 TS 压缩内核
- 构建期：typescript / esbuild / tsx

## 验证

- `npm run typecheck`：0 错误
- `npm test`：10/10 通过（kernel 往返 / fold 幂等 / 上游协议编解码）
- 产物 `dist/main.js`：无 `node:` require；acp-kernel 完整内联；CJS 导出 `registerToolPkg` 与全部 handler
- 实机安装：`debug_install_toolpkg` 成功，扫描 errors=0，无注册错误日志

## 卸载

Operit 包管理删除本插件即可；`sessions/` 与 `acp-config.json` 保留在插件目录（如需彻底清除可删除插件目录）。
