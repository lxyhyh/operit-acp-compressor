/**
 * ACP 上下文压缩 设置页（Compose DSL，CJS）。
 * 配置读写经 ToolPkg.ipc → main 上下文（acp.get_config / acp.set_config / acp.reset_config）。
 *
 * 注意：UI 模块运行在独立 JS engine，通过 ToolPkg.ipc.call 与 main 上下文通信。
 * 组件 props 参考官方示例（md_reader / plan-execution）。
 */

"use strict";
// 若宿主以裸脚本执行（无 exports/module），垫一个对象避免 ReferenceError
const _exports = typeof exports !== "undefined" ? exports : {};
const _module = typeof module !== "undefined" ? module : { exports: _exports };
Object.defineProperty(_exports, "__esModule", { value: true });

const DEFAULT = {
    enabled: true,
    nudgeThresholdPct: 0.72,
    strongThresholdPct: 0.82,
    hardLimitPct: 0.85,
    contextLimit: 200000,
    preserveRecentMessages: 5,
    minCompressRangeChars: 5000,
    reasoningEffort: "",
};

function Screen(ctx) {
    const UI = ctx.UI;
    const [cfg, setCfg] = ctx.useState("acp_cfg", DEFAULT);
    const [loading, setLoading] = ctx.useState("acp_loading", true);
    const [saved, setSaved] = ctx.useState("acp_saved", false);
    const [error, setError] = ctx.useState("acp_error", "");
    const [hasInitialized, setHasInitialized] = ctx.useState("acp_has_init", false);
    const [stats, setStats] = ctx.useState("acp_stats", null);

    // 读配置：渲染期不发起异步；onLoad 内首次加载
    async function load() {
        try {
            setLoading(true);
            const res = await ToolPkg.ipc.call("acp.get_config");
            if (res && typeof res === "object") {
                setCfg(Object.assign({}, DEFAULT, res));
            }
            // V0.5：读运行状态（blocks/stats/metrics）
            try {
                const s = await ToolPkg.ipc.call("acp.get_stats");
                if (s && s.ok && s.stats) setStats(s);
            } catch (e2) { /* 统计读取失败不阻塞配置 */ }
            setError("");
        } catch (e) {
            setError(String(e && e.message ? e.message : e));
        } finally {
            setLoading(false);
        }
    }

    // 保存：返回 Promise 让宿主保持 action 窗口；成功后反馈，失败保留错误
    async function persist() {
        try {
            setSaved(false);
            setError("");
            const res = await ToolPkg.ipc.call("acp.set_config", cfg);
            if (res && res.ok === true) {
                setSaved(true);
            } else {
                setError("保存未确认，请重试");
            }
        } catch (e) {
            setError(String(e && e.message ? e.message : e));
        }
        return true;
    }

    async function resetAll() {
        try {
            setError("");
            const res = await ToolPkg.ipc.call("acp.reset_config");
            if (res && res.config) setCfg(Object.assign({}, DEFAULT, res.config));
            setSaved(true);
        } catch (e) {
            setError(String(e && e.message ? e.message : e));
        }
        return true;
    }

    function set(key, value) {
        const next = Object.assign({}, cfg, { [key]: value });
        setCfg(next);
        setSaved(false);
    }

    function numField(text, min, max, key) {
        const n = Number(String(text).replace(/[^0-9]/g, ""));
        if (Number.isFinite(n) && n >= min && n <= max) set(key, n);
    }

    const children = [];
    if (loading) {
        children.push(
            UI.Row({ verticalAlignment: "center", padding: 16 }, [
                UI.CircularProgressIndicator({ strokeWidth: 2 }),
                UI.Spacer({ width: 8 }),
                UI.Text({ text: "读取配置…" }),
            ])
        );
    }
    if (error) {
        children.push(UI.Text({ text: "错误: " + error, color: ctx.MaterialTheme.colorScheme.error, fontSize: 12 }));
    }

    children.push(
        UI.Card({ fillMaxWidth: true, containerColor: "secondaryContainer" }, [
            UI.Row({ padding: 12, verticalAlignment: "center" }, [
                UI.Icon({ name: "compress", tint: "onSecondaryContainer", size: 20 }),
                UI.Spacer({ width: 8 }),
                UI.Text({ text: "ACP 上下文压缩", style: "titleMedium", fontWeight: "bold" }),
            ]),
            UI.Text({
                text: "渐进式压缩：模型在任务中调用 compress 折叠历史，不中断对话、可逆恢复。建议在 Operit 设置中关闭“按消息条数触发总结”，把上下文管理交给本插件。",
                style: "bodySmall",
                color: "onSecondaryContainer",
                fontSize: 12,
                padding: 12,
            }),
        ])
    );

    // V0.5 运行状态卡（blocks/压缩量/主动率/最近事件）
    if (stats && stats.stats) {
        const st = stats.stats || {};
        const totalFolds = (st.compressSucceeded || 0) + (st.emergencyTriggered || 0);
        const proactivePct = totalFolds > 0 ? Math.round(((st.compressSucceeded || 0) / totalFolds) * 100) : 0;
        const convPct = (st.nudgeIssued || 0) > 0 ? Math.round(((st.compressCalled || 0) / (st.nudgeIssued || 0)) * 100) : 0;
        const epoch = stats.acpNudge && stats.acpNudge.acpEpoch ? stats.acpNudge.acpEpoch : null;
        const updated = stats.updatedAt ? new Date(stats.updatedAt).toLocaleTimeString() : "";
        children.push(
            UI.Card({ fillMaxWidth: true, containerColor: "surfaceVariant" }, [
                UI.Column({ padding: 12, spacing: 4 }, [
                    UI.Text({ text: "运行状态" + (updated ? " · " + updated : ""), style: "bodySmall", color: "onSurfaceVariant", fontSize: 11 }),
                    UI.Text({ text: "压缩块: " + (stats.blocks ?? 0) + " 个 · 累计压缩 " + Number(stats.tokensCompressed || 0).toLocaleString() + " tokens", style: "bodySmall", fontSize: 12 }),
                    UI.Text({ text: "模型主动压缩: " + (st.compressSucceeded || 0) + " 次 (" + proactivePct + "%) · 紧急兜底: " + (st.emergencyTriggered || 0) + " 次", style: "bodySmall", fontSize: 12 }),
                    UI.Text({ text: "nudge 已发: " + (st.nudgeIssued || 0) + " (gentle " + (st.gentleNudges || 0) + "/strong " + (st.strongNudges || 0) + "/emergency " + (st.emergencyNudges || 0) + ") · 转化率 " + convPct + "%", style: "bodySmall", fontSize: 12 }),
                    epoch ? UI.Text({ text: "pressure epoch #" + (epoch.epoch || 0) + " · 注入 " + (epoch.injections || 0) + " 次 · 档位 " + (epoch.maxLevel || "none") + (epoch.closed ? " (closed)" : ""), style: "bodySmall", fontSize: 12 }) : null,
                ]),
            ])
        );
    }

    // 启用开关
    children.push(
        UI.Card({ fillMaxWidth: true }, [
            UI.Row({ padding: 12, verticalAlignment: "center" }, [
                UI.Column({ weight: 1 }, [
                    UI.Text({ text: "启用压缩", style: "bodyMedium", fontWeight: "bold" }),
                    UI.Text({ text: "总开关；关闭后不折叠、不直连", style: "bodySmall", color: "onSurfaceVariant", fontSize: 11 }),
                ]),
                UI.Switch({ checked: cfg.enabled, onCheckedChange: (v) => set("enabled", !!v) }),
            ]),
        ])
    );

    // 上下文上限
    children.push(
        UI.Card({ fillMaxWidth: true }, [
            UI.Column({ padding: 12, spacing: 4 }, [
                UI.Text({ text: "上下文上限：" + Number(cfg.contextLimit || 0).toLocaleString() + " tokens", style: "bodyMedium" }),
                UI.Text({ text: "建议与 Operit 模型配置的 contextLength 对齐", style: "bodySmall", color: "onSurfaceVariant", fontSize: 11 }),
                UI.TextField({
                    value: String(cfg.contextLimit || ""),
                    onValueChange: (v) => numField(v, 1000, 2000000, "contextLimit"),
                    label: "contextLimit",
                    singleLine: true,
                    style: { fontSize: 13 },
                }),
            ]),
        ])
    );

    // nudge 三档阈值（温和/强制/硬限）
    children.push(
        UI.Card({ fillMaxWidth: true }, [
            UI.Column({ padding: 12, spacing: 6 }, [
                UI.Text({ text: "上下文窗口占比阈值（渐进式提醒，V0.4）", style: "bodySmall", color: "onSurfaceVariant", fontSize: 11 }),
                UI.Row({ verticalAlignment: "center" }, [
                    UI.Text({ text: "温和提示 (%)", style: "bodySmall", fontSize: 12 }),
                    UI.Spacer({ width: 8 }),
                    UI.TextField({
                        value: String(Math.round((cfg.nudgeThresholdPct || 0.72) * 100)),
                        onValueChange: (v) => {
                            const n = Number(String(v).replace(/[^0-9]/g, ""));
                            if (Number.isFinite(n) && n >= 1 && n <= 100) set("nudgeThresholdPct", n / 100);
                        },
                        label: "%",
                        singleLine: true,
                        style: { fontSize: 13 },
                    }),
                ]),
                UI.Text({ text: "温和区：提示准备压缩（gentle）", style: "bodySmall", color: "onSurfaceVariant", fontSize: 11 }),
                UI.Row({ verticalAlignment: "center" }, [
                    UI.Text({ text: "强制建议 (%)", style: "bodySmall", fontSize: 12 }),
                    UI.Spacer({ width: 8 }),
                    UI.TextField({
                        value: String(Math.round((cfg.strongThresholdPct || 0.82) * 100)),
                        onValueChange: (v) => {
                            const n = Number(String(v).replace(/[^0-9]/g, ""));
                            if (Number.isFinite(n) && n >= 1 && n <= 100) set("strongThresholdPct", n / 100);
                        },
                        label: "%",
                        singleLine: true,
                        style: { fontSize: 13 },
                    }),
                ]),
                UI.Text({ text: "强制区：要求主动 compress（strong）", style: "bodySmall", color: "onSurfaceVariant", fontSize: 11 }),
                UI.Row({ verticalAlignment: "center" }, [
                    UI.Text({ text: "硬限阈值 (%)", style: "bodySmall", fontSize: 12 }),
                    UI.Spacer({ width: 8 }),
                    UI.TextField({
                        value: String(Math.round((cfg.hardLimitPct || 0.85) * 100)),
                        onValueChange: (v) => {
                            const n = Number(String(v).replace(/[^0-9]/g, ""));
                            if (Number.isFinite(n) && n >= 1 && n <= 100) set("hardLimitPct", n / 100);
                        },
                        label: "%",
                        singleLine: true,
                        style: { fontSize: 13 },
                    }),
                ]),
                UI.Text({ text: "硬限：超限插件自动兜底折叠（emergency）", style: "bodySmall", color: "onSurfaceVariant", fontSize: 11 }),
            ]),
        ])
    );

    // 保护消息数 + 最小压缩字符数
    children.push(
        UI.Card({ fillMaxWidth: true }, [
            UI.Column({ padding: 12, spacing: 6 }, [
                UI.Row({ verticalAlignment: "center" }, [
                    UI.Text({ text: "保护最近消息数", style: "bodyMedium" }),
                    UI.Spacer({ width: 8 }),
                    UI.TextField({
                        value: String(cfg.preserveRecentMessages ?? ""),
                        onValueChange: (v) => numField(v, 0, 50, "preserveRecentMessages"),
                        label: "条",
                        singleLine: true,
                        style: { fontSize: 13 },
                    }),
                ]),
                UI.Row({ verticalAlignment: "center" }, [
                    UI.Text({ text: "最小压缩字符数", style: "bodyMedium" }),
                    UI.Spacer({ width: 8 }),
                    UI.TextField({
                        value: String(cfg.minCompressRangeChars ?? ""),
                        onValueChange: (v) => numField(v, 500, 200000, "minCompressRangeChars"),
                        label: "字符",
                        singleLine: true,
                        style: { fontSize: 13 },
                    }),
                ]),
            ]),
        ])
    );

    // 保存/重置按钮
    children.push(
        UI.Row({ horizontalArrangement: "End", spacing: 8, padding: 4 }, [
            UI.Button({ text: "重置默认", enabled: !loading, onClick: () => resetAll() }),
            UI.Button({
                text: saved ? "已保存 ✓" : "保存配置",
                enabled: !loading,
                onClick: () => persist(),
            }),
        ])
    );

    return UI.LazyColumn(
        {
            fillMaxSize: true,
            padding: 12,
            spacing: 8,
            // onLoad 返回 Promise：让加载进入 action 窗口（否则 await 后 setState 不触发重绘）
            onLoad: async () => {
                if (hasInitialized) return;
                setHasInitialized(true);
                await load();
            },
        },
        children
    );
}

// 兼容宿主加载形态：CJS 下 require() 直接得到 Screen 函数本体；
// 若宿主取 .default 也能拿到（与 message_insert 的 exports.default 语义一致）
_exports.default = Screen;
_module.exports = _exports;
_module.exports.default = Screen;