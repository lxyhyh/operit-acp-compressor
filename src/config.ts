/**
 * 插件配置：读写 acp-config.json（插件目录）。
 * UI（compose_dsl）通过 ToolPkg.ipc 调 main 上下文注册的 handler 访问。
 */

import { resolveConfigDir } from "./acp/paths";

export interface AcpConfig {
    enabled: boolean;
    nudgeThresholdPct: number;      // 0~1，温和提示阈值（gentle）
    strongThresholdPct: number;     // 0~1，强制建议阈值（strong）
    hardLimitPct: number;           // 0~1，超过则插件主动折叠
    contextLimit: number;           // 与 Operit contextLength 对齐
    preserveRecentMessages: number; // 保护最近 N 条消息
    minCompressRangeChars: number;  // 单段可压缩最小字符数
}

export const DEFAULT_CONFIG: AcpConfig = {
    enabled: true,
    nudgeThresholdPct: 0.72,
    strongThresholdPct: 0.82,
    hardLimitPct: 0.85,
    contextLimit: 200_000,
    preserveRecentMessages: 5,
    minCompressRangeChars: 5000,
};

export function configPath(): string {
    const dir = resolveConfigDir();
    return dir ? `${dir}/acp-config.json` : "";
}

/** 读取配置（失败返回默认） */
export async function loadConfig(): Promise<AcpConfig> {
    const path = configPath();
    if (!path) return { ...DEFAULT_CONFIG };
    try {
        const res = await Tools.Files.read({ path, environment: "android" });
        const text = (res?.content as string) ?? "";
        if (!text) return { ...DEFAULT_CONFIG };
        const parsed = JSON.parse(text) as Partial<AcpConfig>;
        return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

/** 保存配置（失败静默） */
export async function saveConfig(cfg: AcpConfig): Promise<boolean> {
    const path = configPath();
    if (!path) return false;
    try {
        await Tools.Files.write(path, JSON.stringify(cfg, null, 2), false, "android");
        return true;
    } catch {
        return false;
    }
}

/** 以配置校准 fold 参数（contextLimit / preserveRecentMessages / minCompressRangeChars） */
export async function configOverrides(): Promise<{ modelContextLimit: number; preserveRecentMessages: number; enabled: boolean }> {
    const cfg = await loadConfig();
    return {
        modelContextLimit: cfg.contextLimit > 0 ? cfg.contextLimit : DEFAULT_CONFIG.contextLimit,
        preserveRecentMessages: cfg.preserveRecentMessages > 0 ? cfg.preserveRecentMessages : DEFAULT_CONFIG.preserveRecentMessages,
        enabled: cfg.enabled,
    };
}