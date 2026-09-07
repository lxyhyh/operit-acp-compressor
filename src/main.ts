/**
 * ToolPkg 主入口：注册 hooks + UI + IPC（宿主 hook 投影架构，0.3.0）。
 *
 * 架构（方向 1，对齐 billion-context）：
 * - 不再注册 AiProvider / 直连上游（退役 provider/upstream/compress-loop 直连路径）。
 * - 注册 PromptFinalizeHook：发送前把历史投影为压缩视图（preparedHistory 整体替换）。
 * - 注册 ToolPromptComposeHook：把 compress/decompress/search_context/acp_status
 *   无条件注入模型可用工具（子包 acp_tools 的 METADATA 声明，模型侧调用走宿主工具通道）。
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

import { onFinalize, onEstimateFinalize, onEstimateHistory, onSystemPromptCompose, onToolPromptCompose } from "./acp/lifecycle";
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
    try {
        ToolPkg.registerSystemPromptComposeHook({
            id: "acp.system_prompt",
            function: onSystemPromptCompose as never,
        });
    } catch (e) {
        try { console.log(`[acp] registerSystemPromptComposeHook error: ${String(e)}`); } catch { /* noop */ }
    }
    try {
        ToolPkg.registerToolPromptComposeHook({
            id: "acp.tools",
            function: onToolPromptCompose as never,
        });
    } catch (e) {
        try { console.log(`[acp] registerToolPromptComposeHook error: ${String(e)}`); } catch { /* noop */ }
    }
}

// 宿主要求注册的 handler 函数本身也是「模块导出」。
export { onFinalize, onEstimateFinalize, onEstimateHistory, onSystemPromptCompose, onToolPromptCompose };

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