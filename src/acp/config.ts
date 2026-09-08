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

/** 读 settings JSON（带内容缓存：文件未变则跳过 JSON.parse；跨调用共享）。 */
const SETTINGS_CACHE_KEY = "__acp_settings_cache_v2";
function readJsonSettings(): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>;
  try {
    const fs = Tools.Files;
    const res = fs.read(SETTINGS_FILE) as unknown as { content?: string } | undefined;
    const content = (res && res.content) as string | undefined;
    if (!content) return {};
    const cached = g[SETTINGS_CACHE_KEY] as { raw: string; data: Record<string, unknown> } | undefined;
    if (cached && cached.raw === content) return cached.data;
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
