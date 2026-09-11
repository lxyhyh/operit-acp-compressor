/**
 * ToolPkg 主入口：注册 hooks + UI + IPC（宿主 hook 投影架构，0.3.0）。
 *
 * 架构（方向 1，对齐 billion-context）：
 * - 不再注册 AiProvider / 直连上游（退役 provider/upstream/compress-loop 直连路径）。
 * - 注册 PromptFinalizeHook：发送前把历史投影为压缩视图（preparedHistory 整体替换）。
 * - ACP 工具不再注入 availableTools：V0.7.13-P2 改为走 Operit 原生
 *   package_proxy(tool_name="acp_tools:xxx") 契约（见 docs/v0.7.13-p1-toolprompt-contract.md）。
 * - 注册 SystemPromptComposeHook：after 阶段幂等追加 ACP 系统提示（引导模型主动压缩）。
 * - 注册 PromptEstimateFinalizeHook / PromptEstimateHistoryHook：估算链路只读投影，
 *   使宿主"右上角上下文计数 / summary 阈值判断"基于压缩后视图（与真实发送一致）。
 *
 * 速查文档铁律：
 * - registerToolPkg 与所有 handler 必须从模块导出（带 __operit_toolpkg_module_path 标记）。
 * - 本文件由 esbuild 打包为单文件 iife（globalThis.registerToolPkg = ...）。
 */

import { installIntlSegmenter } from "./shims/segmenter-shim";

// 模块加载最先安装 Intl shim（acp-kernel 顶层会 new Intl.Segmenter）。
installIntlSegmenter();

import { onFinalize, onEstimateFinalize, onEstimateHistory, onSystemPromptCompose, onToolLifecycle } from "./acp/lifecycle";
import { onChatRuntimeEvent } from "./acp/task-end-hook";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type AcpConfig } from "./config";

// IPC 通道必须在 main 脚本【模块顶层】注册（guide 3.2.5 示例），
// registerToolPkg() 执行期注册会错过窗口 → UI 调用报 channel is not registered。
// ToolPkg 未就绪时延后到 registerToolPkg 首行补注册（双保险）。
let ipcRegistered = false;
function ensureIpcRegistered(): void {
    if (ipcRegistered) return;
    ipcRegistered = true;
    registerIpc();
}
if (typeof ToolPkg !== "undefined" && ToolPkg && typeof (ToolPkg as { ipc?: unknown }).ipc !== "undefined") {
    ensureIpcRegistered();
}

export function registerToolPkg(): boolean {
    ensureIpcRegistered();
    registerToolboxUi();
    registerAcpHooks();
    return true;
}

/** 注册配置读写 IPC（UI 设置页经 ToolPkg.ipc 调用，跨 engine 共享配置） */
export function registerIpc(): void {
    try {
        ToolPkg.ipc.on("acp.get_config", async () => {
            const cfg = await loadConfig();
            return cfg;
        });
        ToolPkg.ipc.on("acp.set_config", async (payload: Partial<AcpConfig>) => {
            const cur = await loadConfig();
            const next = { ...cur, ...(payload ?? {}) };
            const ok = await saveConfig(next);
            return { ok, config: next };
        });
        ToolPkg.ipc.on("acp.reset_config", async () => {
            const ok = await saveConfig({ ...DEFAULT_CONFIG });
            return { ok, config: DEFAULT_CONFIG };
        });
        ToolPkg.ipc.on("acp.get_stats", async () => {
            // V0.5：读最近会话状态文件的 runtimeStats/metrics（UI 状态卡）。
            try {
                const dir = "/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state";
                const res = await Tools.Files.list(dir);
                const files = (Array.isArray(res) ? res : []).map((f) => typeof f === "string" ? f : String((f as { name?: string }).name ?? "")).filter((f) => f.includes("_b") && f.endsWith(".json") && !f.includes("raw"));
                // 逐个读 hostMetadata.lastUpdatedAt，取最新（不依赖 stat API）
                let latest = "";
                let latestTs = 0;
                for (const f of files) {
                    try {
                        const contentRes = await Tools.Files.read(`${dir}/${f}`);
                        const content = (contentRes && contentRes.content) as string | undefined;
                        if (!content) continue;
                        const parsed = JSON.parse(content);
                        const ts = typeof parsed?.hostMetadata?.lastUpdatedAt === "number" ? parsed.hostMetadata.lastUpdatedAt : 0;
                        if (ts > latestTs) { latestTs = ts; latest = f; }
                    } catch { /* 单个失败跳过 */ }
                }
                if (!latest) return { ok: true, stats: null };
                const contentRes = await Tools.Files.read(`${dir}/${latest}`);
                const content = (contentRes && contentRes.content) as string | undefined;
                if (!content) return { ok: true, stats: null };
                const parsed = JSON.parse(content);
                const hm = parsed?.hostMetadata ?? {};
                const stats = hm.runtimeStats ?? null;
                const acpNudge = hm.acpNudge ?? null;
                const k = parsed?.kernelState ?? {};
                return {
                    ok: true,
                    stats,
                    acpNudge,
                    blocks: Array.isArray(k.blocks) ? k.blocks.length : 0,
                    tokensCompressed: k.stats?.tokensCompressed ?? 0,
                    chatFile: latest.replace(/^state_/, "").replace(/\.json$/, ""),
                    updatedAt: hm.lastUpdatedAt ?? 0,
                };
            } catch (e) {
                return { ok: false, error: String(e && (e as Error).message ? (e as Error).message : e) };
            }
        });
    } catch (e) {
        try { console.log(`[acp] registerIpc error: ${String(e)}`); } catch { /* noop */ }
    }
}

/** 注册三类宿主 hook（finalize / tool-compose / system-prompt）。 */
export function registerAcpHooks(): void {
    if (typeof ToolPkg === "undefined") return;
    try {
        ToolPkg.registerPromptFinalizeHook({
            id: "acp.projection.send",
            function: onFinalize as never,
        });
    } catch (e) {
        try { console.log(`[acp] registerPromptFinalizeHook error: ${String(e)}`); } catch { /* noop */ }
    }
    try {
        // 估算链路（右上角计数/阈值判断）：与发送链路同款只读投影。
        // 注册估算 finalize + 估算 history 两条（宿主按需调用，处理函数幂等只读）。
        ToolPkg.registerPromptEstimateFinalizeHook({
            id: "acp.estimate_finalize",
            function: onEstimateFinalize as never,
        });
    } catch (e) {
        try { console.log(`[acp] registerPromptEstimateFinalizeHook error: ${String(e)}`); } catch { /* noop */ }
    }
    try {
        ToolPkg.registerPromptEstimateHistoryHook({
            id: "acp.estimate_history",
            function: onEstimateHistory as never,
        });
    } catch (e) {
        try { console.log(`[acp] registerPromptEstimateHistoryHook error: ${String(e)}`); } catch { /* noop */ }
    }
    // ToolLifecycleHook 已移除：宿主不支持（实测 IllegalStateException 崩溃）。
    // onToolLifecycle 处理函数保留导出（无害），但不注册。
    try {
        ToolPkg.registerSystemPromptComposeHook({
            id: "acp.system_prompt",
            function: onSystemPromptCompose as never,
        });
    } catch (e) {
        try { console.log(`[acp] registerSystemPromptComposeHook error: ${String(e)}`); } catch { /* noop */ }
    }
    // —— V0.8-P7：任务结束信号 hook（state_changed, state=completed）。
    //   宿主在整轮流式响应+工具循环+消息落库后经 dispatchAsync（独立协程）派发，
    //   不阻塞主链、不打断任何 LLM stream。completed 时刻仅评估压力并置 pending，
    //   绝不 dispatch 新请求、不生成摘要（docs/p7-audit.md 阶段3 方案B）。
    try {
        if (typeof (ToolPkg as unknown as Record<string, unknown>).registerChatRuntimeHook === "function") {
            (ToolPkg as never as { registerChatRuntimeHook: (d: unknown) => void }).registerChatRuntimeHook({
                id: "acp.task_end_fold",
                function: onChatRuntimeEvent as never,
            });
            try { console.log("[acp] registerChatRuntimeHook OK: acp.task_end_fold"); } catch { /* noop */ }
        } else {
            try { console.log("[acp] registerChatRuntimeHook unavailable（宿主 API < 1.0.1），P7 状态机待机"); } catch { /* noop */ }
        }
    } catch (e) {
        try { console.log(`[acp] registerChatRuntimeHook error: ${String(e)}`); } catch { /* noop */ }
    }
}

// 宿主要求注册的 handler 函数本身也是「模块导出」。
export { onFinalize, onEstimateFinalize, onEstimateHistory, onSystemPromptCompose, onToolLifecycle, onChatRuntimeEvent };

// UI 设置页：独立文件随包分发（dist/ui/settings/index.ui.js）。
export function registerToolboxUi(): void {
    let screen: unknown = undefined;
    try {
        // eslint-disable-next-line no-undef
        if (typeof require === "function") {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = require("./ui/settings/index.ui.js") as { default?: unknown };
            // 兼容两种导出形态：module.exports = Screen（本体）或 { default: Screen }
            const resolved = mod && typeof mod === "object" && "default" in mod
                ? (mod.default ?? undefined)
                : (mod as unknown);
            screen = (resolved && typeof resolved === "function") ? resolved : undefined;
            if (!screen) {
                try { console.log(`[acp] UI require 返回异常形态: ${typeof mod}`); } catch { /* noop */ }
            }
        } else {
            try { console.log("[acp] UI require 不可用（无 require 全局）"); } catch { /* noop */ }
        }
    } catch (e) {
        try { console.log(`[acp] UI require 失败: ${String(e)}`); } catch { /* noop */ }
    }
    if (!screen) {
        try { console.log("[acp] UI 未注册：screen 为空"); } catch { /* noop */ }
        return;
    }
    try {
        ToolPkg.registerToolboxUiModule({
            id: "acp_settings",
            runtime: "compose_dsl",
            screen: screen as never,
            title: { zh: "ACP 上下文压缩", en: "ACP Context Compressor" },
        });
        try { console.log("[acp] registerToolboxUiModule OK: acp_settings"); } catch { /* noop */ }
    } catch (e) {
        try { console.log(`[acp] registerToolboxUiModule error: ${String(e)}`); } catch { /* noop */ }
    }
}

declare function require(id: string): unknown;

export { installIntlSegmenter };