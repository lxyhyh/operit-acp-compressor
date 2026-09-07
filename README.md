# operit-acp-compressor

在 Operit（Android AI Agent）内实现**渐进式、可逆的上下文压缩**的 ToolPkg 插件：内嵌 acp-kernel（billion-context 的压缩内核），通过宿主 hook 架构在发送前把长历史投影为「摘要占位 + 新内容」，使**实际发送给模型的上下文**与 **Operit 界面右上角显示的上下文计数**同步回落，且不触发原生硬中断总结、不重复压缩。

## 特性

- **发送链路压缩**：`PromptFinalizeHook` 在发送前把历史整体替换为压缩视图（`preparedHistory`）。
- **估算链路同步**：`PromptEstimateFinalizeHook` / `PromptEstimateHistoryHook` 对估算用的历史做**只读投影**，宿主"上下文计数 / 阈值判断"基于压缩后视图，与真实发送一致。
- **可逆**：`decompress` 可恢复已折叠的块；不丢消息。
- **工具驱动**：模型通过 `compress` / `decompress` / `search_context` / `absorb` / `acp_status` 主动管理自己的上下文。
- **连续压力控制（V0.7）**：Continuous Per-Hop Pressure Controller，逐 Hop 评估压力并驱动 nudge / 升级 / 压缩，取代旧的硬门控状态机。
- **渐进兜底**：接近上限时按档位提示模型压缩（gentle → strong → emergency）；超限紧急自动折叠（EMERGENCY），对话不中断。
- **巨型工具输出吸收（V0.6/Phase3）**：检测巨型 `TOOL_RESULT` 生成 absorb 候选，nudge 建议模型 `absorb` 单条巨型消息释放 token（宿主无 ToolLifecycleHook，采用候选检测 + nudge 引导方案）。
- **增量投影（V0.7 Phase7）**：工具循环高频 Hop 复用上次投影 + 仅追加增量，避免 `O(n²)` 全量重算（`O(δ)`）。
- **全链路 Trace（V0.5）**：所有关键事件（estimate / project / compress / absorb / nudge / preflight）以 JSONL 落盘，便于复盘每次压缩决策。
- **UI 状态卡 + IPC（V0.5）**：设置页实时显示运行状态、压缩统计、模型主动率。

## 版本里程碑

| 版本 | 提交 | 内容 |
|---|---|---|
| **v0.3.0** | `fa6f67f` | 初始：hook 投影 + 估算同步 + 可逆压缩 |
| **v0.4** | `f249fd0` | 主动压缩闭环：三档 nudge + Agent policy + 全链路统计 |
| **v0.4.1** | `57050ce` | usage credit 免打扰 + 指标修正 |
| **v0.4.2** | `163266b` | pressure epoch 状态机（档位只升不降 + 纪元持久化） |
| **v0.5** | `c57273e` `b6406e9` `07459a0` | absorb 注册 + UI 状态卡/IPC + ACP Trace |
| **v0.6** | `1617348` | 检测巨型工具输出 → nudge 建议 absorb（无 ToolLifecycleHook 方案） |
| **v0.7** | `6483a23` | Continuous Per-Hop Pressure Controller + Phase7 增量投影 + Phase3.1 稳定候选 |

> 根因修复：`e8a08b9` 修复 ACP 系统提示在发送链路丢失（模型从不主动压缩的根因）；`5add59c` 移除宿主不支持的 ToolLifecycleHook（曾导致全工具拦截崩溃）。

## 安装与启用

1. 构建：`npm install && npm run build && npm run package`（产物 `dist/com.operit.acp_compressor-v*.toolpkg`）
2. Operit → 包管理 → 导入 `.toolpkg`（开发期可用 `operit_editor:debug_install_toolpkg`）
3. 重启 Operit（UI 实例缓存）
4. 工具箱 → 「ACP 上下文压缩」设置页可调阈值 / 查看状态卡

> 建议：Operit 设置 → 上下文与总结 → 关闭「按消息条数触发总结」，把上下文管理交给本插件。

## 运行方式（架构）

```
Operit 发送流水线
  ↓ registerPromptFinalizeHook      发送前折叠：全量历史 → 摘要占位 + 新消息（幂等，state 按 chatId 持久化）
  ↓ registerPromptEstimateFinalizeHook / HistoryHook
  ↓                                 估算链路只读投影：右上角上下文计数 = 压缩后视图
  ↓ registerToolPromptComposeHook   注入 ACP 工具（compress/decompress/search_context/absorb/acp_status）
  ↓ registerSystemPromptComposeHook 追加 ACP 使用指引（e8a08b9 修复发送链路丢失）
  ↓ Continuous Pressure Controller   逐 Hop 计算 effective pressure → gentle/strong/emergency nudge 或预压缩
  ↓ 模型调用 compress? → 本地 applyCompression → 下一轮自动投影（V0.7 增量路径 O(δ)）
  ↓ 模型调用 absorb?    → 吸收单条巨型 TOOL_RESULT（Phase3.1 候选检测解耦 nudge）
  ↓ 模型调用其他工具? → 宿主工具通道正常执行
```

## 压力控制模型（V0.7）

逐 Hop（每次发送前）评估，取代旧的"kernel 硬总门 + cooldown"：

- **effective pressure**：usage 缺失/为 0 时用 estimate 兜底（`source=measured/estimated/hybrid`），保证冷启动也能发现压力。
- **越线档位**：gentle / strong / emergency 三档随压力升级；**同一 epoch 内档位只升不降**。
- **cooldown / credit 只抑制 gentle**；strong / emergency 必须 bypass（避免压缩后 strong 被 credit 误拦）。
- **host escalation floor**：`0.70`——kernel 沉默区（`kernelShouldInject=false`）Adapter 自接管，配合增长条件防 spam。
- **epoch 以压缩成功为边界**（非 usage 回落），支持无限连续压缩 epoch。
- **compression baseline**：压缩后记录 creditBaseToken 作增长基准，决定下一 epoch 何时重开。
- **decisionReason**：每个决策产出原因字符串（如 `strong-bypassed-cooldown-and-credit`），trace 直接回答"为何注入 / 为何不注入"。

## 目录说明

```
operit-acp-plugin/
├── manifest.json            # ToolPkg 清单（main=dist/main.js）
├── src/
│   ├── main.ts              # 入口：注册 hooks（finalize/estimate/compose）+ IPC + UI
│   ├── config.ts            # acp-config.json 读写（IPC 供 UI 调）
│   ├── acp/
│   │   ├── adapter.ts       # 投影核心引擎：load state → processTurn → 返回压缩视图
│   │   ├── pressure.ts      # V0.7 压力控制器：effective pressure / 档位 / escalate / decisionReason
│   │   ├── absorb-candidates.ts # Phase3.1 巨型 TOOL_RESULT 候选检测（稳定 ref + 持久化 + 幂等）
│   │   ├── lifecycle.ts     # hook 处理函数（发送投影 / 估算只读投影 / 工具注入 / 系统提示）
│   │   ├── persistence.ts   # 按 chatId 的状态/块内容持久化（Tools.Files）
│   │   ├── messages.ts      # PromptTurn ⇄ CoreMessage 转换 / 摘要占位生成
│   │   ├── session.ts       # session 边界（主对话 vs 子任务隔离）
│   │   ├── system-prompt.ts # ACP 系统提示追加
│   │   ├── tools-meta.ts    # ACP 工具描述元数据
│   │   ├── token.ts         # token 估算
│   │   ├── paths.ts         # 数据目录 / 路径单一事实来源（含 resolveConfigDir）
│   │   ├── trace.ts         # ACP Trace（JSONL 全链路事件时间线落盘）
│   │   └── config.ts        # 适配器设置 → 内核配置
│   ├── packages/acp_tools.ts # 子包：暴露 ACP 工具给宿主
│   └── shims/               # QuickJS 环境 shim（Intl.Segmenter / module / crypto）
├── ui/settings/index.ui.js  # Compose DSL 设置页（启用/阈值/上下文上限/保护条数 + 状态卡）
├── scripts/
│   ├── build.mjs            # esbuild：TS → CJS 单文件 dist/main.js（含 acp-kernel 内联 + shim）
│   └── package.mjs          # 纯 Node ZIP 打包 .toolpkg
├── .github/workflows/build.yml # GitHub Actions 云端一键构建（push 触发，typecheck+test+build+package）
├── build-local.sh           # 本地一键构建（.gitignore，不入库）
├── tests/                   # Node 自动化测试（.mts，40 用例）
├── docs/ARCHITECTURE.md     # 架构说明
└── operit-types/            # 官方 Operit types 快照
```

## 依赖

- `acp-kernel@0.0.54`（MIT，[ranxianglei](https://github.com/ranxianglei)）——唯一运行时依赖，纯 TS 压缩内核
- 构建期：typescript / esbuild / tsx

## 验证

- `npm run typecheck`：0 错误
- `npm test`：**40/40 通过**（内核往返 / 投影幂等 / 估算链路 / 消息配对 / pressure 契约 P1-P10 / absorb 候选 / 增量投影）
- `pressure.test.mts` 覆盖文档第十五节 15 项验收，含 20-Hop soak（多轮 model compress + 多 epoch、strong bypass cooldown/credit、effective estimate 兜底等）
- 云端：GitHub Actions（`.github/workflows/build.yml`）push 自动 typecheck+test+build+package，已实测通过
- 实机安装：`debug_install_toolpkg` 成功；估算/发送双链路日志正常，右上角计数随压缩回落，模型主动压缩已实测生效（`source=model`）

## 引用项目

- **[acp-kernel](https://github.com/ranxianglei/acp-kernel)**（MIT）— 压缩内核（billion-context 同源），本插件的唯一运行时依赖。
- **[billion-context-operit](https://github.com/lxyhyh/billion-context-operit)** — 在 Operit 中安装与管理 billion-context Proxy 的 ToolPkg（同作者姊妹项目）。
- **Operit** — Android AI Agent 宿主，提供 ToolPkg / hook / UI / IPC 扩展机制。

## 致谢

- 感谢 [ranxianglei](https://github.com/ranxianglei) 的 acp-kernel / billion-context，本插件的压缩内核完全来自该开源实现。
- 感谢 Operit 的 ToolPkg hook 架构（PromptFinalizeHook / PromptEstimateHook 等）为宿主内压缩提供了可能。

## License

[MIT](./LICENSE)
