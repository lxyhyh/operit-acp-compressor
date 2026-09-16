/**
 * acp/adapter.ts — ACP 投影核心引擎（宿主 hook 架构）。
 *
 * 职责：
 * 1. 获取 Host context（PromptTurn[]）→ 转 CoreMessage[]。
 * 2. load CompressionState → 构造 kernel Config。
 * 3. 估算 sent-view token → 调 core.processTurn()。
 * 4. 用 result.messages 作为最终 projection（转回 PromptTurn[]）。
 * 5. 保存 result.state（幂等：同 fingerprint 只 mutation 一次）。
 *
 * 工具（compress/decompress/search_context/acp_status）由 subpackage
 * 调用本引擎的 applyCompression / deactivateBlock / search / status。
 * 幂等：同一 send 周期（before_finalize_prompt + before_send_to_model）
 * 同 fingerprint 时跳过 processTurn/save，直接返回缓存投影。
 */
import {
  createCore,
  deactivateBlock as kernelDeactivateBlock,
  searchBlocks as kernelSearchBlocks,
  blockDocs as kernelBlockDocs,
  applyAbsorb as kernelApplyAbsorb,
  defaultCountTokens,
  hideConsumedCompressCalls as kernelHideConsumedCompressCalls,
  activeBlockSpans as kernelActiveBlockSpans,
  formatCreatedBlocks as kernelFormatCreatedBlocks,
  collectBlockContent as kernelCollectBlockContent,
  viableRanges as kernelViableRanges,
} from "acp-kernel";
import type { CompressionCore, CompressionState, Config, CoreMessage } from "acp-kernel";
import { loadAdapterSettings, resolveKernelConfig, type AdapterSettings } from "./config";
import {
  promptTurnsToCoreMessages,
  coreMessagesToPromptTurns,
  hashString,
  capProjectionSize,
  stableKeyForTurn,
  type PromptTurnLike,
} from "./messages";
import {
  createIdentityBridgeState,
  identityForTurn,
  loadIdentityBridgeState,
  type IdentityBridgeState,
} from "../identity-bridge";
import { collectCoveredMessageIds, estimateProjectionTokens } from "./token";
import { createPersistence, stripOldAnchorMessages, EMPTY_RUNTIME_STATS, type Persistence, type OperitAcpSessionState, type AcpRuntimeStats } from "./persistence";
import { chatTrace } from "./trace";
import {
  detectAbsorbCandidates,
  upsertAbsorbCandidates,
  getActiveAbsorbCandidates,
  markAbsorbed,
  type AbsorbCandidate,
} from "./absorb-candidates";
import {
  evaluatePressure,
  detectTierOpportunity,
  type NudgeLevel as PressureNudgeLevel,
  type PressureEpoch,
  type PressureDecision,
} from "./pressure";
import { createUsageManager, type UsageManager, type UsageManagerState } from "./usage";
import type { TokenSnapshot } from "./token-source";
import { createOperitHostUsageAdapter, type HostUsageAdapter } from "./host-usage-adapter";
import { detectProtocol, normalizeUsage, type ProviderUsage } from "./token-source";
import type { FoldRange } from "./llm-fold";
import {
  buildNudgeCarrier,
  createNudgeDelivery,
  findNudgeTurn,
  markDelivered,
  markFinalCheck,
  type NudgeDelivery,
} from "./nudge-delivery";

// —— V0.7.1 HostUsageAdapter 单例（module 级、只读 DB、失败返回 undefined，绝不拖垮请求）。
let _hostUsageAdapter: HostUsageAdapter | undefined;
function getHostUsageAdapter(): HostUsageAdapter {
  if (!_hostUsageAdapter) {
    try {
      _hostUsageAdapter = createOperitHostUsageAdapter();
    } catch {
      _hostUsageAdapter = { async getCurrentContextTokens() { return undefined; } };
    }
  }
  return _hostUsageAdapter;
}

/** 投影缓存（globalThis 共享；compress 等 state mutation 后失效）。
 *  V0.4：send（project）与 estimate 分离——两者投影内容可能不同
 *  （send 可能带 nudge/autoFold 追加系统消息，estimate 恒只读纯投影），
 *  共用会互相污染命中（send 漏 nudge / estimate 拿到含 nudge 的发送视图）。 */
const projectionCache = (globalThis as Record<string, unknown>).__acpProjectionCacheV2 as
  | Map<string, { fingerprint: string; stateVersion: number; projection: PromptTurnLike[] }>
  | undefined ?? new Map<string, { fingerprint: string; stateVersion: number; projection: PromptTurnLike[] }>();
if (!(globalThis as Record<string, unknown>).__acpProjectionCacheV2) {
  (globalThis as Record<string, unknown>).__acpProjectionCacheV2 = projectionCache;
}

const estimateCache = (globalThis as Record<string, unknown>).__acpEstimateCacheV2 as
  | Map<string, { fingerprint: string; stateVersion: number; projection: PromptTurnLike[] }>
  | undefined ?? new Map<string, { fingerprint: string; stateVersion: number; projection: PromptTurnLike[] }>();
if (!(globalThis as Record<string, unknown>).__acpEstimateCacheV2) {
  (globalThis as Record<string, unknown>).__acpEstimateCacheV2 = estimateCache;
}

/** raw turns 内存缓存（compress/absorb 解析 refs 用；save 不落盘）。 */
const rawTurnsCache = (globalThis as Record<string, unknown>).__acpRawTurnsCacheV2 as
  | Map<string, PromptTurnLike[]>
  | undefined ?? new Map<string, PromptTurnLike[]>();
if (!(globalThis as Record<string, unknown>).__acpRawTurnsCacheV2) {
  (globalThis as Record<string, unknown>).__acpRawTurnsCacheV2 = rawTurnsCache;
}

/** 内存缓存最大 session 数（防长期运行内存累积）。 */
const MAX_CACHE_SESSIONS = 20;

function cacheSetLimited<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAX_CACHE_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** 噪音判定（与 preflight 方案 A 一致）：剔除插件引导/占位与记忆 JSON。 */
function isNoiseText(text: string): boolean {
  const t = (text ?? "").trimStart();
  if (!t) return false;
  if (t.startsWith("[ACP]") || t.startsWith("[ACP ") || t.startsWith("[Compressed conversation section]")) return true;
  if (t.startsWith('{"main"')) return true;
  return false;
}

/** 确定性抽取摘要（供 emergency 自动折叠；同段跨轮稳定）。 */
function buildDeterministicSummary(seg: CoreMessage[], maxLen = 6000, perMsg = 120): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = 0; i < seg.length; i++) {
    const m = seg[i];
    const text = (m.text ?? "").trim();
    if (!text || isNoiseText(text)) continue;
    const who = m.role === "assistant" ? "助手" : m.role === "user" ? "用户" : m.role ?? "消息";
    let excerpt = text.slice(0, perMsg);
    const cut = excerpt.search(/[。！？!?\n]/);
    if (cut > 10) excerpt = excerpt.slice(0, cut + 1);
    const line = `[${i + 1}] ${who}: ${excerpt}`;
    if (total + line.length > maxLen) break;
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

// —— V0.10-P1 预算守卫：FULL 投影已耗时过长（接近宿主 hook 预算 10s）时，
//   发送前不再建块重投影（整轮 mutation 有超时被宿主丢弃的风险），改为登记
//   后台 deferred fold（ChatRuntimeHook completed 时执行，下轮生效）。
/** 发送前自动折叠的时间预算（ms）：project() 已消耗超过此值时跳过 forced 折叠。 */
const PROJECT_FOLD_BUDGET_MS = 7000;
/** deferred fold 待办有效期（ms）：过期即作废（防旧待办作用于新 state）。 */
const DEFER_FOLD_TTL_MS = 5 * 60 * 1000;

// V0.10-B1-M 修复（H3）：deferred fold 自预算。completed 事件经宿主 dispatchAsync
// 独立协程派发（fire-and-forget），但插件 JS 仍跑在引擎单线程——大 session 的
// 全量 identityForTurn 哈希 + 全量 save 可达数秒，拖住引擎内排队的下轮 finalize
// 钩子（表现为回复前卡顿）。在 load / 哈希 / 折叠后检查耗时，超预算即放弃并清理
// 登记（本轮不做，下轮 forced 时会重新登记），把阻塞钉在有界 3s 内。
const DEFERRED_FOLD_BUDGET_MS = 3000;

/** deferred fold 待办（globalThis：跨 hook 调用共享，进程内生命周期）。 */
interface DeferredFoldEntry {
  sessionKey: string;
  blocksAtDefer: number;
  /** V0.10-B1-M 修复（M5）：登记时的 stateVersion，判定"state 已前进"更可靠
   *  （blocks.length 只数块数：期间压缩同数量块/解封块会漏判）。 */
  stateVersionAtDefer: number;
  level: string;
  at: number;
}
function deferredFoldStore(): Map<string, DeferredFoldEntry> {
  const g = globalThis as Record<string, unknown>;
  if (!g.__acpDeferredFold) g.__acpDeferredFold = new Map<string, DeferredFoldEntry>();
  return g.__acpDeferredFold as Map<string, DeferredFoldEntry>;
}

/**
 * 最旧未覆盖段确定性折叠（project() forced 段与后台 deferred fold 共用）。
 * 保护尾部最近 8 条；只折叠未被 block 覆盖的连续段；确定性摘要（同段跨轮稳定）。
 * 返回新 state 与折叠统计；无可用段/建块失败返回 undefined。
 */
function foldOldestUncoveredSegment(
  core: CompressionCore,
  state: CompressionState,
  messages: CoreMessage[],
  config: Config,
): { state: CompressionState; blocksCreated: number; tokensCompressed: number; segLen: number; startRef: string; endRef: string } | undefined {
  const PROTECTED = 8;
  if (messages.length <= PROTECTED) return undefined;
  const byRaw = state.messageRefs?.byRaw ?? {};
  const recentIds = new Set(messages.slice(-PROTECTED).map((m) => m.id));
  const covered = collectCoveredMessageIds(state);
  // 按 covered/recent 边界切连续未覆盖段（段内不夹已覆盖消息，避免 kernel
  // 以 overlap/consumed 拒绝整段）；从最旧开始取第一个长度 >= 8 的段。
  let segStart = -1;
  for (let i = 0; i < messages.length - PROTECTED; i++) {
    const m = messages[i];
    const isBlocked = covered.has(m.id) || recentIds.has(m.id);
    if (!isBlocked && segStart < 0) segStart = i;
    const segEndsHere = isBlocked || i === messages.length - PROTECTED - 1;
    if (segEndsHere && segStart >= 0) {
      const segEnd = isBlocked ? i - 1 : i;
      if (segEnd - segStart + 1 >= 8) {
        const seg = messages.slice(segStart, segEnd + 1);
        // kernel messageRefs.byRaw 键 = 消息 id、值 = ref（{id → ref}），正查。
        const startRef = byRaw[seg[0].id];
        const endRef = byRaw[seg[seg.length - 1].id];
        if (startRef && endRef) {
          const summary = buildDeterministicSummary(seg, 6000, 120);
          const topic = `自动折叠（emergency fold ${seg.length} 条）`;
          const applied = core.applyCompression({
            ranges: [{ startRef, endRef, summary, topic }],
            messages,
            state,
            config,
          });
          if (applied.result.blocksCreated === 0) return undefined;
          return {
            state: applied.state,
            blocksCreated: applied.result.blocksCreated,
            tokensCompressed: applied.result.tokensCompressed,
            segLen: seg.length,
            startRef,
            endRef,
          };
        }
      }
      segStart = -1;
    }
  }
  return undefined;
}

/** 反查：给定 messageRefs.byRef（ref→stableKey）与 byKey（key→turn），返回 ref 对应的 CoreMessage。 */
function messageForRef(
  messages: CoreMessage[],
  byRef: Record<string, string> | undefined,
  byKey: Map<string, PromptTurnLike>,
  ref: string,
): CoreMessage | undefined {
  // byRef: ref -> stableKey（消息 content hash）
  const key = byRef ? byRef[ref] : undefined;
  if (key && byKey.has(key)) {
    return messages.find((m) => m.id === key);
  }
  return undefined;
}

export interface ProjectionResult {
  preparedHistory: PromptTurnLike[];
  fingerprint: string;
  nudgeText?: string;
  state: CompressionState;
  /** V0.7.5：nudge delivery 证明链（armed → carrier → delivered → final） */
  delivery?: NudgeDelivery;
}

/** 计算 projection fingerprint（轻量；stableKey 全量拼接）。
 *  V0.7.13-PERF：stableKeyForTurn 对每条 content 做 JSON.stringify+hash，
 *  2050 层巨型 TOOL_RESULT（单条可达数 MB）时整体 >10s，超出宿主 hook 预算
 *  （默认 10s，ToolPkgHookExecutionBudget）→ mutation 被丢弃 → 全量发送。
 *  修复：长度前置 + 采样哈希（头 64KB + 尾 16KB + 长度），碰撞概率对
 *  "新增一条巨型消息"场景足够低（相同头尾+相同长度且非同一消息几乎不存在），
 *  而 fingerprint 只用于缓存命中判断（错误命中后果是复用近似投影，可接受，
 *  比超时全量发送好几个量级）。 */
export function computeFingerprint(
  sessionKey: string,
  turns: PromptTurnLike[],
  config: Config,
): string {
  let h = "";
  for (const t of turns) {
    const kind = t.kind || "UNKNOWN";
    const toolName = t.toolName && t.toolName !== "null" && t.toolName !== "undefined" ? t.toolName : "";
    const content = typeof t.content === "string" ? t.content : "";
    const len = content.length;
    // <128K 全量 hash；≥128K 采样（头 64K + 尾 16K）+ 长度——避免 stringify 巨串。
    let core: string;
    if (len < 131072) {
      core = `${kind}|${toolName}|${hashString(JSON.stringify([content, t.metadata ?? null]))}`;
    } else {
      const head = content.slice(0, 65536);
      const tail = len > 81920 ? content.slice(len - 16384) : "";
      core = `${kind}|${toolName}|len${len}|${hashString(head + "\u0000" + tail)}`;
    }
    h += `${core}|`;
  }
  return hashString(`${sessionKey}|${config.modelContextLimit}|${config.preserveRecentMessages}|${h}`);
}

export interface AcpEngine {
  /** 估算链路只读投影：返回压缩后的历史（供宿主估算"右上角计数/阈值判断"），
   *  只读：不持久化、不建块、不改 nudge。 */
  estimate(
    sessionKey: string,
    chatId: string | undefined,
    turns: PromptTurnLike[],
  ): Promise<PromptTurnLike[]>;
  project(
    sessionKey: string,
    chatId: string | undefined,
    isSubTask: boolean | undefined,
    hookStage: string,
    turns: PromptTurnLike[],
  ): Promise<ProjectionResult>;
  applyCompression(
    sessionKey: string,
    ranges: { startRef: string; endRef: string; summary: string; topic?: string; summaryMaxChars?: number; compressCallId?: string }[],
    messages: PromptTurnLike[],
    chatId?: string,
  ): Promise<{ state: CompressionState; blocksCreated: number; tokensCompressed: number; errors: string[]; warnings: string[] }>;
  deactivateBlock(sessionKey: string, blockId: string): Promise<{ ok: boolean; error?: string }>;
  /** V0.9.2 decompress-content：无状态读取 block 原文（copy-paste，不改 state）。
   *  full=false 一层视图（直接消息+嵌套摘要），full=true 递归到全部原始消息。
   *  大内容（>10000 字符）写临时文件返回路径。 */
  decompressContent(sessionKey: string, blockId: string, full?: boolean): Promise<{ ok: boolean; body?: string; count?: number; tempFile?: string; error?: string }>;
  absorb(sessionKey: string, ref: string, summary: string): Promise<{ ok: boolean; resultText: string; absorbedTokens?: number }>;
  search(sessionKey: string, query: string): Promise<unknown[]>;
  status(sessionKey: string, messages: PromptTurnLike[]): Promise<{ report: string; state: CompressionState }>;
  loadState(sessionKey: string): Promise<OperitAcpSessionState>;
  /** V0.8-P6.2：fold 范围选择（dispatch 前冻结，确定性，与 emergency 段选择同构）。 */
  foldSelectRange(sessionKey: string, turns: PromptTurnLike[]): Promise<{ ok: boolean; range?: FoldRange; reason?: string }>;
  /** V0.8-P6.2：fold apply 前的上下文重查数据源（当前持久化状态 + 当前 raw turns）。 */
  getFoldApplyContext(sessionKey: string): Promise<{ stateVersion: number; kernelState: CompressionState; rawTurns: PromptTurnLike[] }>;
  /** V0.10-P1：后台 deferred fold（预算守卫登记；ChatRuntimeHook completed 时执行）。
   *  读持久化 state + lastRawTurns，对最旧未覆盖段确定性建块并落盘（下轮生效）。
   *  幂等安全：段选择基于当前 state 的未覆盖消息，已压缩过则无可折叠段返回 no-foldable-range。 */
  runDeferredFold(sessionKey: string): Promise<{ ok: boolean; reason?: string; blocksCreated?: number; tokensCompressed?: number }>;
  core: CompressionCore;
  settings: AdapterSettings;
}

export function createEngine(dataDir?: string): AcpEngine {
  const core = createCore();
  const settings = loadAdapterSettings();
  const persistence = createPersistence(dataDir || settings.dataDir);

  // —— V0.7.8：Identity Bridge state（session 隔离，module 级单例；不跨 chat 泄漏）。
  // V0.7.9：从持久化恢复（跨 VM/工具路径共享）；project 保存时写回 hostMetadata.identityBridge。
  let identityState: IdentityBridgeState = createIdentityBridgeState();

  /** V0.7.8：用 identity-bridge 生成 id 的 mapping（legacy continuity + virtual tool identity）。 */
  function mapTurnsWithIdentity(turns: PromptTurnLike[]) {
    return promptTurnsToCoreMessages(turns, {
      identityForTurn: (turn) => {
        const r = identityForTurn(turn, {
          hop: (cachedHop ?? 0) + 1,
          toolState: identityState,
          legacyRefExists: (key) => {
            try {
              // 只有有持久化 state 时才查 legacy 连续性
              return false;
            } catch { return false; }
          },
        });
        return { id: r.id };
      },
    });
  }
  let cachedHop = 0;

  /** 暴露 identity state（status/trace 用；与 persistence 互不影响）。 */
  function getIdentityBridgeState(): IdentityBridgeState { return identityState; }
  function setIdentityBridgeState(s: IdentityBridgeState) { identityState = s; }

  /** per-session 内存锁：同一 session 的 mutation 串行化。 */
  // V0.10-B1-M 修复（M6）：锁表提升到 globalThis——宿主 main.js 只执行一次、
  // 引擎按 key 常驻缓存，但 compress/absorb 工具路径与 finalize/estimate 钩子
  // 可能经不同 engine 实例进入，各实例持独立 locks Map 时同一 session 的
  // mutation 不互斥 → 相等 stateVersion 并发写互相覆盖（丢 block/丢 usage）。
  // 提升后同 runtime 内所有 engine 共享同一把 session 锁。
  const lockStore = (globalThis as Record<string, unknown>).__acpLocksV2 as
    | Map<string, Promise<void>>
    | undefined ?? new Map<string, Promise<void>>();
  if (!(globalThis as Record<string, unknown>).__acpLocksV2) {
    (globalThis as Record<string, unknown>).__acpLocksV2 = lockStore;
  }
  async function acquireLock(sid: string): Promise<() => void> {
    const prev = lockStore.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = () => {
        lockStore.delete(sid);
        resolve();
      };
    });
    lockStore.set(sid, prev.then(() => next));
    await prev;
    return release;
  }

  /**
   * V0.7.3：collectAndEvaluatePressure —— 每个真实 Model Hop 的 pressure 阶段。
   * 与 projection path 解耦：full / incremental / cache 三个路径都必须先经过它。
   * 职责（严格按文档第四/十/十一/十二节）：
   *  - Usage sampling：host DB 采样 + estimate 记录（actual 保持 undefined 诚实语义）
   *  - evaluatePressure：连续压力控制（usage / credit / epoch / growth 全状态）
   *  - per-hop ledger：一条 ledger = 一次真实 Model Hop 的发送前 pressure snapshot
   *  - UsageManager 连续：绝不在 Hop 间重新 create（state 从 hostMetadata 载入）
   * 返回 pressure 决策 + eff 快照；本 Hop 的 projection path 由调用方决定。
   */
  async function collectAndEvaluatePressure(opts: {
    sessionKey: string;
    chatId?: string;
    tokenEstimate: number;
    kernelShouldInject: boolean;
    kernelReason: string;
    prevBlocks: number;
    curBlocks: number;
    prevNudgeState: Record<string, unknown>;
    prevStats: AcpRuntimeStats;
    usageState?: UsageManagerState;
    config: Config;
    settings: AdapterSettings;
    hopNo: number;
  }): Promise<{
    pressure: PressureDecision;
    eff: TokenSnapshot;
    pressurePct: number;
    usageManager: ReturnType<typeof createUsageManager>;
    hostTokens: number | undefined;
    nextStats: AcpRuntimeStats;
  }> {
    const usageManager = createUsageManager(opts.usageState);
    const nextStats: AcpRuntimeStats = { ...opts.prevStats as AcpRuntimeStats };
    const prevEpoch = (opts.prevNudgeState as { acpEpoch?: PressureEpoch }).acpEpoch;
    // —— V0.8 Token 重构：host（DB currentWindowSize）是宿主回合结束的滞后重算值，
    //   与"实际发送上下文"脱节（DB 存原始完整历史，请求发投影）。它不再参与
    //   effective 决策（computeEffectiveTokens 已移除 host 分支），仅作为
    //   趋势审计存档（recordHostUsage → ledger.hostTokens）。
    //   读取保留尽力而为（失败 undefined 不影响请求链路）。
    const hostTokens = opts.chatId
      ? await getHostUsageAdapter().getCurrentContextTokens(String(opts.chatId))
      : undefined;
    if (hostTokens !== undefined) usageManager.recordHostUsage(hostTokens, opts.hopNo);
    usageManager.recordEstimate(opts.tokenEstimate, opts.hopNo);
    let eff = usageManager.getEffectiveSnapshot(opts.tokenEstimate);
    // —— V0.10 第 2 步：host 窗口校准（单边向上，保守，防计数混乱）。
    //    host（DB currentWindowSize）= 上一轮发送后 provider tokenizer 对实际发送
    //    历史的真实计数；estimate = 本轮发送前插件粗估（CJK 每字 1 token）。
    //    仅当 host 显著大于 estimate（>20%）时采用 host —— 说明插件低估了发送体量，
    //    触发提前（保守保护）。向下方向不校准：压缩生效后 host 变小属正常，无法与
    //    "插件高估"区分（V0.7.13-P3-E 实证禁止无条件 max：estimate 高估时 max 顶掉
    //    更准的值且永不回落）。effective 保持单值，ledger 三源留痕，不修改 estimate。
    const hostNum = typeof hostTokens === "number" && Number.isFinite(hostTokens) && hostTokens > 0 ? hostTokens : undefined;
    const estNum = eff.effectiveTokens || opts.tokenEstimate;
    // V0.10-B1-M 修复：host 校准加 clamp 守卫。host 读数来自宿主 DB（currentWindowSize），
    // 单样本异常（读错 chat / DB 脏值 / tokenizer 口径漂移）若被无界采纳会把
    // effective 钉在异常高位 → 每轮 forced → emergency 折叠死循环（B1 修复后折叠
    // 真的会执行，风险从"空转"升级为"反复建块"）。可信上界 = contextLimit × 2，
    // 超界视为异常读数，保持 estimate（host 读数永远只做"向上修正"不做"向上顶爆"）。
    const hostLimit = opts.config.modelContextLimit > 0 ? opts.config.modelContextLimit : 200000;
    const HOST_MAX_CLAMP_FACTOR = 2;
    // host 显著大于 estimate 的判定阈值（>20% 才采纳 host 保守修正；小差异属正常抖动）。
    const HOST_CALIBRATION_RATIO = 1.2;
    const hostPlausible = hostNum !== undefined && hostNum <= hostLimit * HOST_MAX_CLAMP_FACTOR;
    if (hostNum !== undefined && estNum > 0 && hostNum > estNum * HOST_CALIBRATION_RATIO && hostPlausible) {
      eff = { ...eff, effectiveTokens: hostNum, source: "host" as const, confidence: "medium" as const };
      try {
        console.log(`[acp] pressure host-calibrated estimate=${opts.tokenEstimate} estEff=${estNum} host=${hostNum} (host>est*${HOST_CALIBRATION_RATIO}, take host conservative)`);
      } catch { /* noop */ }
    } else if (hostNum !== undefined && hostNum > estNum * HOST_CALIBRATION_RATIO && !hostPlausible) {
      try {
        console.log(`[acp] pressure host-ignored estimate=${opts.tokenEstimate} host=${hostNum} limit=${hostLimit} (clamped: host>limit*${HOST_MAX_CLAMP_FACTOR} treated as stale/erratic)`);
      } catch { /* noop */ }
    }
    const pressurePct = opts.config.modelContextLimit > 0
      ? (eff.effectiveTokens || opts.tokenEstimate) / opts.config.modelContextLimit
      : ((eff.effectiveTokens || opts.tokenEstimate) / 200000);
    // compression baseline：最近一次压缩成功后的 token 基准（供增长判断）。
    const lastCompressToken = typeof opts.prevStats.creditBaseToken === "number" ? opts.prevStats.creditBaseToken : undefined;
    const pressure = evaluatePressure({
      usagePct: pressurePct,
      effectiveTokens: eff.effectiveTokens || opts.tokenEstimate,
      tokenEstimate: opts.tokenEstimate,
      kernelShouldInject: opts.kernelShouldInject,
      kernelReason: opts.kernelReason,
      prevEpoch,
      prevBlocks: opts.prevBlocks,
      curBlocks: opts.curBlocks,
      gentleThresholdPct: opts.settings.gentleThresholdPct,
      strongThresholdPct: opts.settings.strongThresholdPct,
      forcedThresholdPct: opts.settings.hardLimitPct,
      hostEscalationFloor: opts.settings.hostEscalationFloor,
      nudgeCooldownTurns: opts.settings.nudgeCooldownTurns,
      nudgeGrowthFloor: opts.settings.nudgeGrowthFloor,
      usageCreditTokens: opts.settings.usageCreditTokens,
      creditBaseToken: lastCompressToken,
      lastInjectedAt: typeof opts.prevNudgeState.lastInjectedAt === "number" ? opts.prevNudgeState.lastInjectedAt : 0,
      nudgeCount: typeof opts.prevNudgeState.nudgeCount === "number" ? opts.prevNudgeState.nudgeCount : 0,
      lastTokensAtInject: typeof opts.prevNudgeState.lastTokensAtInject === "number" ? opts.prevNudgeState.lastTokensAtInject : 0,
      lastCompressToken,
      source: eff.source,
    });
    // —— V0.7.2：per-hop ledger（发送前决策视图；与 trace 同源，持久化在 usageState）。
    try {
      usageManager.recordHopEntry({
        hop: opts.hopNo,
        estimateTokens: opts.tokenEstimate,
        actualTokens: eff.actualTokens,
        hostTokens: eff.hostTokens,
        compressionCredit: eff.compressionCredit ?? 0,
        effectiveTokens: eff.effectiveTokens,
        source: eff.source,
        confidence: eff.confidence,
      });
    } catch { /* ledger 失败不影响主流程 */ }
    return { pressure, eff, pressurePct, usageManager, hostTokens, nextStats };
  }

  return {
    core,
    settings,

    /** 估算链路只读投影：与发送链路同款压缩（复用已形成 block），但只读：
     *  克隆状态计算、不持久化、不建块（emergency 兜底仅发送链路做，避免
     *  估算侧静默改状态）、不写 nudge/不注入提示（估算不发给模型）。
     *  估算侧不持锁（只读可并发；避免与发送 mutation 互相等待）。
     *  V0.4：估算缓存——同一 fingerprint + stateVersion 未变时直接返回
     *  上次投影（不重跑 processTurn），降低每轮估算开销。 */
    async estimate(sessionKey, chatId, turns) {
      if (!turns || turns.length === 0) return turns;
      try {
        const config = resolveKernelConfig(settings);
        const loaded = await persistence.load(sessionKey);
        // V0.10-B1-M 修复（M8）：估算侧也必须加载 identity-bridge（与发送链路
        // project() 同款），否则 id 口径漂移——估算用无 identity 的 stableKey id、
        // 发送用 namespace-aware id，静态计数与任务中计数不一致。
        if (loaded.hostMetadata.identityBridge) {
          identityState = loadIdentityBridgeState(loaded.hostMetadata.identityBridge);
        }
        const fingerprint = computeFingerprint(sessionKey, turns, config);
        const stateVersion = loaded.hostMetadata.stateVersion ?? 0;
        // 命中缓存：同 fingerprint → 直接返回缓存投影。
        // V0.7.13-P3-I.3：不再要求 stateVersion 一致。回合结束重算（estimate 钩子）
        //   的 turns 与发送时相同，但发送链路 project() 已推进 stateVersion——
        //   若按 fingerprint+stateVersion 双键匹配必然 miss，导致全量重算
        //   （实测 276ms/Node + 2.2MB payload 序列化 ≈ 手机上 1s+）→ 超出宿主
        //   钩子执行预算 → 宿主丢弃钩子结果 → 静态计数回退为原始未投影历史
        //   （29万/31万回归）。估算侧只读（克隆状态、不落盘），发送后的 stateVersion
        //   变化只来自发送链路自身的 block 推进，对"同 turns 的只读投影"无影响。
        const cachedProj = estimateCache.get(sessionKey);
        if (cachedProj && cachedProj.fingerprint === fingerprint) {
          return cachedProj.projection;
        }
        // —— V0.7.13-P3-I.5：前缀匹配快速路径（静态计数对齐任务中的关键）。
        //   回合结束重算的 turns = 发送时 turns + 尾部新增（AI 回复等），
        //   fingerprint 必然 miss → 全量重算折叠浅（proj=1437 vs 发送时 920，
        //   因为 emergency 折叠/cap 深度只在发送链路做）→ 静态计数比任务中
        //   多 10 几万（31万 vs 19万）。修复：识别"前缀=发送时原始 turns、
        //   尾部=少量新增"时，直接复用发送链路已算好的投影（含 emergency
        //   折叠与 cap），仅对尾部新增做轻量投影并 cap，静态≈任务中。
        //   估算侧仍只读：只读缓存、不落盘、不建块。
        // —— V0.7.13-P3-I.6：前缀复用数据源改为持久化 state（真根因修复）。
        //   P3-I.5 失败根因：hook 在宿主独立 runtime 被调用（lifecycle.ts 注释），
        //   发送链路 project() 写的内存缓存（发送 runtime 的 globalThis）对 estimate()
        //   所在 runtime 不可见 → memPrev/rawPrev 恒 undefined → 前缀匹配必然 miss。
        //   数据源改持久化：rawTurnsFile（saveRawTurns 落盘的发送时 turns）+
        //   hostMetadata.lastProjection（发送时最终投影，本提交新增落盘）——跨 runtime 可见。
        {
          let rawPrev: PromptTurnLike[] | undefined;
          try { rawPrev = (await persistence.loadRawTurns(sessionKey)) as PromptTurnLike[] | undefined; } catch { rawPrev = undefined; }
          const memPrev = (loaded.hostMetadata.lastProjection
            ? { projection: loaded.hostMetadata.lastProjection as PromptTurnLike[] }
            : undefined);
          // V0.7.13-P3-I.5b：估算场景放宽新增阈值。回合结束重算时，发送当轮的
          //   工具循环已产生大量新 turn（实测一轮 +19 条，超过发送链路增量阈值 8），
          //   用 8 会必然 miss → 退回全量重算（折叠浅 → 静态 31 万）。
          //   估算场景新增 ≤ 64 条都走前缀复用（只读、安全）。
          const estimateMaxNewTurns = Math.max(
            ((settings as unknown as Record<string, number | undefined>).estimateMaxNewTurns) ?? 64,
            settings.incrementalMaxNewTurns,
          );
          const newCount = rawPrev ? turns.length - rawPrev.length : -1;
          // V0.7.13-P3-I.7：双向前缀对齐。日志实锤 estimate raw=1797 < raw.json 1798
          //   ——estimate 收到的 turns 可能比发送时保存的还短（宿主 estimate 链
          //   做了媒体裁剪/合并），原条件 turns.length >= rawPrev.length 直接跳过
          //   复用 → 必然全量重算。改为：从头部逐条 stableKey 比对，命中数达到
          //   两者较小长度的 90% 即视为前缀命中；按命中数从 lastProjection 中
          //   取出已投影部分，与剩余尾部 turns 合并后 cap。
          {
            const minLen = Math.min(turns.length, rawPrev?.length ?? 0);
            const need = Math.ceil(minLen * 0.9);
            if (memPrev && memPrev.projection && memPrev.projection.length > 0 && rawPrev && minLen >= 8 && need >= 8) {
              let hitLen = 0;
              for (let i = 0; i < minLen; i++) {
                if (stableKeyForTurn(turns[i]) === stableKeyForTurn(rawPrev[i])) hitLen++;
                else break;
              }
              if (hitLen >= need) {
                // lastProjection 是「发送时全部 turns」的投影，与 rawPrev 一一对应度未知，
                // 但投影内容顺序与 rawPrev 相同 → 按比例截取近似：hitLen/rawPrev.length 比例。
                const projAll = memPrev.projection as PromptTurnLike[];
                const ratio = hitLen / rawPrev!.length;
                const take = Math.max(1, Math.round(projAll.length * ratio));
                const head = projAll.slice(0, take);
                const delta = turns.slice(hitLen);
                const deltaMap = promptTurnsToCoreMessages(delta);
                const deltaTurns = coreMessagesToPromptTurns(deltaMap.messages, deltaMap.byKey);
                const merged = [...head, ...deltaTurns];
                const capped = capProjectionSize(merged, { keepChars: 2000, maxRecent: 3, totalBudgetChars: 200_000 });
                cacheSetLimited(estimateCache, sessionKey, { fingerprint, stateVersion, projection: capped });
                try {
                  console.log(`[acp] estimate prefix-hit raw=${turns.length} prev=${rawPrev!.length} hit=${hitLen} proj=${capped.length} delta=${delta.length} ${Date.now() % 100000}`);
                } catch { /* noop */ }
                return capped;
              }
            }
          }
        }
        // 克隆状态：绝不动持久化状态（估算侧只读）。kernelState 为纯 JSON，JSON 深拷贝安全。
        const workState = JSON.parse(JSON.stringify(loaded.kernelState)) as CompressionState;
        // —— V0.7.13-P3-I.4 根因修复：估算路径必须与发送路径同源 identity。
        //   此前 estimate() 用 promptTurnsToCoreMessages(turns)（stableKey 内容指纹），
        //   而发送路径 mapTurnsWithIdentity 用 identity-bridge id（host:user:content:hash）。
        //   block 的 effectiveMessageIds 是 identity-bridge 格式 → 估算路径 coveredIds
        //   匹配 0 → blocks 全灭（日志 blocks=0/11）→ proj=raw → 静态计数回退 31万+。
        //   （P3-I.3 的缓存 miss 只是次要因素；主因是 id 体系不一致。）
        const mapping = mapTurnsWithIdentity(turns);
        mapping.messages = stripOldAnchorMessages(mapping.messages) as CoreMessage[];
        const coveredIds = collectCoveredMessageIds(workState);
        // —— V0.7.13-P3-I.2 回归修复：estimate() 是只读快速路径，禁止任何 await IO（DB 读取）。
        //   P3-I 在此加的 getCurrentContextTokens（SQLite 读取，最多 1500ms）会耗尽
        //   宿主钩子执行预算（ToolPkgHookExecutionBudget）→ 宿主丢弃钩子结果 →
        //   回合结束重算（calculateStableContextWindow）退回原始未投影历史，
        //   静态计数从 19 万涨到 29 万（随原始历史增长）。发送链路 project() 不受影响。
        //   kernel tokenCount 用本地 estimate；hostTokens 优先只在 project() 发送链路做。
        const estimateTokens = estimateProjectionTokens(mapping.messages, coveredIds);
        // 复用发送链路同款 Config / 同款 kernel 折叠：已形成 block 会被识别并投影为摘要占位。
        const turn = core.processTurn({
          messages: mapping.messages,
          state: workState,
          config,
          tokenCount: estimateTokens,
          renderTags: "none",
        });
        let projected = coreMessagesToPromptTurns(turn.messages, mapping.byKey);
        if (settings.hideConsumedCompressCalls && turn.state.blocks.length > 0) {
          try { projected = coreMessagesToPromptTurns(kernelHideConsumedCompressCalls(turn.state, turn.messages).messages, mapping.byKey); } catch { /* noop */ }
        }
        const capped = capProjectionSize(projected, { keepChars: 2000, maxRecent: 3, totalBudgetChars: 200_000 });
        // —— V0.7.13-P3-F：tokenEstimate 基于最终 capped projection（与宿主实际收到的
        //   同一份输入）计算，不再用 cap 前全量（原 519K/654K vs 宿主 191K 的
        //   数量级差异根因）。effective 仍走现有 computeEffectiveTokens 逻辑。
        const tokenEstimate = estimateProjectionTokens(
          promptTurnsToCoreMessages(capped as PromptTurnLike[]).messages,
          collectCoveredMessageIds(workState),
        );
        // 写估算缓存（与发送缓存分离，见 estimateCache 定义注释）。
        cacheSetLimited(estimateCache, sessionKey, { fingerprint, stateVersion, projection: capped });
        try {
          const active = turn.state.blocks.filter((b) => b.active).length;
          console.log(`[acp] estimate chat=${chatId ? String(chatId).slice(0, 8) : "-"} raw=${turns.length} proj=${capped.length} blocks=${active}/${turn.state.blocks.length} tok=${tokenEstimate} ${Date.now() % 100000}`);
        } catch { /* noop */ }
        return capped;
      } catch (error) {
        // 估算侧失败绝不影响宿主估算：透传原历史。
        try { console.log(`[acp] estimate failed, passthrough: ${String(error)}`); } catch { /* noop */ }
        return turns;
      }
    },

    async project(sessionKey, chatId, isSubTask, hookStage, turns) {
      const release = await acquireLock(sessionKey);
      // V0.10-P1：FULL 投影计时起点（预算守卫：forced 折叠前检查已耗时）。
      const t0 = Date.now();
      try {
        // —— 阶段守卫：宿主同一发送周期会调两次 finalize hook。
        //   第一阶段 before_finalize_prompt：输入为消息库原始历史 → 执行投影压缩。
        //   第二阶段 before_send_to_model：输入是宿主基于第一阶段投影输出整理的
        //   内容（SYSTEM 可能已被宿主替换为精简版，丢失 ACP 指南）→ 返回
        //   第一阶段缓存的投影（含完整 SYSTEM/ACP guide），绝不透传宿主精简
        //   turns——否则 ACP 上下文管理指南（模型主动压缩的唯一指引）会丢失，
        //   模型只看到裸工具、不知何时用，压缩永远不主动发生。
        //   同时不重复 processTurn（防 kernel syncBlocks 误 deactivate）。
        if (hookStage === "before_send_to_model") {
          const cached = await persistence.load(sessionKey);
          const config = resolveKernelConfig(settings);
          const fp = computeFingerprint(sessionKey, turns, config);
          const memCached = projectionCache.get(sessionKey);
          // 设计意图保留：stage2 输入是 stage1 的输出（fingerprint 按设计不匹配），
          // 盲取内存缓存的投影（= stage1 对本次发送周期的投影结果）是正确语义。
          const projected = memCached && memCached.projection && Array.isArray(memCached.projection) && memCached.projection.length > 0
            ? memCached.projection
            : undefined;
          // —— V0.7.3：stage2 也必须经过 pressure（禁止 cache 绕过）。
          //   pressure 输入：tokenEstimate 用缓存投影的 estimate（无缓存时透传 raw
          //   turns 估算）；kernelShouldInject 用 kernel 对当前 turns 的 nudge 判断
          //   （无 processTurn 时以 usage 档位兜底，evaluatePressure 内部处理）。
          const stage2Estimate = projected && Array.isArray(projected)
            ? estimateProjectionTokens(promptTurnsToCoreMessages(projected as PromptTurnLike[]).messages, collectCoveredMessageIds(cached.kernelState))
            : estimateProjectionTokens(promptTurnsToCoreMessages(turns).messages, collectCoveredMessageIds(cached.kernelState));
          const prevStats2 = { ...(cached.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS) };
          const hopNo2 = ((cached.hostMetadata.usageState as UsageManagerState | undefined)?.lastHop ?? 0) + 1;
          const stage2Pressure = await collectAndEvaluatePressure({
            sessionKey, chatId,
            tokenEstimate: stage2Estimate,
            // V0.10-B1-M 修复：无 processTurn 时以 usage 档位模拟 kernel 判断，
            // 消灭 [gentle, hostEscalationFloor) 死区——旧硬编码 false 使 stage2
            // 在 45%~70% 区间永不注入 gentle nudge（FULL 路径 L1080 会注入）。
            kernelShouldInject: config.modelContextLimit > 0
              ? stage2Estimate / config.modelContextLimit >= settings.gentleThresholdPct
              : false,
            kernelReason: "",
            prevBlocks: cached.kernelState.blocks.length,
            curBlocks: cached.kernelState.blocks.length,
            prevNudgeState: (cached.hostMetadata.acpNudge ?? {}) as Record<string, unknown>,
            prevStats: prevStats2,
            usageState: cached.hostMetadata.usageState as UsageManagerState | undefined,
            config, settings,
            hopNo: hopNo2,
          });
          const stage2Level: NudgeLevel = stage2Pressure.pressure.level ??
            (stage2Pressure.pressurePct >= settings.strongThresholdPct ? "strong"
              : stage2Pressure.pressurePct >= settings.gentleThresholdPct ? "gentle"
              : "none");
          const finalPrepared = projected && Array.isArray(projected) ? [...(projected as PromptTurnLike[])] : [...turns];
          // —— V0.7.6：删除 preflight/safety-emergency 自动折叠。
          //   硬限（hardLimitPct）只作为 forcedThresholdPct 传入 evaluatePressure →
          //   产生 forced nudge（绕过 growth/cadence/credit 的强提示），绝不自动压缩历史。
          //   压缩只由模型主动调用 compress 工具执行。
          // nudge 必须最终进入实际发送的 preparedHistory（文档第八节：nudge 是 ephemeral，
          // 不能因为 stage2 复用缓存而丢失前一个 Hop 的 nudge——本 Hop 重新决策注入）。
          let stage2NudgeText: string | undefined;
          let stage2Delivery: NudgeDelivery | undefined;
          const stage2TierHint = detectTierOpportunity({
          activeBlocks: cached.kernelState.blocks,
          tier2Trigger: settings.tier2Trigger,
          tier3Trigger: settings.tier3Trigger,
        });
        if (stage2Pressure.pressure.allowInject && settings.nudgeEnabled) {
          stage2Delivery = createNudgeDelivery(hookStage);
          const stage2Spans = kernelActiveBlockSpans(cached.kernelState);
          const stage2SpansText = stage2Spans.length > 0
            ? stage2Spans.map((s) => `${s.blockId}(${s.tier}:${s.startRef}..${s.endRef})`).join(", ")
            : "";
          stage2NudgeText = buildNudgeTextFromReason(stage2Pressure.pressure.decisionReason, stage2Level, stage2TierHint, stage2SpansText, settings.maxShrinkPerCompress);
            const stage2Carrier = buildNudgeCarrier(stage2NudgeText, stage2Level);
            finalPrepared.push({ kind: stage2Carrier.kind, content: stage2Carrier.content, metadata: stage2Carrier.metadata });
            stage2Delivery = markDelivered(stage2Delivery, stage2NudgeText, stage2Carrier, stage2Level);
            stage2Pressure.nextStats.nudgeIssued = (stage2Pressure.nextStats.nudgeIssued ?? 0) + 1;
            if (stage2Level === "gentle") stage2Pressure.nextStats.gentleNudges = (stage2Pressure.nextStats.gentleNudges ?? 0) + 1;
            else if (stage2Level === "strong") stage2Pressure.nextStats.strongNudges = (stage2Pressure.nextStats.strongNudges ?? 0) + 1;
            else stage2Pressure.nextStats.emergencyNudges = (stage2Pressure.nextStats.emergencyNudges ?? 0) + 1;
          }
          try {
            const p0 = finalPrepared[0];
            const pLen = p0 && typeof (p0 as PromptTurnLike).content === "string" ? String((p0 as PromptTurnLike).content).length : 0;
            const pHasAcp = p0 && typeof (p0 as PromptTurnLike).content === "string" ? String((p0 as PromptTurnLike).content).includes("[ACP 上下文管理]") : false;
            console.log(`[acp] project stage2 fp=${fp.slice(0, 12)} cached=${projected ? 1 : 0} sysLen=${pLen} sysHasAcp=${pHasAcp} nudge=${stage2Pressure.pressure.allowInject ? 1 : 0} eff=${Math.round(stage2Pressure.pressurePct * 100)}%`);
          } catch { /* noop */ }
          // 持久化 stage2 的 usageState + acpNudge（ledger 已含 stage2 hop）。
          const stage2NextState: OperitAcpSessionState = {
            adapterStateVersion: cached.adapterStateVersion,
            kernelState: cached.kernelState,
            hostMetadata: {
              ...cached.hostMetadata,
              stateVersion: cached.hostMetadata.stateVersion ?? 0,
              lastProjectionFingerprint: cached.hostMetadata.lastProjectionFingerprint ?? fp,
              lastUpdatedAt: Date.now(),
              ...(chatId ? { lastChatId: String(chatId) } : {}),
              acpNudge: {
                ...(stage2Pressure.pressure.nextNudgeState ?? {}),
                ...(stage2Pressure.pressure.nextEpoch ? { acpEpoch: stage2Pressure.pressure.nextEpoch } : {}),
              },
              runtimeStats: stage2Pressure.nextStats,
              usageState: stage2Pressure.usageManager.snapshot(),
            },
          };
          try { await persistence.save(sessionKey, stage2NextState); } catch { /* stage2 保存失败不影响返回 */ }
          return { preparedHistory: finalPrepared as PromptTurnLike[], fingerprint: fp, state: cached.kernelState, nudgeText: stage2NudgeText, delivery: stage2Delivery };
        }
        const config = resolveKernelConfig(settings);
        const fingerprint = computeFingerprint(sessionKey, turns, config);

        const cached = await persistence.load(sessionKey);
        // V0.7.9：从持久化恢复 identity-bridge state（工具路径/跨 VM 共享）。
        if (cached.hostMetadata.identityBridge) {
          identityState = loadIdentityBridgeState(cached.hostMetadata.identityBridge);
        }
        const stateVersion = cached.hostMetadata.stateVersion ?? 0;
        if (cached.hostMetadata.lastProjectionFingerprint === fingerprint) {
          const memCached = projectionCache.get(sessionKey);
          const projected = memCached && memCached.fingerprint === fingerprint && memCached.stateVersion === stateVersion
            ? memCached.projection
            : undefined;
          // —— V0.7.3：cache hit 也必须经过 pressure（禁止 cache 绕过 pressure）。
          //   投影可复用缓存，但本 Hop 的 pressure decision 必须重新评估。
          const cacheEstimate = estimateProjectionTokens(
            promptTurnsToCoreMessages((projected ?? turns) as PromptTurnLike[]).messages,
            collectCoveredMessageIds(cached.kernelState),
          );
          const cacheHopNo = ((cached.hostMetadata.usageState as UsageManagerState | undefined)?.lastHop ?? 0) + 1;
          const cachePrevStats = { ...(cached.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS) };
          const cachePressure = await collectAndEvaluatePressure({
            sessionKey, chatId,
            tokenEstimate: cacheEstimate,
            // V0.10-B1-M 修复：同 stage2，消灭 CACHE-HIT 路径 [gentle, floor) 死区。
            kernelShouldInject: config.modelContextLimit > 0
              ? cacheEstimate / config.modelContextLimit >= settings.gentleThresholdPct
              : false,
            kernelReason: "",
            prevBlocks: cached.kernelState.blocks.length,
            curBlocks: cached.kernelState.blocks.length,
            prevNudgeState: (cached.hostMetadata.acpNudge ?? {}) as Record<string, unknown>,
            prevStats: cachePrevStats,
            usageState: cached.hostMetadata.usageState as UsageManagerState | undefined,
            config, settings,
            hopNo: cacheHopNo,
          });
          const cacheLevel: NudgeLevel = cachePressure.pressure.level ??
            (cachePressure.pressurePct >= settings.strongThresholdPct ? "strong"
              : cachePressure.pressurePct >= settings.gentleThresholdPct ? "gentle"
              : "none");
          const cacheFinal = projected && Array.isArray(projected) && projected.length > 0
            ? [...(projected as PromptTurnLike[])]
            : [...turns];
          // —— V0.7.6：删除 cache-hit 的 preflight/safety-emergency 自动折叠。
          //   硬限只作为 forcedThresholdPct 产生 forced nudge，绝不自动压缩历史。
          let cacheNudgeText: string | undefined;
          let cacheDelivery: NudgeDelivery | undefined;
          const cacheTierHint = detectTierOpportunity({
          activeBlocks: cached.kernelState.blocks,
          tier2Trigger: settings.tier2Trigger,
          tier3Trigger: settings.tier3Trigger,
        });
        if (cachePressure.pressure.allowInject && settings.nudgeEnabled) {
          cacheDelivery = createNudgeDelivery(hookStage);
          const cacheSpans = kernelActiveBlockSpans(cached.kernelState);
          const cacheSpansText = cacheSpans.length > 0
            ? cacheSpans.map((s) => `${s.blockId}(${s.tier}:${s.startRef}..${s.endRef})`).join(", ")
            : "";
          cacheNudgeText = buildNudgeTextFromReason(cachePressure.pressure.decisionReason, cacheLevel, cacheTierHint, cacheSpansText, settings.maxShrinkPerCompress);
            const cacheCarrier = buildNudgeCarrier(cacheNudgeText, cacheLevel);
            cacheFinal.push({ kind: cacheCarrier.kind, content: cacheCarrier.content, metadata: cacheCarrier.metadata });
            cacheDelivery = markDelivered(cacheDelivery, cacheNudgeText, cacheCarrier, cacheLevel);
            cachePressure.nextStats.nudgeIssued = (cachePressure.nextStats.nudgeIssued ?? 0) + 1;
            if (cacheLevel === "gentle") cachePressure.nextStats.gentleNudges = (cachePressure.nextStats.gentleNudges ?? 0) + 1;
            else if (cacheLevel === "strong") cachePressure.nextStats.strongNudges = (cachePressure.nextStats.strongNudges ?? 0) + 1;
            else cachePressure.nextStats.emergencyNudges = (cachePressure.nextStats.emergencyNudges ?? 0) + 1;
          }
          const cacheNextState: OperitAcpSessionState = {
            adapterStateVersion: cached.adapterStateVersion,
            kernelState: cached.kernelState,
            hostMetadata: {
              ...cached.hostMetadata,
              stateVersion: cached.hostMetadata.stateVersion ?? 0,
              lastProjectionFingerprint: fingerprint,
              lastUpdatedAt: Date.now(),
              ...(chatId ? { lastChatId: String(chatId) } : {}),
              acpNudge: {
                ...(cachePressure.pressure.nextNudgeState ?? {}),
                ...(cachePressure.pressure.nextEpoch ? { acpEpoch: cachePressure.pressure.nextEpoch } : {}),
              },
              runtimeStats: cachePressure.nextStats,
              usageState: cachePressure.usageManager.snapshot(),
            },
          };
          try { await persistence.save(sessionKey, cacheNextState); } catch { /* cache 保存失败不影响返回 */ }
          try {
            console.log(`[acp] project CACHE-HIT stage=${hookStage} fp=${fingerprint.slice(0, 12)} nudge=${cachePressure.pressure.allowInject ? 1 : 0} eff=${Math.round(cachePressure.pressurePct * 100)}% reason=${cachePressure.pressure.decisionReason}`);
          } catch { /* noop */ }
          return { preparedHistory: cacheFinal as PromptTurnLike[], fingerprint, state: cached.kernelState, nudgeText: cacheNudgeText, delivery: cacheDelivery };
        }

        // —— V0.6 Phase7 增量快速路径：stateVersion 未变 + 本次 turns 是上次的
        //   尾部超集（新增少量 tool result/assistant 消息，前缀稳定）时，
        //   复用上次投影 + 只追加新增尾部，跳过全量 processTurn 与 capProjectionSize。
        //   解决 20-50 Hop 工具循环里每 Hop 全量重投影的 O(n²) 成本。
        //   前提：state 未变（无新 block）→ 旧投影仍有效，仅尾部新增内容需并入。
        if (!(cached.hostMetadata.lastProjectionFingerprint === fingerprint)) {
          const memPrev = projectionCache.get(sessionKey);
          const rawPrev = rawTurnsCache.get(sessionKey);
          const stateUnchanged = (cached.hostMetadata.stateVersion ?? 0) === (memPrev?.stateVersion ?? -1);
          if (memPrev && memPrev.projection && rawPrev && stateUnchanged
            && turns.length >= rawPrev.length
            && turns.length - rawPrev.length > 0
            && turns.length - rawPrev.length <= settings.incrementalMaxNewTurns) {
            // 校验前缀稳定：前 rawPrev.length 条 stableKey 完全一致。
            let prefixOk = true;
            for (let i = 0; i < rawPrev.length; i++) {
              if (stableKeyForTurn(turns[i]) !== stableKeyForTurn(rawPrev[i])) { prefixOk = false; break; }
            }
            if (prefixOk) {
              const delta = turns.slice(rawPrev.length);
              // 新增尾部本身再做一次轻量投影（可能含 tool result 需转 core）。
              const deltaMap = promptTurnsToCoreMessages(delta);
              const deltaTurns = coreMessagesToPromptTurns(deltaMap.messages, deltaMap.byKey);
              const merged = [...memPrev.projection, ...deltaTurns];
              const capped = capProjectionSize(merged, { keepChars: 2000, maxRecent: 3, totalBudgetChars: 200_000 });
              // —— V0.7.3：incremental 也必须经过 pressure（禁止 incremental → return → skip pressure）。
              //   pressure 输入：tokenEstimate 用增量合并投影的估算（与 full path 同源）；
              //   kernelShouldInject 用 kernel 对增量 turns 的 nudge 判断（无 processTurn 时
              //   以 usage 档位兜底，evaluatePressure 内部处理）。
              const incEstimate = estimateProjectionTokens(
                promptTurnsToCoreMessages(capped as PromptTurnLike[]).messages,
                collectCoveredMessageIds(cached.kernelState),
              );
              const incHopNo = ((cached.hostMetadata.usageState as UsageManagerState | undefined)?.lastHop ?? 0) + 1;
              const incPrevStats = { ...(cached.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS) };
              const incPressure = await collectAndEvaluatePressure({
                sessionKey, chatId,
                tokenEstimate: incEstimate,
                // V0.10-B1-M 修复：同 stage2，消灭 INCREMENTAL 路径死区。
                kernelShouldInject: config.modelContextLimit > 0
                  ? incEstimate / config.modelContextLimit >= settings.gentleThresholdPct
                  : false,
                kernelReason: "",
                prevBlocks: cached.kernelState.blocks.length,
                curBlocks: cached.kernelState.blocks.length,
                prevNudgeState: (cached.hostMetadata.acpNudge ?? {}) as Record<string, unknown>,
                prevStats: incPrevStats,
                usageState: cached.hostMetadata.usageState as UsageManagerState | undefined,
                config, settings,
                hopNo: incHopNo,
              });
              const incLevel: NudgeLevel = incPressure.pressure.level ??
                (incPressure.pressurePct >= settings.strongThresholdPct ? "strong"
                  : incPressure.pressurePct >= settings.gentleThresholdPct ? "gentle"
                  : "none");
              const incFinal = [...capped];
              // —— V0.7.6：删除 incremental 的 preflight/safety-emergency 自动折叠。
              //   硬限只作为 forcedThresholdPct 产生 forced nudge，绝不自动压缩历史。
              let incNudgeText: string | undefined;
              let incDelivery: NudgeDelivery | undefined;
              const incTierHint = detectTierOpportunity({
              activeBlocks: cached.kernelState.blocks,
              tier2Trigger: settings.tier2Trigger,
              tier3Trigger: settings.tier3Trigger,
            });
            if (incPressure.pressure.allowInject && settings.nudgeEnabled) {
                incDelivery = createNudgeDelivery(hookStage);
                const incSpans = kernelActiveBlockSpans(cached.kernelState);
                const incSpansText = incSpans.length > 0
                  ? incSpans.map((s) => `${s.blockId}(${s.tier}:${s.startRef}..${s.endRef})`).join(", ")
                  : "";
                incNudgeText = buildNudgeTextFromReason(incPressure.pressure.decisionReason, incLevel, incTierHint, incSpansText, settings.maxShrinkPerCompress);
                const incCarrier = buildNudgeCarrier(incNudgeText, incLevel);
                incFinal.push({ kind: incCarrier.kind, content: incCarrier.content, metadata: incCarrier.metadata });
                incDelivery = markDelivered(incDelivery, incNudgeText, incCarrier, incLevel);
                incPressure.nextStats.nudgeIssued = (incPressure.nextStats.nudgeIssued ?? 0) + 1;
                if (incLevel === "gentle") incPressure.nextStats.gentleNudges = (incPressure.nextStats.gentleNudges ?? 0) + 1;
                else if (incLevel === "strong") incPressure.nextStats.strongNudges = (incPressure.nextStats.strongNudges ?? 0) + 1;
                else incPressure.nextStats.emergencyNudges = (incPressure.nextStats.emergencyNudges ?? 0) + 1;
              }
              cacheSetLimited(projectionCache, sessionKey, { fingerprint, stateVersion, projection: incFinal });
              cacheSetLimited(rawTurnsCache, sessionKey, turns);
              const incNextState: OperitAcpSessionState = {
                adapterStateVersion: cached.adapterStateVersion,
                kernelState: cached.kernelState,
                hostMetadata: {
                  ...cached.hostMetadata,
                  stateVersion: cached.hostMetadata.stateVersion ?? 0,
                  lastProjectionFingerprint: fingerprint,
                  lastUpdatedAt: Date.now(),
                  ...(chatId ? { lastChatId: String(chatId) } : {}),
                  acpNudge: {
                    ...(incPressure.pressure.nextNudgeState ?? {}),
                    ...(incPressure.pressure.nextEpoch ? { acpEpoch: incPressure.pressure.nextEpoch } : {}),
                  },
                  runtimeStats: incPressure.nextStats,
                  usageState: incPressure.usageManager.snapshot(),
                },
              };
              try { await persistence.save(sessionKey, incNextState); } catch { /* incremental 保存失败不影响返回 */ }
              try {
                console.log(`[acp] project INCREMENTAL stage=${hookStage} +${delta.length} raw=${turns.length} proj=${incFinal.length} nudge=${incPressure.pressure.allowInject ? 1 : 0} eff=${Math.round(incPressure.pressurePct * 100)}% reason=${incPressure.pressure.decisionReason} (skipped full processTurn)`);
              } catch { /* noop */ }
              return { preparedHistory: incFinal as PromptTurnLike[], fingerprint, state: cached.kernelState, nudgeText: incNudgeText, delivery: incDelivery };
            }
          }
        }

        // —— V0.7.13-PERF（持久化前缀复用快速路径）：内存增量要求 stateVersion
        //   与内存缓存一致（跨 runtime/重启必然失配）。而真实瓶颈在"新一轮
        //   发送"（宿主 budget 10s 内必须完成 stage1 投影，05:29/05:35 两次
        //   超时实锤：巨型 TOOL_RESULT 序列化+hash 是热点）。修复：与 estimate()
        //   的 P3-I.6 同源思路——用持久化的 lastRawTurns + lastProjection 做前缀
        //   匹配复用：本次 turns ⊇ 上次发送的 raw turns 且前缀 stableKey 一致时，
        //   复用上次投影 + 尾部轻量投影 + cap，跳过全量 processTurn。
        //   数据源是持久化（跨 runtime 可见），且不要求 stateVersion 一致
        //   （块推进由 lastProjection 伴随的 kernelState 演进覆盖，投影复用
        //   只要求"前缀内容未变"，前缀的折叠状态不会因新尾部而失效）。
        {
          // V0.10-B1-M 修复：state 文件不持久化 lastRawTurns（save omit），
          // cached.lastRawTurns 恒 undefined → 快速路径是死代码；改从
          // .raw.json（saveRawTurns 落盘）兜底读取，让 PERF 快速路径真正生效。
          const rawPrevLoaded: unknown = cached.lastRawTurns ?? (await persistence.loadRawTurns(sessionKey));
          const rawPrevPersist = (Array.isArray(rawPrevLoaded) ? rawPrevLoaded : undefined) as PromptTurnLike[] | undefined;
          const projPrevPersist = cached.hostMetadata.lastProjection as PromptTurnLike[] | undefined;
          if (rawPrevPersist && rawPrevPersist.length > 0 && projPrevPersist && projPrevPersist.length > 0
            && turns.length >= rawPrevPersist.length) {
            const deltaLen = turns.length - rawPrevPersist.length;
            // 前缀校验：逐条 stableKey 比对（新 turn 内容小，成本可忽略；
            // 旧前缀的 stableKey 已在 cache 计算中付过一次，这里复算可接受）。
            let prefixOk = true;
            for (let i = 0; i < rawPrevPersist.length; i++) {
              if (stableKeyForTurn(turns[i]) !== stableKeyForTurn(rawPrevPersist[i])) { prefixOk = false; break; }
            }
            if (prefixOk && deltaLen > 0) {
              const delta = turns.slice(rawPrevPersist.length);
              const deltaMap = promptTurnsToCoreMessages(delta);
              const deltaTurns = coreMessagesToPromptTurns(deltaMap.messages, deltaMap.byKey);
              const merged = [...(projPrevPersist as PromptTurnLike[]), ...deltaTurns];
              const capped = capProjectionSize(merged, { keepChars: 2000, maxRecent: 3, totalBudgetChars: 200_000 });
              cacheSetLimited(projectionCache, sessionKey, { fingerprint, stateVersion, projection: capped });
              cacheSetLimited(rawTurnsCache, sessionKey, turns);
              const pfNextState: OperitAcpSessionState = {
                adapterStateVersion: cached.adapterStateVersion,
                kernelState: cached.kernelState,
                hostMetadata: {
                  ...cached.hostMetadata,
                  stateVersion: cached.hostMetadata.stateVersion ?? 0,
                  lastProjectionFingerprint: fingerprint,
                  // V0.10-B1-M 修复：同步最新投影。旧实现不更新 lastProjection，
                  // 连续多轮快速路径时投影停留在"首次全量"版本，中间轮次的消息
                  // 从发送内容中丢失（前缀只校验 raw turns，不校验投影完整性）。
                  lastProjection: capped as PromptTurnLike[],
                  lastUpdatedAt: Date.now(),
                  ...(chatId ? { lastChatId: String(chatId) } : {}),
                },
              };
              try { await persistence.save(sessionKey, pfNextState); } catch { /* 快速路径保存失败不影响返回 */ }
              try {
                console.log(`[acp] project PERSIST-PREFIX-REUSE stage=${hookStage} +${deltaLen} raw=${turns.length} proj=${capped.length} blocks=${cached.kernelState.blocks.filter((b) => b.active).length}/${cached.kernelState.blocks.length} (skipped full processTurn)`);
              } catch { /* noop */ }
              return { preparedHistory: capped as PromptTurnLike[], fingerprint, state: cached.kernelState, delivery: undefined };
            }
          }
        }

        const mapping = mapTurnsWithIdentity(turns);
        // 清理宿主回传的旧锚点残留（避免旧摘要继续出现在 UI/上下文）。
        mapping.messages = stripOldAnchorMessages(mapping.messages) as CoreMessage[];
        const coveredIds = collectCoveredMessageIds(cached.kernelState);
        const tokenEstimate = estimateProjectionTokens(mapping.messages, coveredIds);
        // —— V0.8 Token 重构：kernel tokenCount = 本次发送投影的估算（projectionEstimate）。
        //   对齐原版 billion-context 语义：tokenCount = "上一轮实际发送内容的 token 数"
        //   （原版用 session.stats.lastInputTokens = 上游真实值）。生产链路拿不到
        //   provider usage，投影估算就是"实际发送上下文"的最佳可用值。
        //   V0.7.13-P3-I 的 hostTokens ?? estimate 已废弃：host 是 DB 回合结束滞后
        //   重算值（原始历史计数，含未发送部分），与实际发送上下文脱节。
        const kernelTokenCount = tokenEstimate;

        const turn = core.processTurn({
          messages: mapping.messages,
          state: cached.kernelState,
          config,
          tokenCount: kernelTokenCount,
          renderTags: "none",
        });

        // 接线 hideConsumedCompressCalls：压缩成功后隐藏已消耗的 compress 调用。
        let projectedMessages = turn.messages;
        if (settings.hideConsumedCompressCalls && turn.state.blocks.length > 0) {
          try {
            // 0.0.54 返回 HideConsumedResult { messages, hidden }，取 messages。
            projectedMessages = kernelHideConsumedCompressCalls(turn.state, turn.messages).messages;
          } catch { /* 隐藏失败不影响投影 */ }
        }

        const projectedTurns = coreMessagesToPromptTurns(projectedMessages, mapping.byKey);

        // —— V0.6 Phase3.1：巨型 TOOL_RESULT 候选检测（与 nudge 完全解耦——恒执行）。
        //    processTurn 后 state.messageRefs.byRaw 已就绪，用 stableKey 定位稳定 ref。
        //    无论 usage 高低，只要 finalize 收到巨型工具输出就发现它；已被压缩 block
        //    覆盖的消息跳过；absorb 成功的保持 absorbed 不再提示。
        let nextAbsorbCandidates = cached.hostMetadata.absorbCandidates;
        try {
          const detected = detectAbsorbCandidates(turns, mapping, turn.state, coveredIds);
          nextAbsorbCandidates = upsertAbsorbCandidates(cached.hostMetadata.absorbCandidates, detected);
          if (nextAbsorbCandidates.length > 0) {
            try {
              const active = getActiveAbsorbCandidates(nextAbsorbCandidates);
              console.log(`[acp] absorb-candidates active=${active.length} total=${nextAbsorbCandidates.length} big=${active.slice(0, 3).map((c) => `${c.tool}:${c.chars}`).join(" ")}`);
            } catch { /* noop */ }
          }
        } catch (e) {
          try { console.log(`[acp] absorb-candidate detect failed: ${String(e)}`); } catch { /* noop */ }
        }

        // —— V0.7.4 Preflight Over-Hard（新一轮发送前的安全自愈）。
        //    V0.7.3 及以前：只有 kernel nudge reason 含 "EMERGENCY" 才自动折叠 →
        //    本质是"任意 Hop 超 hardLimitPct 就立即 emergency fold"，且依赖 kernel 判断，
        //    不是 Adapter 自己对 host/effective 的采样，也不区分"新一轮超窗自愈"与
        //    "普通 Hop 超限"。
        //    V0.7.4 语义（用户需求 3/4/5/6/7/9/10）：
        //    - Hard Limit = 新一轮发送前的安全自愈触发条件，不是普通 Hop 的即时折叠阈值。
        //    - 在真正发送 preparedHistory 之前，采样当前 host usage / effective usage：
        //      effectiveTokens > hardLimitTokens → preflight compression（只一次）→
        //      压缩后 rebuild projection → re-estimate → re-sample host → recompute pressure
        //      → 再发送本轮。
        //    - 未超 hard limit → 正常走 gentle/strong pressure 管理，不做额外 preflight。
        //    - 压缩后仍超 → safety-emergency（最终兜底，不无限循环）。
        //    - preflight 与 pressure-gentle/strong（nudge）分离：preflight 是插件主动折叠，
        //      nudge 是提示模型自行 compress。
        // V0.8 二阶段：旧 autoFolded/emergencyFreedTokens 声明并入下方 emergency 段。
        const prevStats = { ...(cached.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS) };

        // —— V0.7.6：删除 preflight/safety-emergency 自动折叠（对齐 billion-context 原版语义：
        //   pressure decision ≠ compression execution）。
        //   硬限（hardLimitPct）只作为 forcedThresholdPct 传入 evaluatePressure →
        //   产生 forced nudge（绕过 growth/cadence/credit 的强提示），绝不自动压缩历史。
        //   压缩只由模型主动调用 compress 工具执行。

        // —— V0.7.1：UsageManager 前置创建（emergency credit 与 effective pressure 共用）。
        // —— V0.7.3：统一走 collectAndEvaluatePressure（usage sampling + pressure + ledger 一体化，
        //   full/incremental/cache/stage2 四路径同一条 pressure 链）。
        const hopNo = (((cached.hostMetadata.usageState as UsageManagerState | undefined)?.lastHop) ?? 0) + 1; // V0.7.2 per-hop 计数
        const nextStats: AcpRuntimeStats = { ...prevStats };
        const newBlockIds = turn.state.blocks.filter((b) => !cached.kernelState.blocks.some((pb) => pb.blockId === b.blockId)).map((b) => b.blockId);
        // nudge 状态机（Adapter 层 Continuous Pressure Controller）：V0.7
        //  - 取消 kernelShouldInject 作为硬总门，只作辅助 signal
        //  - effective pressure：usage 缺失/为0 用 estimate 兜底
        //  - cooldown/credit 只抑制 gentle；strong/emergency bypass
        //  - hostEscalationFloor：kernel 沉默区 Adapter 自接管
        //  - epoch 无限连续；compression baseline 记录
        // —— V0.7.3：统一 pressure 链（与 stage2/cache/incremental 完全一致）。
        // —— V0.7.4（需求 7）：压缩后必须重新计算 pressure。
        //   preflight 压缩改变了投影（projTurns 已被覆盖），若继续用压缩前的
        //   tokenEstimate 喂 collectAndEvaluatePressure，effectiveTokens / pressurePct /
        //   hard-limit 状态全是压缩前旧值 → 违反"compress → rebuild projection →
        //   re-estimate → resample host → recompute effective → recompute pressure"。
        //   故：autoFolded 时用压缩后投影重新估算 tokenEstimate 作为本 Hop 的发送视图。
        const sendEstimate = tokenEstimate;
        const prevNudgeState = cached.hostMetadata.acpNudge ?? {};
        const { pressure, eff, pressurePct, usageManager: um2 } = await collectAndEvaluatePressure({
          sessionKey, chatId,
          tokenEstimate: sendEstimate,
          kernelShouldInject: turn.nudge?.shouldInject === true,
          kernelReason: turn.nudge?.reason ?? "",
          prevBlocks: cached.kernelState.blocks.length,
          curBlocks: turn.state.blocks.length,
          prevNudgeState: prevNudgeState as Record<string, unknown>,
          prevStats: nextStats,
          usageState: cached.hostMetadata.usageState as UsageManagerState | undefined,
          config, settings,
          hopNo,
        });
        const nextNudgeState: Record<string, unknown> = {
          ...pressure.nextNudgeState,
          // 持久化 epoch 到 acpNudge（跨轮/跨 VM 恢复压力档位）
          ...(pressure.nextEpoch ? { acpEpoch: pressure.nextEpoch } : {}),
        };
        // nudge 档位：pressure controller 输出（无注入时按 usage 兜底算档位供 stats）
        const level: NudgeLevel = pressure.level ??
          (pressurePct >= settings.strongThresholdPct ? "strong"
            : pressurePct >= settings.gentleThresholdPct ? "gentle"
            : "gentle");

        // nudge 仅当 controller 允许时注入（SYSTEM 消息追加；UI 不渲染成新用户消息）。
        // V0.7.5：delivery 证明链——armed → carrierSelected → deliveredToPreparedHistory。
        let nudgeText: string | undefined;
        let delivery: NudgeDelivery | undefined;
        if (pressure.allowInject && settings.nudgeEnabled) {
          delivery = createNudgeDelivery(hookStage);
          nudgeText = buildNudgeText(turn.nudge!, level, settings.maxShrinkPerCompress);
          // V0.6 Phase3.1：从持久化候选读取（检测已在 project 内与 nudge 解耦恒执行）。
          //    只消费候选，不在此处重新检测。文案提供可操作 ref（与 absorb 工具兼容）。
          const active = getActiveAbsorbCandidates(nextAbsorbCandidates);
          if (active.length > 0) {
            const lines = active.slice(0, 3).map((c) => `- ref=${c.ref} tool=${c.tool} size=${c.chars}`);
            nudgeText += `\n检测到可释放的大型工具输出。可吸收候选：\n${lines.join("\n")}${active.length > 3 ? `\n- 及另外 ${active.length - 3} 条` : ""}\n如果这些内容已被消费且后续不需要原文，请调用 absorb(ref="...", summary="...") 释放上下文空间。`;
          }
          const carrier = buildNudgeCarrier(nudgeText, level);
          projectedTurns.push({ kind: carrier.kind, content: carrier.content, metadata: carrier.metadata });
          delivery = markDelivered(delivery, nudgeText, carrier, level);
          nextStats.nudgeIssued += 1;
          if (level === "gentle") nextStats.gentleNudges += 1;
          else if (level === "strong") nextStats.strongNudges += 1;
          else nextStats.emergencyNudges += 1;
        }
        // —— V0.8 二阶段：Emergency 折叠重建（cap 退役为核心改动）。
        //   取证（docs/archive/v0.7.13-p3e 等）：V0.7.6 删除 preflight/safety-emergency 后，
        //   超预算时无任何自动建块，只剩 capProjectionSize 硬截断——实测一轮请求
        //   cap 截断 58 条消息、361K→163K（-55%），cap 成为主要压缩手段，
        //   违反"cap 仅安全护栏"任务书六。
        //   修复：pressure=forced（超硬限）时，对最旧未覆盖段自动调
        //   core.applyCompression 建真 block（确定性摘要，同段跨轮稳定），
        //   然后重投影；cap 仍保留在最后（此时应只兜底少量残余）。
        //   与 V0.7.6 语义的差异：不区分"新一轮超窗自愈"与"普通 Hop 超限"，
        //   凡 forced 一律先建块——因为实测证明"靠模型主动 compress"不可靠
        //   （模型经常不调，cap 每轮都在截）。
        let emergencyFolded = false;
        let emergencyFreedTokens = 0;
        let appliedEmState: CompressionState | undefined;
        {
          const targetTokens = Math.floor(settings.modelContextLimit * (settings.gentleThresholdPct ?? 0.7));
          const effTokens = eff.effectiveTokens || sendEstimate;
          if (pressure.level === "forced" && effTokens > targetTokens && mapping.messages.length > 8) {
            // —— V0.10-P1 预算守卫：FULL 投影已耗时过长（接近宿主 hook 预算 10s）时，
            //   不再发送前建块重投影（整轮 mutation 有超时被宿主丢弃的风险），
            //   改为登记后台 deferred fold（ChatRuntimeHook completed 时执行，下轮生效）。
            const elapsed = Date.now() - t0;
            if (elapsed > PROJECT_FOLD_BUDGET_MS) {
              // V0.10-B1-M 修复（M1）：deferred fold 依赖 ChatRuntimeHook（completed
              // 事件触发 runDeferredFold）。宿主 API < 1.0.1 无此 hook 时，登记永远
              // 悬挂（runDeferredFold 无人调用）；此时跳过登记，保持 V0.9.4 行为
              // （超预算走 capProjectionSize 兜底）。能力位由 main.ts 注册时设置。
              const crhAvailable = (globalThis as Record<string, unknown>).__acpChatRuntimeHook === true;
              if (crhAvailable) {
                deferredFoldStore().set(sessionKey, {
                  sessionKey,
                  blocksAtDefer: turn.state.blocks.length,
                  stateVersionAtDefer: cached.hostMetadata.stateVersion ?? 0,
                  level: pressure.level,
                  at: Date.now(),
                });
                try {
                  console.log(`[acp] project DEFER-FOLD stage=${hookStage} elapsed=${elapsed}ms eff=${effTokens} blocks=${turn.state.blocks.length} (budget guard; fold on task-completed)`);
                } catch { /* noop */ }
              } else {
                try {
                  console.log(`[acp] project DEFER-FOLD skipped stage=${hookStage} elapsed=${elapsed}ms (ChatRuntimeHook unavailable; cannot defer fold)`);
                } catch { /* noop */ }
              }
            } else {
              try {
                // 保护尾部：最近 8 条 + 最近 user 消息之后绝不折叠（foldOldestUncoveredSegment 同构）。
                const folded = foldOldestUncoveredSegment(core, turn.state, mapping.messages, config);
                if (folded) {
                  // 用新状态重投影（同 FULL path：processTurn 会把 covered 消息折叠为摘要占位）。
                  appliedEmState = folded.state;
                  const reTurn = core.processTurn({
                    messages: mapping.messages,
                    state: folded.state,
                    config,
                    tokenCount: Math.max(0, effTokens - folded.tokensCompressed),
                    renderTags: "none",
                  });
                  appliedEmState = reTurn.state;
                  let reProj = reTurn.messages;
                  if (settings.hideConsumedCompressCalls && reTurn.state.blocks.length > 0) {
                    try { reProj = kernelHideConsumedCompressCalls(reTurn.state, reTurn.messages).messages; } catch { /* noop */ }
                  }
                  const reTurns = coreMessagesToPromptTurns(reProj, mapping.byKey);
                  projectedTurns.length = 0;
                  projectedTurns.push(...reTurns);
                  emergencyFolded = true;
                  emergencyFreedTokens = folded.tokensCompressed;
                  nextStats.emergencyTriggered = (nextStats.emergencyTriggered ?? 0) + 1;
                  nextStats.emergencySavedTokens = (nextStats.emergencySavedTokens ?? 0) + folded.tokensCompressed;
                  nextStats.lastCompressSource = "emergency";
                  nextStats.lastCompressAt = Date.now();
                  // credit 基准更新（与 model compress 同款）。
                  nextStats.creditBaseToken = Math.max(0, effTokens - folded.tokensCompressed);
                  nextStats.creditRemaining = settings.usageCreditTokens;
                  try {
                    console.log(`[acp] project EMERGENCY-FOLD stage=${hookStage} seg=${folded.segLen} refs=${folded.startRef}..${folded.endRef} freed=${folded.tokensCompressed} raw=${turns.length} proj=${reTurns.length}`);
                  } catch { /* noop */ }
                  chatTrace(chatId, {
                    type: "emergency_fold", stage: hookStage,
                    detail: { seg: folded.segLen, freed: folded.tokensCompressed, raw: turns.length, proj: reTurns.length, effective: effTokens },
                  });
                }
              } catch (e) {
                try { console.log(`[acp] emergency-fold failed (fallthrough to cap): ${String(e)}`); } catch { /* noop */ }
              }
            }
          }
        }
        // 裁剪投影输出体量（防宿主主线程解析超大 JSON 卡死——总预算 200K）。
        const cappedTurns = capProjectionSize(projectedTurns, { keepChars: 2000, maxRecent: 3, totalBudgetChars: 200_000 });

        // —— V0.8 九-C：最终发送视图的 token（唯一权威 estimate）。
        //   cappedTurns 就是 hook 返回给宿主的 preparedHistory（实际发送上下文），
        //   对它计数的才是"当前上下文 Token"。此前 trace 里的 tok 是 processTurn
        //   内部口径（cap 前全量），与真实请求体差 10 倍，已废弃该口径。
        const finalProjEstimate = estimateProjectionTokens(
          promptTurnsToCoreMessages(cappedTurns as PromptTurnLike[]).messages,
          collectCoveredMessageIds(turn.state),
        );


        const nextState: OperitAcpSessionState = {
          adapterStateVersion: cached.adapterStateVersion,
          // V0.8 二阶段：emergency 折叠产生新 block 时，authoritative state 用折叠后快照。
          kernelState: emergencyFolded && appliedEmState ? appliedEmState : turn.state,
          hostMetadata: {
            ...cached.hostMetadata,
            // V0.7.13-P3-D：FULL processTurn 产生新的 authoritative kernel snapshot → stateVersion 必须递增。
            //   这是 stale-write guard 的前提（V2 > V1），否则 STAGE2/CACHE-HIT 写 V1 不会被拦截。
            //   仅当 kernel 产生实质变化（refs/blocks 前进）时递增；纯重投影（无变化）保持原版本，
            //   避免 cache-hit 因版本漂移永久失效。
            //   V0.8 二阶段：emergency 建块同样视为实质变化 → 递增。
            stateVersion: (() => {
              const prevState = cached.kernelState;
              const finalState = (emergencyFolded && appliedEmState) ? appliedEmState : turn.state;
              const prevRefs = Object.keys(prevState.messageRefs?.byRef ?? {}).length;
              const curRefs = Object.keys(finalState.messageRefs?.byRef ?? {}).length;
              const prevBlocks = prevState.blocks.length;
              const curBlocks = finalState.blocks.length;
              return (prevRefs !== curRefs || prevBlocks !== curBlocks)
                ? (cached.hostMetadata.stateVersion ?? 0) + 1
                : (cached.hostMetadata.stateVersion ?? 0);
            })(),
            lastProjectionFingerprint: fingerprint,
            toolLoopCoverage: "main-request-only",
            lastUpdatedAt: Date.now(),
            lastTokenEstimate: sendEstimate,
            // V0.7.2：记录真实 chatId（供 applyCompression 显式查询 host DB，禁止 split 推导）。
            ...(chatId ? { lastChatId: String(chatId) } : {}),
            acpNudge: nextNudgeState,
            runtimeStats: nextStats,
            // V0.7.1：usage 事实持久化（estimate/actual/host/compressionCredit，per-session）
            usageState: um2.snapshot(),
            // V0.7.9：identity-bridge state 持久化（跨 VM/工具路径共享）。
            identityBridge: identityState,
            absorbCandidates: nextAbsorbCandidates,
            // V0.8-P3：emergency 折叠新块标记来源（与 model 路径 blockSources 对齐，
            //   统一 Block 审计要求：两种入口的块必须可区分且同构）。
            ...(emergencyFolded && appliedEmState
              ? {
                  blockSources: {
                    ...(cached.hostMetadata.blockSources ?? {}),
                    ...Object.fromEntries(
                      appliedEmState.blocks
                        .filter((b) => !cached.kernelState.blocks.some((pb) => pb.blockId === b.blockId))
                        .map((b) => [b.blockId, "auto" as const]),
                    ),
                  },
                }
              : {}),
          },
        };
        // 写内存投影缓存 + raw turns 缓存（save 剥离不落盘）。
        cacheSetLimited(projectionCache, sessionKey, { fingerprint, stateVersion, projection: cappedTurns });
        cacheSetLimited(rawTurnsCache, sessionKey, turns);
        nextState.lastRawTurns = turns;
        // —— V0.7.13-P3-I.6：发送时最终投影持久化（estimate 跨 runtime 前缀复用数据源）。
        nextState.hostMetadata.lastProjection = cappedTurns;
        await persistence.save(sessionKey, nextState);
        // 持久化最近一轮 raw turns（跨 VM 供 compress/absorb 锚定 refs；不裁剪）。
        await persistence.saveRawTurns(sessionKey, turns);

        try {
          const active = turn.state.blocks.filter((b) => b.active).length;
          const nudgeReason = turn.nudge?.reason ? turn.nudge.reason.slice(0, 120) : "(kernel:no-nudge)";
          const gateInfo = `allow=${pressure.allowInject ? 1 : 0} kShould=${turn.nudge?.shouldInject ? 1 : 0} reason=${pressure.decisionReason} eff=${Math.round(pressurePct * 100)}% src=${eff.source}`;
          const st = nextStats;
          console.log(`[acp] project stage=${hookStage} chat=${chatId ? String(chatId).slice(0, 8) : "-"} sub=${isSubTask ? 1 : 0} fp=${fingerprint.slice(0, 12)} raw=${turns.length} proj=${cappedTurns.length} blocks=${active}/${turn.state.blocks.length} tok=${sendEstimate} saved=${(cached.kernelState.stats?.tokensCompressed ?? 0) - (turn.state.stats?.tokensCompressed ?? 0)} nudge=${gateInfo} stats={n:${st.nudgeIssued},m:${st.compressSucceeded},e:${st.emergencyTriggered}} ${nudgeReason}`);
          // ACP Trace：投影事件（含 pressure 决策原因 + V0.7.1 多源 token 指标）
          chatTrace(chatId, {
            type: "project", stage: hookStage,
            detail: {
              hop: hopNo,
              raw: turns.length, proj: cappedTurns.length, blocks: turn.state.blocks.length,
              tok: finalProjEstimate,
              preCapTok: sendEstimate,
              actual: eff.actualTokens,
              host: eff.hostTokens,
              credit: eff.compressionCredit,
              effective: eff.effectiveTokens,
              effPct: Math.round(pressurePct * 100),
              level, nudgeAllow: pressure.allowInject, reason: pressure.decisionReason,
              source: eff.source, confidence: eff.confidence,
            },
          });
        } catch { /* noop */ }

        // [诊断] 返回前记录 preparedHistory[0] SYSTEM 长度（判定模型实际收到什么）
        try {
          const p0 = cappedTurns[0];
          const pLen = p0 && typeof (p0 as PromptTurnLike).content === "string" ? String((p0 as PromptTurnLike).content).length : 0;
          const pHasAcp = p0 && typeof (p0 as PromptTurnLike).content === "string" ? String((p0 as PromptTurnLike).content).includes("[ACP 上下文管理]") : false;
          console.log(`[acp] project-return stage=${hookStage} firstKind=${p0?.kind ?? "-"} sysLen=${pLen} sysHasAcp=${pHasAcp} projLen=${cappedTurns.length}`);
        } catch { /* noop */ }
        return { preparedHistory: cappedTurns, fingerprint, nudgeText, state: turn.state, delivery,
          pressure: { level, usagePct: pressurePct, effectiveTokens: eff.effectiveTokens || sendEstimate, allowInject: pressure.allowInject, decisionReason: pressure.decisionReason } };
      } finally {
        release();
      }
    },

    async applyCompression(sessionKey, ranges, messages, chatId?: string) {
      const release = await acquireLock(sessionKey);
      let usageStateForSave: UsageManagerState | undefined;
      try {
        const config = resolveKernelConfig(settings);
        const loaded = await persistence.load(sessionKey);
        // V0.7.9：compress 工具路径恢复 identity-bridge state（跨 VM 共享）。
        if (loaded.hostMetadata.identityBridge) {
          identityState = loadIdentityBridgeState(loaded.hostMetadata.identityBridge);
        }
        const rawTurns = Array.isArray(messages) && messages.length > 0
          ? messages
          : (rawTurnsCache.get(sessionKey) ?? loaded.lastRawTurns ?? await persistence.loadRawTurns(sessionKey));
        const invalid = (rawTurns as unknown[]).find((t) => {
          const tt = t as { kind?: unknown; content?: unknown };
          return !tt || typeof tt !== "object" || (typeof tt.kind !== "string" && typeof tt.content !== "string");
        });
        if (invalid) {
          return { state: loaded.kernelState, blocksCreated: 0, tokensCompressed: 0, errors: ["compress: messages 参数结构非法（需要 PromptTurn[] 或省略）"], warnings: [] };
        }
        const mapping = mapTurnsWithIdentity(rawTurns as PromptTurnLike[]);
        const applied = core.applyCompression({
          ranges: ranges.map((r) => ({
            startRef: r.startRef,
            endRef: r.endRef,
            summary: r.summary,
            topic: r.topic,
            summaryMaxChars: r.summaryMaxChars,
            compressCallId: r.compressCallId,
          })),
          messages: mapping.messages,
          state: loaded.kernelState,
          config,
        });
        // —— V0.4：模型 compress 统计 + 来源标记 model。
        const prevStats = { ...(loaded.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS) };
        const nextStats = { ...prevStats };
        nextStats.compressCalled += 1;
        const prevBlocks = loaded.kernelState.blocks;
        const newBlockIds = applied.state.blocks
          .filter((b) => !prevBlocks.some((pb) => pb.blockId === b.blockId))
          .map((b) => b.blockId);
        if (applied.result.blocksCreated > 0 && newBlockIds.length > 0) {
          nextStats.compressSucceeded += 1;
          nextStats.modelSavedTokens += applied.result.tokensCompressed;
          nextStats.lastCompressSource = "model";
          nextStats.lastCompressAt = Date.now();
          // ACP Trace：模型主动压缩成功
          chatTrace(undefined, {
            type: "compress",
            level: "model",
            detail: { blocks: applied.result.blocksCreated, tokens: applied.result.tokensCompressed, ranges: ranges.length },
          });
          // V0.4.1 usage credit：模型主动压缩后同样获得免打扰窗口。
          // V0.7.1 修复：基准取"上次 estimate − 本次释放 token"（压缩后低位），
          //   避免压缩前大值被记为基准导致 credit 永久有效（见 project 内同款修复）。
          const est = loaded.hostMetadata.lastTokenEstimate;
          if (typeof est === "number" && est > 0) {
            nextStats.creditBaseToken = Math.max(0, est - applied.result.tokensCompressed);
            nextStats.creditRemaining = settings.usageCreditTokens;
          }
          // —— V0.7.1：模型压缩同样累加压缩量到 compression credit 独立字段。
          const mgr = createUsageManager((loaded.hostMetadata.usageState as UsageManagerState | undefined));
          mgr.applyCompressionCredit(applied.result.tokensCompressed);
          // 记录 host 测量（若已缓存）+ 持久化 usageState。
          // V0.7.2：chatId 必须显式（applyCompression 的 chatId 参数 > lastChatId 持久值），
          //   禁止 sessionKey.split 推导（主对话 sessionKey=chatId 本身，split 无意义且子任务错误）。
          const effectiveChatId = chatId || loaded.hostMetadata.lastChatId || "";
          const hostNow = effectiveChatId
            ? await getHostUsageAdapter().getCurrentContextTokens(effectiveChatId).catch(() => undefined)
            : undefined;
          if (hostNow !== undefined) mgr.recordHostUsage(hostNow);
          usageStateForSave = mgr.snapshot();
        } else if (applied.result.blocksCreated === 0) {
          nextStats.compressFailed += 1;
        }
        // state mutation 后 stateVersion++ 并让旧投影失效。
        await persistence.save(sessionKey, {
          ...loaded,
          kernelState: applied.state,
          hostMetadata: {
            ...loaded.hostMetadata,
            lastUpdatedAt: Date.now(),
            stateVersion: (loaded.hostMetadata.stateVersion ?? 0) + 1,
            lastProjectionFingerprint: undefined as string | undefined,
            // V0.10-B1-M 修复：压缩/状态变更后清除陈旧投影，下轮必须走全量
            // processTurn 重建投影（否则 PERSIST-PREFIX-REUSE 复用压缩前旧投影，
            // 折叠收益对模型不可见）。lastRawTurns 不清——原始 turns 不因压缩而变，
            // compress/decompress 仍要锚定。
            lastProjection: undefined as PromptTurnLike[] | undefined,
            runtimeStats: nextStats,
            ...(usageStateForSave ? { usageState: usageStateForSave } : {}),
            // V0.7.9：identity-bridge state 持久化（compress/absorb 工具路径）。
            identityBridge: identityState,
            blockSources: {
              ...(loaded.hostMetadata.blockSources ?? {}),
              ...(newBlockIds.length > 0
                ? Object.fromEntries(newBlockIds.map((id) => [id, "model" as const]))
                : {}),
            },
          },
        });
        projectionCache.delete(sessionKey); estimateCache.delete(sessionKey);
        const createdBlocksText = newBlockIds.length > 0
          ? kernelFormatCreatedBlocks(applied.state, applied.state.blocks.filter((b) => newBlockIds.includes(b.blockId)))
          : "";
        return {
          state: applied.state,
          blocksCreated: applied.result.blocksCreated,
          tokensCompressed: applied.result.tokensCompressed,
          errors: applied.result.errors,
          warnings: applied.result.warnings,
          // V0.9.1 block-map：新建块的 ref 跨度（b3=m00044–m00097），模型据此精确蒸馏。
          ...(createdBlocksText ? { createdBlocks: createdBlocksText } : {}),
        };
      } finally {
        release();
      }
    },

    async deactivateBlock(sessionKey, blockId) {
      const release = await acquireLock(sessionKey);
      try {
        const loaded = await persistence.load(sessionKey);
        const block = loaded.kernelState.blocks.find((b) => b.blockId === blockId);
        if (!block) return { ok: false, error: `block ${blockId} not found` };
        if (!block.active) return { ok: false, error: `block ${blockId} is not active` };
        const newState = kernelDeactivateBlock(loaded.kernelState, [blockId]);
        await persistence.save(sessionKey, {
          ...loaded,
          kernelState: newState,
          hostMetadata: {
            ...loaded.hostMetadata,
            lastUpdatedAt: Date.now(),
            stateVersion: (loaded.hostMetadata.stateVersion ?? 0) + 1,
            lastProjectionFingerprint: undefined as string | undefined,
            lastProjection: undefined as PromptTurnLike[] | undefined,
          },
        });
        projectionCache.delete(sessionKey); estimateCache.delete(sessionKey);
        // ACP Trace：decompress 恢复
        chatTrace(undefined, { type: "decompress", detail: { blockId } });
        return { ok: true };
      } finally {
        release();
      }
    },
    // V0.9.2 decompress-content：无状态读取 block 原文（copy-paste，不改 state）。
    // 原版 bc-upstream 同款思路：优先 raw turns 原文缓存 → collectBlockContent 现抓 → 大内容写临时文件。
    async decompressContent(sessionKey, blockId, full) {
      const release = await acquireLock(sessionKey);
      try {
        const loaded = await persistence.load(sessionKey);
        const block = loaded.kernelState.blocks.find((b) => b.blockId === blockId);
        if (!block) return { ok: false, error: `block ${blockId} not found` };
        // 1) raw turns（.raw.json 原文缓存）→ CoreMessage[]
        const rawTurns = (rawTurnsCache.get(sessionKey) ?? loaded.lastRawTurns ?? await persistence.loadRawTurns(sessionKey)) as PromptTurnLike[];
        const mapping = mapTurnsWithIdentity(rawTurns);
        // 2) collectBlockContent 提取（full 标志；无状态）
        const collected = kernelCollectBlockContent(loaded.kernelState, block, mapping.messages, { full: full === true });
        const body = collected.text || block.summary || "";
        if (!body) return { ok: false, error: `block ${blockId} 无内容` };
        // 3) 大内容写临时文件（原版同款：>10000 字符）
        if (body.length > 10000) {
          try {
            const safeId = blockId.replace(/[^a-zA-Z0-9_-]/g, "-");
            const tmpPath = `${settings.dataDir}/acp-decompress-${safeId}-${Date.now()}.txt`;
            await Tools.Files.write(tmpPath, body, false, "android");
            return { ok: true, body: "", count: collected.count, tempFile: tmpPath };
          } catch {
            // 写文件失败则直接返回内容（截断 4000）
            return { ok: true, body: body.slice(0, 4000) + "\n...（内容过长，截断显示）", count: collected.count };
          }
        }
        return { ok: true, body, count: collected.count };
      } finally {
        release();
      }
    },

    async absorb(sessionKey, ref, summary) {
      const release = await acquireLock(sessionKey);
      try {
        const config = resolveKernelConfig(settings);
        const loaded = await persistence.load(sessionKey);
        // V0.7.9：absorb 工具路径恢复 identity-bridge state（跨 VM 共享）。
        if (loaded.hostMetadata.identityBridge) {
          identityState = loadIdentityBridgeState(loaded.hostMetadata.identityBridge);
        }
        const rawTurns = (rawTurnsCache.get(sessionKey) ?? loaded.lastRawTurns ?? await persistence.loadRawTurns(sessionKey)) as PromptTurnLike[];
        const mapping = mapTurnsWithIdentity(rawTurns as PromptTurnLike[]);
        const result = kernelApplyAbsorb({
          ref,
          summary,
          messages: mapping.messages,
          state: loaded.kernelState,
          config,
          countTokens: (text: string) => defaultCountTokens(text),
        });
        if (!result.ok) {
          return { ok: false, resultText: result.resultText };
        }
        await persistence.save(sessionKey, {
          ...loaded,
          kernelState: result.state,
          hostMetadata: {
            ...loaded.hostMetadata,
            lastUpdatedAt: Date.now(),
            stateVersion: (loaded.hostMetadata.stateVersion ?? 0) + 1,
            lastProjectionFingerprint: undefined as string | undefined,
            lastProjection: undefined as PromptTurnLike[] | undefined,
            // V0.6 Phase3.1：absorb 成功后该 ref 标记 absorbed，后续不再作为 active 候选提示。
            absorbCandidates: markAbsorbed(loaded.hostMetadata.absorbCandidates, ref),
          },
        });
        projectionCache.delete(sessionKey); estimateCache.delete(sessionKey);
        const record = result.state.absorbed?.slice(-1)[0] as { tokensReclaimed?: number } | undefined;
        // ACP Trace：absorb 吸收成功
        chatTrace(undefined, {
          type: "absorb",
          detail: { ref, absorbedTokens: record?.tokensReclaimed ?? 0 },
        });
        return { ok: true, resultText: result.resultText, absorbedTokens: record?.tokensReclaimed };
      } finally {
        release();
      }
    },

    async search(sessionKey, query) {
      const loaded = await persistence.load(sessionKey);
      const docs = kernelBlockDocs(loaded.kernelState);
      return kernelSearchBlocks(docs, query, { limit: 10, minScore: 0.01 });
    },

    async status(sessionKey, messages) {
      const loaded = await persistence.load(sessionKey);
      const config = resolveKernelConfig(settings);
      const mapping = promptTurnsToCoreMessages(messages);
      const tokenCount = estimateProjectionTokens(mapping.messages, collectCoveredMessageIds(loaded.kernelState));
      const report = core.status(loaded.kernelState, tokenCount, config);
      // V0.9.2 viableRanges：用投影消息算连续可压范围（保护区=最近 8 条），
      // 再用 kernel viableRanges 过滤掉 <200 tokens 碎片——模型据此压缩必成功。
      const viable = buildViableRanges(
        loaded.kernelState,
        mapping.messages,
        loaded.kernelState.messageRefs?.byRaw ?? {},
        settings.minCompressRange,
      );
      // V0.4.1：指标修正——proactive 指"模型主动建块占全部建块的比例"（原实现
      //  compressSucceeded/nudgeIssued 语义不清），并拆出 conversion rate
      //  （nudge 发出后模型是否跟进 compress）。
      const stats = loaded.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS;
      const totalFolds = (stats.compressSucceeded ?? 0) + (stats.emergencyTriggered ?? 0);
      const proactiveRate = totalFolds > 0
        ? Math.round(((stats.compressSucceeded ?? 0) / totalFolds) * 100)
        : 0;
      const emergencyRate = totalFolds > 0
        ? Math.round(((stats.emergencyTriggered ?? 0) / totalFolds) * 100)
        : 0;
      // conversion：nudge 后模型真的调了 compress（无论成败）的比例。
      const conversionRate = stats.nudgeIssued > 0
        ? Math.round(((stats.compressCalled ?? 0) / stats.nudgeIssued) * 100)
        : 0;
      const enriched = {
        ...(typeof report === "object" && report !== null ? report : { raw: report }),
        runtimeStats: stats,
        // V0.9.1 block-map：当前所有 active block 的 ref 跨度（模型据此传 block id 蒸馏 T2/T3）。
        blockSpans: kernelActiveBlockSpans(loaded.kernelState),
        // V0.9.2 viableRanges：真正可压的连续范围（已过滤 <200 tokens 碎片 + 保护区）。
        viableRanges: viable,
        metrics: {
          proactiveCompressRatePct: proactiveRate,
          emergencySharePct: emergencyRate,
          conversionRatePct: conversionRate,
          nudgeIssued: stats.nudgeIssued,
          compressSucceeded: stats.compressSucceeded,
          emergencyTriggered: stats.emergencyTriggered,
        },
      };
      return { report: JSON.stringify(enriched), state: loaded.kernelState };
    },

    async loadState(sessionKey) {
      return persistence.load(sessionKey);
    },

    // —— V0.10-P1：后台 deferred fold。project() 预算守卫登记的待办，在
    //   ChatRuntimeHook completed（整轮结束，无 hook 预算压力）时执行：
    //   读持久化 state + lastRawTurns → 对最旧未覆盖段确定性建块 → 落盘（stateVersion+1）。
    //   下轮 finalize 的 processTurn 自然折叠为摘要占位。fire-and-forget，失败不影响主链。
    async runDeferredFold(sessionKey) {
      const entry = deferredFoldStore().get(sessionKey);
      if (!entry) return { ok: false, reason: "no-deferred-fold" };
      if (Date.now() - entry.at > DEFER_FOLD_TTL_MS) {
        deferredFoldStore().delete(sessionKey);
        return { ok: false, reason: "defer-expired" };
      }
      // V0.10-B1-M 修复（H3）：自预算计时起点（load 前）。
      const tBudget = Date.now();
      const overBudget = (): boolean => Date.now() - tBudget > DEFERRED_FOLD_BUDGET_MS;
      const release = await acquireLock(sessionKey);
      try {
        const loaded = await persistence.load(sessionKey);
        if (overBudget()) {
          deferredFoldStore().delete(sessionKey);
          return { ok: false, reason: "defer-budget" };
        }
        // state 已前进（期间发生过压缩/建块）→ 旧待办作废（fold 基于当前 state 重选段）。
        // V0.10-B1-M 修复（M5）：stateVersion 前进判定（任何 mutation 都 +1，比
        // blocks.length 全——期间压缩同数量块会漏判）；blocks.length 保留作兼容。
        if ((loaded.hostMetadata.stateVersion ?? 0) > (entry.stateVersionAtDefer ?? 0)
          || (loaded.kernelState.blocks.length ?? 0) > entry.blocksAtDefer) {
          deferredFoldStore().delete(sessionKey);
          return { ok: false, reason: "state-advanced" };
        }
        if (loaded.hostMetadata.identityBridge) {
          identityState = loadIdentityBridgeState(loaded.hostMetadata.identityBridge);
        }
        const rawTurns = (loaded.lastRawTurns as PromptTurnLike[] | undefined)
          ?? (await persistence.loadRawTurns(sessionKey) as unknown as PromptTurnLike[]);
        if (!rawTurns || rawTurns.length === 0) {
          deferredFoldStore().delete(sessionKey);
          return { ok: false, reason: "no-raw-turns" };
        }
        const config = resolveKernelConfig(settings);
        const mapping = mapTurnsWithIdentity(rawTurns);
        if (overBudget()) {
          deferredFoldStore().delete(sessionKey);
          return { ok: false, reason: "defer-budget" };
        }
        const folded = foldOldestUncoveredSegment(core, loaded.kernelState, mapping.messages, config);
        if (!folded) {
          deferredFoldStore().delete(sessionKey);
          return { ok: false, reason: "no-foldable-range" };
        }
        if (overBudget()) {
          // 折叠计算本身超预算：不 save（避免再造一次大写入），下轮重新登记。
          deferredFoldStore().delete(sessionKey);
          return { ok: false, reason: "defer-budget" };
        }
        const prevStats = { ...(loaded.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS) };
        const nextStats = { ...prevStats };
        nextStats.emergencyTriggered = (nextStats.emergencyTriggered ?? 0) + 1;
        nextStats.emergencySavedTokens = (nextStats.emergencySavedTokens ?? 0) + folded.tokensCompressed;
        nextStats.lastCompressSource = "deferred";
        nextStats.lastCompressAt = Date.now();
        const est = loaded.hostMetadata.lastTokenEstimate;
        nextStats.creditBaseToken = Math.max(0, (typeof est === "number" && est > 0 ? est : 0) - folded.tokensCompressed);
        nextStats.creditRemaining = settings.usageCreditTokens;
        await persistence.save(sessionKey, {
          ...loaded,
          kernelState: folded.state,
          hostMetadata: {
            ...loaded.hostMetadata,
            lastUpdatedAt: Date.now(),
            stateVersion: (loaded.hostMetadata.stateVersion ?? 0) + 1,
            lastProjectionFingerprint: undefined as string | undefined,
            lastProjection: undefined as PromptTurnLike[] | undefined,
            runtimeStats: nextStats,
            identityBridge: identityState,
          },
        });
        projectionCache.delete(sessionKey); estimateCache.delete(sessionKey);
        deferredFoldStore().delete(sessionKey);
        chatTrace(undefined, {
          type: "emergency_fold", stage: "deferred",
          detail: { seg: folded.segLen, freed: folded.tokensCompressed, refs: `${folded.startRef}..${folded.endRef}` },
        });
        try {
          console.log(`[acp] DEFERRED-FOLD applied seg=${folded.segLen} refs=${folded.startRef}..${folded.endRef} freed=${folded.tokensCompressed}`);
        } catch { /* noop */ }
        return { ok: true, blocksCreated: folded.blocksCreated, tokensCompressed: folded.tokensCompressed };
      } catch (e) {
        // V0.10-B1-M 修复（M4）：失败也清理登记——否则同一待办每轮 completed
        // 都重试同一段（失败原因不会自愈，如 raw turns 缺失/identity 失败），
        // 形成永久残留 + 每轮白跑。
        deferredFoldStore().delete(sessionKey);
        try { console.log(`[acp] runDeferredFold failed: ${String(e)}`); } catch { /* noop */ }
        return { ok: false, reason: "defer-error" };
      } finally {
        release();
      }
    },

    // —— V0.8-P6.2：LLM Fold 范围选择（dispatch 前冻结；与 emergency 段选择同构）。
    async foldSelectRange(sessionKey, turns) {
      try {
        const loaded = await persistence.load(sessionKey);
        const state = loaded.kernelState;
        const mapping = mapTurnsWithIdentity(turns);
        const messages = mapping.messages;
        const byRaw = state.messageRefs?.byRaw ?? {};
        // 与 project() emergency 段选择完全同构：保护区 = 最近 8 条。
        const PROTECTED = 8;
        if (messages.length <= PROTECTED) {
          return { ok: false, reason: "history-too-short" };
        }
        const covered = collectCoveredMessageIds(state);
        const recentIds = new Set(messages.slice(-PROTECTED).map((m) => m.id));
        // 按 covered/recent 边界切连续未覆盖段（段内不夹已覆盖消息）；
        // 从最旧开始取第一个达到 minCompressRange 字符门槛的段。
        let segStart = -1;
        let anySeg = false;
        for (let i = 0; i < messages.length - PROTECTED; i++) {
          const m = messages[i];
          const isBlocked = covered.has(m.id) || recentIds.has(m.id);
          if (!isBlocked && segStart < 0) segStart = i;
          const segEndsHere = isBlocked || i === messages.length - PROTECTED - 1;
          if (segEndsHere && segStart >= 0) {
            const segEnd = isBlocked ? i - 1 : i;
            const seg = messages.slice(segStart, segEnd + 1);
            anySeg = true;
            const chars = seg.reduce((n, mm) => n + (mm.text ? mm.text.length : 0), 0);
            if (chars >= settings.minCompressRange) {
              // kernel messageRefs.byRaw 键 = 消息 id、值 = ref（{id → ref}），正查。
              const startRef = byRaw[seg[0].id];
              const endRef = byRaw[seg[seg.length - 1].id];
              if (startRef && endRef) {
                const range: FoldRange = {
                  startRef,
                  endRef,
                  startId: seg[0].id,
                  endId: seg[seg.length - 1].id,
                  ids: seg.map((mm) => mm.id),
                  chars,
                  seg: seg.map((mm) => ({ id: mm.id, role: String(mm.role), contentType: String(mm.contentType), text: String(mm.text ?? "") })),
                };
                return { ok: true, range };
              }
            }
            segStart = -1;
          }
        }
        return { ok: false, reason: anySeg ? "range-below-min-chars" : "no-uncovered-head" };
      } catch (e) {
        try { console.log(`[acp] foldSelectRange failed: ${String(e)}`); } catch { /* noop */ }
        return { ok: false, reason: "select-error" };
      }
    },

    // —— V0.8-P6.2：apply 前状态重查数据源（当前持久化状态 + 当前 raw turns）。
    async getFoldApplyContext(sessionKey) {
      const loaded = await persistence.load(sessionKey);
      const rawTurns =
        (rawTurnsCache.get(sessionKey) as PromptTurnLike[] | undefined) ??
        (loaded.lastRawTurns as PromptTurnLike[] | undefined) ??
        (await persistence.loadRawTurns(sessionKey) as unknown as PromptTurnLike[]);
      return {
        stateVersion: loaded.hostMetadata.stateVersion ?? 0,
        kernelState: loaded.kernelState,
        rawTurns: Array.isArray(rawTurns) ? rawTurns : [],
      };
    },
  };
}

/** NudgeLevel 别名（来自 pressure controller）。 */
type NudgeLevel = PressureNudgeLevel;

/**
 * V0.9.2 viableRanges：计算当前真正可压的连续范围。
 * 参照 foldSelectRange 的保护区逻辑（最近 8 条），过滤掉已被 block 覆盖的
 * 消息与保护区，把连续未覆盖消息拼成 range，再用 kernel viableRanges
 * 过滤 <200 tokens 碎片（模型写不出有意义摘要，且整批会被 kernel 原子拒绝）。
 */
function buildViableRanges(
  state: CompressionState,
  messages: CoreMessage[],
  byRaw: Record<string, string>,
  minCompressRange: number,
): { startRef: string; endRef: string; tokens: number }[] {
  const PROTECTED = 8;
  if (messages.length <= PROTECTED) return [];
  const covered = collectCoveredMessageIds(state);
  const recentIds = new Set(messages.slice(-PROTECTED).map((m) => m.id));
  const ranges: { startRef: string; endRef: string; tokens: number }[] = [];
  let segStart: number | null = null;
  for (let i = 0; i < messages.length - PROTECTED; i++) {
    const m = messages[i];
    const isCovered = covered.has(m.id) || recentIds.has(m.id);
    if (!isCovered && segStart === null) segStart = i;
    if (isCovered && segStart !== null) {
      pushRange(ranges, messages, segStart, i - 1, byRaw);
      segStart = null;
    }
  }
  if (segStart !== null) {
    pushRange(ranges, messages, segStart, messages.length - PROTECTED - 1, byRaw);
  }
  // 过滤：低于 minCompressRange 字符 或 <200 tokens 碎片。
  return kernelViableRanges(
    ranges.filter((r) => r.tokens * 4 >= minCompressRange || r.tokens >= 200),
  );
}

function pushRange(
  out: { startRef: string; endRef: string; tokens: number }[],
  messages: CoreMessage[],
  startIdx: number,
  endIdx: number,
  byRaw: Record<string, string>,
): void {
  if (startIdx > endIdx) return;
  const seg = messages.slice(startIdx, endIdx + 1);
  const tokens = seg.reduce((n, m) => n + (m.text ? m.text.length / 4 : 0), 0);
  // kernel messageRefs.byRaw 键 = 消息 id、值 = ref（{id → ref}），正查。
  const startRef = byRaw[seg[0].id] ?? "";
  const endRef = byRaw[seg[seg.length - 1].id] ?? "";
  if (startRef && endRef) out.push({ startRef, endRef, tokens: Math.round(tokens) });
}

/**
 * V0.7.3：buildNudgeTextFromReason —— stage2/cache/incremental 路径的 nudge 文案。
 * 这些路径没有 kernel nudge（turn.nudge 未计算），只有 pressure 决策；
 * 用 pressure 的档位 + reason 生成同款文案（与 buildNudgeText 同模板）。
 */
function buildNudgeTextFromReason(reason: string, level: NudgeLevel, tierHint?: PressureDecision["tierHint"], blockSpansText?: string, maxShrink?: number): string {
  const lines: string[] = [];
  if (level === "gentle") {
    lines.push("[ACP] 上下文使用率已接近阈值，请注意近期对话的上下文占用，建议在合适时机压缩已消费的旧内容。");
    lines.push("压缩请直接调用 acp_tools 工具：acp_tools:compress（范围压缩）、acp_tools:absorb（吸收单条巨型输出）、acp_tools:decompress（恢复原文）、acp_tools:search_context（搜索）、acp_tools:acp_status（查状态/范围）。");
  } else if (level === "strong") {
    lines.push("[ACP] 上下文使用率已较高，请立即压缩已消费的旧内容以释放空间。");
    lines.push("压缩请直接调用 acp_tools 工具：acp_tools:compress（范围压缩）、acp_tools:absorb（吸收单条巨型输出）、acp_tools:decompress（恢复原文）、acp_tools:search_context（搜索）、acp_tools:acp_status（查状态/范围）。");
  } else {
    lines.push("[ACP] 上下文已接近硬上限，请立即调用 acp_tools:compress 压缩最旧、已消费的内容。若本提示持续出现，压缩是继续任务的前提，不要忽略。");
  }
  // V0.9-T2/T3：分级压缩机会引导——已有多个 T1 块可蒸馏 T2；多个 T2 块可浓缩 T3。
  if (tierHint === "t2-distill-ready") {
    lines.push("[ACP] 已存在多个一级压缩块（T1）。若这些块的主题相关且不再需要逐块原文，可对它们做二级蒸馏：compress 的 startId/endId 使用 block id（如 b1..b5），生成 T2 摘要块，进一步压缩已摘要内容。");
    if (blockSpansText) lines.push(`[ACP] 当前活动块跨度：${blockSpansText}。蒸馏时按需选择相关的 T1 块（bN），跨度为各块起止 ref。`);
  } else if (tierHint === "t3-condense-ready") {
    lines.push("[ACP] 已存在多个二级蒸馏块（T2）。若这些 T2 块可合并浓缩，可用 compress 传 block id（如 b6..b8）做三级浓缩（T3），把多块摘要再凝成一块。");
    if (blockSpansText) lines.push(`[ACP] 当前活动块跨度：${blockSpansText}。浓缩时按需选择相关的 T2 块（bN）。`);
  }
  lines.push("调用方式：直接调用 acp_tools:acp_status（查状态/范围）、acp_tools:compress（压缩，content 传 [{startId,endId,summary}]）等工具即可（工具已在工具面注册，无需 package_proxy 中转）。");
  if (maxShrink !== undefined) {
    lines.push(`[ACP] 平滑过渡引导：压缩时优先选择更小、更靠尾部的范围——压缩最近的较大内容，保持最早消息前缀完整。单次大范围重写会急剧改变请求形态并可能触发服务商风控；小而偏尾部的折叠能让前缀缓存存活、过渡平缓。（单次压缩比例上限 ${Math.round(maxShrink * 100)}%）`);
  }
  if (reason) lines.push(`（pressure: ${reason}）`);
  return lines.join("\n");
}

function buildNudgeText(nudge: { reason: string; compressibleRanges: { startRef: string; endRef: string; tokens: number }[] }, level: NudgeLevel, maxShrink?: number): string {
  // 固定模板（不嵌入动态 token 数/百分比——动态内容破坏 LLM 缓存前缀命中率）。
  // 三档递进文案：gentle = 提醒准备；strong = 要求主动压缩；emergency = 必须压缩。
  const lines: string[] = [];
  if (level === "gentle") {
    lines.push("[ACP] 上下文使用率已接近阈值。请在合适时机压缩已消费的旧内容：可先调用 acp_tools:acp_status 查看可压缩范围，再调用 acp_tools:compress 处理已完成且不再需要原文的部分。");
  } else if (level === "strong") {
    lines.push("[ACP] 上下文使用率已超过阈值。请调用 acp_tools:compress 压缩已消费的旧内容以降低上下文占用，无需询问用户、无需等待批准、不要中断当前任务。");
  } else {
    lines.push("[ACP] 上下文已接近硬上限，请立即调用 acp_tools:compress 压缩最旧、已消费的内容。若本提示持续出现，压缩是继续任务的前提，不要忽略。");
  }
  // 调用方式：直接调用 acp_tools 工具（工具已在工具面注册，宿主自动桥接，无需 package_proxy 中转）。
  lines.push("调用方式（直接调用 acp_tools 工具，无需 package_proxy 中转）：");
  lines.push("1) 查范围：acp_tools:acp_status；");
  lines.push("2) 压缩：acp_tools:compress，params.content=[{startId,endId,summary}]；");
  lines.push("3) 吸收单条巨型输出：acp_tools:absorb，params.ref=消息 ref、params.summary=摘要。");
  if (nudge.compressibleRanges.length > 0) {
    const top = [...nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
    lines.push(`建议压缩范围：${top.startRef}..${top.endRef}（acp_tools:compress）。`);
    lines.push(`可选工具：acp_tools:acp_status（查状态/范围）、acp_tools:absorb（吸收单条巨型输出）、acp_tools:decompress（恢复原文）、acp_tools:search_context（搜索）。`);
  }
  if (maxShrink !== undefined) {
    lines.push(`[ACP] 平滑过渡引导：压缩时优先选择更小、更靠尾部的范围——压缩最近的较大内容，保持最早消息前缀完整。单次大范围重写会急剧改变请求形态并可能触发服务商风控；小而偏尾部的折叠能让前缀缓存存活、过渡平缓。（单次压缩比例上限 ${Math.round(maxShrink * 100)}%）`);
  }
  return lines.join("\n");
}