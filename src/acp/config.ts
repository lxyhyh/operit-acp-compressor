/**
 * acp/config.ts — Adapter 设置 → acp-kernel Config 映射。
 *
 * 配置单一来源：既有 acp-config.json（工具箱设置页经 IPC 读写）。
 * 键名沿用旧版（enabled / contextLimit / preserveRecentMessages /
 * minCompressRangeChars / hardLimitPct / nudgeThresholdPct），
 * 保证用户已保存的设置直接生效、UI 无需改键。
 */

import { defaultConfig } from "acp-kernel";
import type { Config } from "acp-kernel";
import { DATA_DIR, SETTINGS_FILE as SETTINGS_FILE_PATH } from "./paths";

export interface AdapterSettings {
  /** 是否启用 ACP projection。默认 true。 */
  enabled: boolean;
  /** 模型上下文窗口（token）。默认 200000。 */
  modelContextLimit: number;
  /** 保护最近 N 条消息不压缩。默认 5。 */
  preserveRecentMessages: number;
  /** 保护最近 N token 不压缩。默认 5000。 */
  preserveRecentTokens: number;
  /** 受保护工具（tool-call + tool-result 成对保护，不压缩）。 */
  protectedTools: string[];
  /** renderTags: none | text-only | all。默认 none（不污染 tool-call 参数 / 结构化内容）。 */
  renderTags: "none" | "text-only" | "all";
  /** 是否把 nudge 注入到 projection（作为 system 消息追加）。默认 true。 */
  nudgeEnabled: boolean;
  /** 触发 nudge 建议的上下文使用率阈值（0~1）。默认 0.75。 */
  nudgeThresholdPct: number;
  /** hard/maxContextLimit 阈值（0~1）：usage ≥ 此值发 forced nudge（绕过 growth/cadence/credit，但绝不自动压缩历史）。默认 0.85。 */
  hardLimitPct: number;
  /** 单次压缩的最小字符数门槛。默认 5000。 */
  minCompressRange: number;
  /** 压缩后是否隐藏已消耗的 compress 工具调用。默认 true。 */
  hideConsumedCompressCalls: boolean;
  /** nudge 冷却（轮数）。默认 3。 */
  nudgeCooldownTurns: number;
  /** nudge 冷却（token）。默认 20000。 */
  nudgeCooldownTokens: number;
  /** nudge 触发的最小上下文增长量（token）。默认 10000。 */
  nudgeGrowthFloor: number;
  /** nudge 触发的最小增长下限（token）。默认 5000。 */
  nudgeMinGrowthFloor: number;
  /** 温和提示阈值（0~1，usage ≥ 此值发 gentle nudge）。默认 0.72。 */
  gentleThresholdPct: number;
  /** 强制建议阈值（0~1，usage ≥ 此值发 strong nudge）。默认 0.82。 */
  strongThresholdPct: number;
  /** V0.7 host 自接管下限（0~1，约 0.70）：kernel 沉默但 usage ≥ 此值且增长明显时，
   *  Adapter 自行发 gentle/strong，防 kernel 阈值未触发而 context 危险增长。 */
  hostEscalationFloor: number;
  /** V0.4.1 usage credit：压缩后此 token 数内免除 nudge。默认 contextLimit*0.15。 */
  usageCreditTokens: number;
  /** V0.6 Phase7 增量投影：本次仅比上次多 ≤ 此条数时走增量快速路径（跳过全量 processTurn）。 */
  incrementalMaxNewTurns: number;
  /** 数据目录。 */
  dataDir: string;
  /** V0.7.13-HOOK-EXP：最小实验开关——旁路压缩直接返回最后 6 条。默认 false。 */
  hookExperiment: boolean;
}

/** acp-config.json 键名（单一事实来源；与 src/config.ts DEFAULT_CONFIG 对齐）。 */
const KEYS = {
  enabled: "enabled",
  modelContextLimit: "contextLimit",
  preserveRecentMessages: "preserveRecentMessages",
  minCompressRange: "minCompressRangeChars",
  hardLimitPct: "hardLimitPct",
  nudgeThresholdPct: "nudgeThresholdPct",
} as const;

const SETTINGS_FILE = SETTINGS_FILE_PATH;

/** 读 settings JSON（带内容缓存：文件未变则跳过 JSON.parse；跨调用共享）。
 *  V0.7.13-CONFIG-FIX：hook-exp-probe 实锤——sandbox 里 Tools.Files.read 读
 *  /sdcard 路径曾失败/返回空（readBool 全部回退默认值，配置改动"不生效"）。
 *  加两级兜底：1) Tools.Files.read 失败 → 直接 java.io.File 读取；
 *  2) 首次失败/成功状态写一次性诊断日志，便于后续排查。 */
const SETTINGS_DIAG_KEY = "__acp_settings_diag_logged";
/** 带内容缓存键（文件未变则跳过 JSON.parse）。 */
const SETTINGS_CACHE_KEY = "__acp_settings_cache_v2";
type JavaCls<T> = { new (...args: unknown[]): T } | undefined;
function javaUse<T>(name: string): JavaCls<T> {
  const J = (globalThis as Record<string, unknown>).Java as
    | { use?: (n: string) => unknown }
    | undefined;
  try {
    return (J?.use?.(name) ?? undefined) as JavaCls<T>;
  } catch {
    return undefined;
  }
}
function readJsonSettings(): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>;
  let content: string | undefined;
  let readPath = "Tools.Files.read";
  try {
    const fs = Tools.Files;
    const res = fs.read(SETTINGS_FILE) as unknown as { content?: string } | undefined;
    content = (res && res.content) as string | undefined;
  } catch { content = undefined; }
  if (!content) {
    // 兜底 1：直接 java.io.File（sandbox java bridge 对 /sdcard 直接读通常可行）。
    try {
      const File = javaUse<{ exists(): boolean; canRead(): boolean; length(): number }>("java.io.File");
      const Scanner = javaUse<{ useDelimiter(d: string): unknown; hasNext(): boolean; next(): string; close(): void }>("java.util.Scanner");
      if (File && Scanner) {
        const f = new File(SETTINGS_FILE);
        if (f.exists() && f.canRead() && f.length() > 0) {
          const sc = new Scanner(f);
          sc.useDelimiter("\\A");
          if (sc.hasNext()) {
            content = sc.next();
            readPath = "java.io.File";
          }
          sc.close();
        }
      }
    } catch { /* 兜底失败，保持 content=undefined */ }
  }
  try {
    if (!g[SETTINGS_DIAG_KEY]) {
      g[SETTINGS_DIAG_KEY] = true;
      const dir = "/sdcard/Download/Operit/plugins/com.operit.acp_compressor/logs";
      const line = `[settings-diag] path=${SETTINGS_FILE} read=${readPath} ok=${content ? 1 : 0} len=${content?.length ?? 0}\n`;
      try {
        const F = javaUse<{ exists(): boolean; mkdirs(): boolean }>("java.io.File");
        const FW = javaUse<{ write(s: string): void; close(): void }>("java.io.FileWriter");
        if (F && FW) {
          const d = new F(dir);
          if (!d.exists()) d.mkdirs();
          const w = new FW(new F(`${dir}/tools_visibility.log`), true);
          w.write(line);
          w.close();
        }
      } catch { /* 诊断失败不影响主流程 */ }
    }
  } catch { /* ignore */ }
  if (!content) return {};
  const cached = g[SETTINGS_CACHE_KEY] as { raw: string; data: Record<string, unknown> } | undefined;
  if (cached && cached.raw === content) return cached.data;
  try {
    const parsed = JSON.parse(content);
    const data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    g[SETTINGS_CACHE_KEY] = { raw: content, data };
    return data;
  } catch {
    return {};
  }
}

function readEnv(key: string): string {
  const json = readJsonSettings();
  const v = json[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function readBool(key: string, dflt: boolean): boolean {
  const raw = readEnv(key).toLowerCase();
  if (!raw) return dflt;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function readNum(key: string, dflt: number): number {
  const raw = readEnv(key);
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** 读取 0~1 比例（>1 视为百分数折算）。非法回退默认。 */
function readPct(key: string, dflt: number): number {
  const raw = readEnv(key);
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return n > 1 ? n / 100 : n;
}

function readList(key: string, dflt: string[]): string[] {
  const raw = readEnv(key);
  if (!raw) return dflt;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function loadAdapterSettings(): AdapterSettings {
  const modelContextLimit = readNum(KEYS.modelContextLimit, 200_000);
  return {
    enabled: readBool(KEYS.enabled, true),
    modelContextLimit,
    preserveRecentMessages: readNum(KEYS.preserveRecentMessages, 5),
    preserveRecentTokens: 5_000,
    protectedTools: readList("protectedTools", []),
    renderTags: "none",
    nudgeEnabled: true,
    nudgeThresholdPct: readPct(KEYS.nudgeThresholdPct, 0.75),
    hardLimitPct: readPct(KEYS.hardLimitPct, 0.85),
    minCompressRange: readNum(KEYS.minCompressRange, 5_000),
    hideConsumedCompressCalls: true,
    nudgeCooldownTurns: 3,
    nudgeCooldownTokens: 20_000,
    nudgeGrowthFloor: 10_000,
    nudgeMinGrowthFloor: 5_000,
    // V0.4 三档：温和提示沿用旧键 nudgeThresholdPct（兼容已存设置），强制/硬限新增键。
    gentleThresholdPct: readPct("nudgeThresholdPct", 0.72),
    strongThresholdPct: readPct("strongThresholdPct", 0.82),
    // V0.7 host 自接管下限：约 0.70（低于 gentle 0.72，允许 Adapter 在 kernel 沉默区先接管）。
    hostEscalationFloor: readPct("hostEscalationFloor", 0.70),
    // V0.4.1 usage credit：压缩后 contextLimit*15% token 内免除 nudge。
    usageCreditTokens: Math.round(modelContextLimit * 0.15),
    // V0.6 Phase7 增量投影阈值（默认允许新增 8 条内走增量）。
    incrementalMaxNewTurns: readNum("incrementalMaxNewTurns", 8),
    // V0.7.13-HOOK-EXP：实验开关（实验已完成；保留开关但恢复文件读取）。
    hookExperiment: readBool("hookExperiment", false),
    dataDir: DATA_DIR,
  };
}

/** 将 Adapter 设置映射为 acp-kernel Config（每次请求前调用）。 */
export function resolveKernelConfig(settings: AdapterSettings): Config {
  // 0.0.54 defaultConfig 的 overrides 为 Partial<Config>，但嵌套子对象要求
  // 完整字段（TS 严格校验）；先取全量默认再逐项覆盖，避免漏字段。
  const cfg = defaultConfig(settings.modelContextLimit);
  return {
    ...cfg,
    preserveRecentMessages: settings.preserveRecentMessages,
    preserveRecentTokens: settings.preserveRecentTokens,
    protectedTools: settings.protectedTools,
    nudge: {
      ...cfg.nudge,
      // 主动压缩窗口拉长：min 为温和区起点（usage 进入即 soft nudge），
      // max 为强制区起点（strong nudge），emergency 为紧急兜底（宿主兜底折叠）。
      // 三档递进：gentle → strong → emergency auto-fold。
      minContextLimitPct: settings.gentleThresholdPct,
      maxContextLimitPct: settings.strongThresholdPct,
      emergencyThresholdPct: settings.hardLimitPct,
      force: "soft",
      growthFloor: settings.nudgeGrowthFloor,
      minGrowthFloor: settings.nudgeMinGrowthFloor,
    },
    compress: {
      ...cfg.compress,
      minCompressRange: settings.minCompressRange,
    },
  };
}
