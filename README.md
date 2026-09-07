# operit-acp-compressor

在 Operit（Android AI Agent）内实现**渐进式、可逆的上下文压缩**的 ToolPkg 插件：内嵌 acp-kernel（billion-context 的压缩内核），通过宿主 hook 架构在发送前把长历史投影为「摘要占位 + 新内容」，使**实际发送给模型的上下文**与 **Operit 界面右上角显示的上下文计数**同步回落，且不触发原生硬中断总结、不重复压缩。

## 特性

- **发送链路压缩**：`PromptFinalizeHook` 在发送前把历史整体替换为压缩视图（`preparedHistory`）。
- **估算链路同步**：`PromptEstimateFinalizeHook` / `PromptEstimateHistoryHook` 对估算用的历史做**只读投影**，宿主"上下文计数 / 阈值判断"基于压缩后视图，与真实发送一致。
- **可逆**：`decompress` 可恢复已折叠的块；不丢消息。
- **工具驱动**：模型通过 `compress` / `decompress` / `search_context` / `acp_status` 主动管理自己的上下文。
- **渐进兜底**：接近上限时自动提示模型压缩（nudge）；超限紧急自动折叠（EMERGENCY），对话不中断。

## 安装与启用

1. 构建：`npm install && npm run build && npm run package`（产物 `dist/com.operit.acp_compressor-v*.toolpkg`）
2. Operit → 包管理 → 导入 `.toolpkg`（开发期可用 `operit_editor:debug_install_toolpkg`）
3. 重启 Operit（UI 实例缓存）
4. 工具箱 → 「ACP 上下文压缩」设置页可调阈值

> 建议：Operit 设置 → 上下文与总结 → 关闭「按消息条数触发总结」，把上下文管理交给本插件。

## 运行方式（架构）

```
Operit 发送流水线
  ↓ registerPromptFinalizeHook      发送前折叠：全量历史 → 摘要占位 + 新消息（幂等，state 按 chatId 持久化）
  ↓ registerPromptEstimateFinalizeHook / HistoryHook
  ↓                                 估算链路只读投影：右上角上下文计数 = 压缩后视图
  ↓ registerToolPromptComposeHook   注入 ACP 工具（compress/decompress/search_context/acp_status）
  ↓ registerSystemPromptComposeHook 追加 ACP 使用指引
  ↓ 模型调用 compress? → 本地 applyCompression → 下一轮自动投影
  ↓ 模型调用其他工具? → 宿主工具通道正常执行
```

## 目录说明

```
operit-acp-plugin/
├── manifest.json            # ToolPkg 清单（main=dist/main.js）
├── src/
│   ├── main.ts              # 入口：注册 hooks（finalize/estimate/compose）+ IPC + UI
│   ├── config.ts            # acp-config.json 读写（IPC 供 UI 调）
│   ├── acp/
│   │   ├── adapter.ts       # 投影核心引擎：load state → processTurn → 返回压缩视图
│   │   ├── lifecycle.ts     # hook 处理函数（发送投影 / 估算只读投影 / 工具注入 / 系统提示）
│   │   ├── persistence.ts   # 按 chatId 的状态/块内容持久化（Tools.Files）
│   │   ├── messages.ts      # PromptTurn ⇄ CoreMessage 转换 / 摘要占位生成
│   │   ├── session.ts       # session 边界（主对话 vs 子任务隔离）
│   │   ├── system-prompt.ts # ACP 系统提示追加
│   │   ├── tools-meta.ts    # ACP 工具描述元数据
│   │   ├── token.ts         # token 估算
│   │   ├── paths.ts         # 数据目录 / 路径单一事实来源（含 resolveConfigDir）
│   │   └── config.ts        # 适配器设置 → 内核配置
│   ├── packages/acp_tools.ts # 子包：暴露 ACP 工具给宿主
│   └── shims/               # QuickJS 环境 shim（Intl.Segmenter / module / crypto）
├── ui/settings/index.ui.js  # Compose DSL 设置页（启用/阈值/上下文上限/保护条数）
├── scripts/
│   ├── build.mjs            # esbuild：TS → CJS 单文件 dist/main.js（含 acp-kernel 内联 + shim）
│   └── package.mjs          # 纯 Node ZIP 打包 .toolpkg
├── tests/                   # Node 自动化测试（.mts，19 用例）
├── docs/ARCHITECTURE.md     # 架构说明
└── operit-types/            # 官方 Operit types 快照
```

## 依赖

- `acp-kernel@0.0.54`（MIT，[ranxianglei](https://github.com/ranxianglei)）——唯一运行时依赖，纯 TS 压缩内核
- 构建期：typescript / esbuild / tsx

## 验证

- `npm run typecheck`：0 错误
- `npm test`：19/19 通过（内核往返 / 投影幂等 / 估算链路 / 消息配对等）
- 实机安装：`debug_install_toolpkg` 成功；估算/发送双链路日志正常，右上角计数随压缩回落

## 引用项目

- **[acp-kernel](https://github.com/ranxianglei/acp-kernel)**（MIT）— 压缩内核（billion-context 同源），本插件的唯一运行时依赖。
- **[billion-context-operit](https://github.com/lxyhyh/billion-context-operit)** — 在 Operit 中安装与管理 billion-context Proxy 的 ToolPkg（同作者姊妹项目）。
- **Operit** — Android AI Agent 宿主，提供 ToolPkg / hook / UI / IPC 扩展机制。

## 致谢

- 感谢 [ranxianglei](https://github.com/ranxianglei) 的 acp-kernel / billion-context，本插件的压缩内核完全来自该开源实现。
- 感谢 Operit 的 ToolPkg hook 架构（PromptFinalizeHook / PromptEstimateHook 等）为宿主内压缩提供了可能。

## License

[MIT](./LICENSE)