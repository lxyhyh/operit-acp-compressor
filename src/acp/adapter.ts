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
  type NudgeLevel as PressureNudgeLevel,
  type PressureEpoch,
  type PressureDecision,
} from "./pressure";
import { createUsageManager, type UsageManager, type UsageManagerState } from "./usage";
import type { TokenSnapshot } from "./token-source";
import { createOperitHostUsageAdapter, type HostUsageAdapter } from "./host-usage-adapter";
import { detectProtocol, normalizeUsage, type ProviderUsage } from "./token-source";

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
}

/** 计算 projection fingerprint（轻量；stableKey 全量拼接）。 */
export function computeFingerprint(
  sessionKey: string,
  turns: PromptTurnLike[],
  config: Config,
): string {
  let h = "";
  for (const t of turns) {
    h += `${stableKeyForTurn(t)}|`;
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
  absorb(sessionKey: string, ref: string, summary: string): Promise<{ ok: boolean; resultText: string; absorbedTokens?: number }>;
  search(sessionKey: string, query: string): Promise<unknown[]>;
  status(sessionKey: string, messages: PromptTurnLike[]): Promise<{ report: string; state: CompressionState }>;
  loadState(sessionKey: string): Promise<OperitAcpSessionState>;
  core: CompressionCore;
  settings: AdapterSettings;
}

export function createEngine(dataDir?: string): AcpEngine {
  const core = createCore();
  const settings = loadAdapterSettings();
  const persistence = createPersistence(dataDir || settings.dataDir);

  /** per-session 内存锁：同一 session 的 mutation 串行化。 */
  const locks = new Map<string, Promise<void>>();
  async function acquireLock(sid: string): Promise<() => void> {
    const prev = locks.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = () => {
        locks.delete(sid);
        resolve();
      };
    });
    locks.set(sid, prev.then(() => next));
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
    // —— V0.7.1：effective pressure 由 UsageManager 计算（estimate/actual/host 明确区分）。
    // 宿主侧测量（尽力而为；DB 不可读返回 undefined，绝不拖垮请求）。
    const hostTokens = opts.chatId
      ? await getHostUsageAdapter().getCurrentContextTokens(String(opts.chatId))
      : undefined;
    if (hostTokens !== undefined) usageManager.recordHostUsage(hostTokens, opts.hopNo);
    usageManager.recordEstimate(opts.tokenEstimate, opts.hopNo);
    // 若插件曾通过工具链路记录过上游 usage，则注入（见 recordUpstreamUsage 调用点）。
    const eff = usageManager.getEffectiveSnapshot(opts.tokenEstimate);
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
      emergencyThresholdPct: opts.settings.hardLimitPct,
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
        const fingerprint = computeFingerprint(sessionKey, turns, config);
        const stateVersion = loaded.hostMetadata.stateVersion ?? 0;
        // 命中缓存：同 fingerprint + 同 stateVersion → 直接返回缓存投影。
        const cachedProj = estimateCache.get(sessionKey);
        if (cachedProj && cachedProj.fingerprint === fingerprint && cachedProj.stateVersion === stateVersion) {
          return cachedProj.projection;
        }
        // 克隆状态：绝不动持久化状态（估算侧只读）。kernelState 为纯 JSON，JSON 深拷贝安全。
        const workState = JSON.parse(JSON.stringify(loaded.kernelState)) as CompressionState;
        const mapping = promptTurnsToCoreMessages(turns);
        mapping.messages = stripOldAnchorMessages(mapping.messages) as CoreMessage[];
        const coveredIds = collectCoveredMessageIds(workState);
        const tokenEstimate = estimateProjectionTokens(mapping.messages, coveredIds);
        // 复用发送链路同款 Config / 同款 kernel 折叠：已形成 block 会被识别并投影为摘要占位。
        const turn = core.processTurn({
          messages: mapping.messages,
          state: workState,
          config,
          tokenCount: tokenEstimate,
          renderTags: "none",
        });
        let projected = coreMessagesToPromptTurns(turn.messages, mapping.byKey);
        if (settings.hideConsumedCompressCalls && turn.state.blocks.length > 0) {
          try { projected = coreMessagesToPromptTurns(kernelHideConsumedCompressCalls(turn.state, turn.messages).messages, mapping.byKey); } catch { /* noop */ }
        }
        const capped = capProjectionSize(projected, { keepChars: 2000, maxRecent: 3, totalBudgetChars: 200_000 });
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
            kernelShouldInject: false,
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
          // nudge 必须最终进入实际发送的 preparedHistory（文档第八节：nudge 是 ephemeral，
          // 不能因为 stage2 复用缓存而丢失前一个 Hop 的 nudge——本 Hop 重新决策注入）。
          let stage2NudgeText: string | undefined;
          if (stage2Pressure.pressure.allowInject && settings.nudgeEnabled) {
            stage2NudgeText = buildNudgeTextFromReason(stage2Pressure.pressure.decisionReason, stage2Level);
            finalPrepared.push({ kind: "SYSTEM", content: stage2NudgeText, metadata: { acpNudge: true, acpNudgeLevel: stage2Level } });
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
          return { preparedHistory: finalPrepared as PromptTurnLike[], fingerprint: fp, state: cached.kernelState, nudgeText: stage2NudgeText };
        }
        const config = resolveKernelConfig(settings);
        const fingerprint = computeFingerprint(sessionKey, turns, config);

        const cached = await persistence.load(sessionKey);
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
            kernelShouldInject: false,
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
          let cacheNudgeText: string | undefined;
          if (cachePressure.pressure.allowInject && settings.nudgeEnabled) {
            cacheNudgeText = buildNudgeTextFromReason(cachePressure.pressure.decisionReason, cacheLevel);
            cacheFinal.push({ kind: "SYSTEM", content: cacheNudgeText, metadata: { acpNudge: true, acpNudgeLevel: cacheLevel } });
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
          return { preparedHistory: cacheFinal as PromptTurnLike[], fingerprint, state: cached.kernelState, nudgeText: cacheNudgeText };
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
                kernelShouldInject: false,
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
              let incNudgeText: string | undefined;
              if (incPressure.pressure.allowInject && settings.nudgeEnabled) {
                incNudgeText = buildNudgeTextFromReason(incPressure.pressure.decisionReason, incLevel);
                incFinal.push({ kind: "SYSTEM", content: incNudgeText, metadata: { acpNudge: true, acpNudgeLevel: incLevel } });
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
              return { preparedHistory: incFinal as PromptTurnLike[], fingerprint, state: cached.kernelState, nudgeText: incNudgeText };
            }
          }
        }

        const mapping = promptTurnsToCoreMessages(turns);
        // 清理宿主回传的旧锚点残留（避免旧摘要继续出现在 UI/上下文）。
        mapping.messages = stripOldAnchorMessages(mapping.messages) as CoreMessage[];
        const coveredIds = collectCoveredMessageIds(cached.kernelState);
        const tokenEstimate = estimateProjectionTokens(mapping.messages, coveredIds);

        const turn = core.processTurn({
          messages: mapping.messages,
          state: cached.kernelState,
          config,
          tokenCount: tokenEstimate,
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

        // —— Preflight 自动兜底（文档 Phase 5）：request 可能超过模型窗口时，
        //    插件连续压缩多轮，直到 fit 或无可压缩范围，不等模型 compress、不因
        //    一次压缩后仍超限而放弃。摘要带 [ACP 自动折叠] 标记可 decompress 恢复。
        //    V0.4+：来源标记 emergency + 统计。
        let autoFolded = false;
        let emergencyFreedTokens = 0;
        let preflightRounds = 0;
        const prevStats = { ...(cached.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS) };
        const emergency = /EMERGENCY/i.test(turn.nudge?.reason ?? "");
        const maxRounds = 5; // 一次 preflight 最多连续压 5 轮，防失控
        if (emergency) {
          try {
            // 循环压缩：每轮压最多 2 段，重新 processTurn 看 usage，直到 fit 或耗尽
            for (let round = 0; round < maxRounds; round++) {
              // 重新评估当前 usage（基于本轮已建块的状态投影）
              const curTurn = core.processTurn({
                messages: mapping.messages, state: turn.state, config,
                tokenCount: tokenEstimate, renderTags: "none",
              });
              const curEstimate = curTurn.state.stats?.tokensCompressed ?? 0;
              void curEstimate;
              const curNudge = curTurn.nudge;
              const stillEmergency = curNudge && /EMERGENCY/i.test(curNudge.reason ?? "");
              if (!stillEmergency) break; // 已脱离 emergency，停止 preflight
              const ranges = ((curNudge?.compressibleRanges ?? []) as { startRef: string; endRef: string; tokens?: number }[])
                .filter((r) => r.startRef && r.endRef)
                .slice(0, 2);
              if (ranges.length === 0) break; // 无可压缩范围
              const applied = core.applyCompression({
                ranges: ranges.map((r) => {
                  const byRef = (turn.state.messageRefs?.byRef ?? {}) as Record<string, string>;
                  const startMsg = messageForRef(mapping.messages, byRef, mapping.byKey, r.startRef);
                  const endMsg = messageForRef(mapping.messages, byRef, mapping.byKey, r.endRef);
                  const startIdx = startMsg ? mapping.messages.indexOf(startMsg) : -1;
                  const endIdx = endMsg ? mapping.messages.indexOf(endMsg) : -1;
                  const lo = startIdx >= 0 ? startIdx : 0;
                  const hi = endIdx >= startIdx ? endIdx : Math.min(mapping.messages.length - 1, lo + 200);
                  const seg = lo >= 0 ? mapping.messages.slice(lo, hi + 1) : [];
                  const excerpt = seg.length > 0 ? buildDeterministicSummary(seg) : "";
                  const summary = excerpt.length > 0
                    ? `[ACP 自动折叠] 早期 ${seg.length} 条消息的压缩摘要（需要原文可调用 decompress 恢复）：\n${excerpt}`
                    : `[ACP 自动折叠] 早期 ${Math.max(1, hi - lo + 1)} 条消息因超出上下文窗口上限已被自动折叠压缩，关键信息与结论已尽量保留在摘要中，如需查看原文可随时调用 decompress 工具恢复对应 block。`;
                  return { startRef: r.startRef, endRef: r.endRef, summary, topic: "早期对话（自动折叠）" };
                }),
                messages: mapping.messages,
                state: turn.state,
                config,
              });
              if (applied.result.blocksCreated > 0) {
                turn.state = applied.state;
                autoFolded = true;
                emergencyFreedTokens += applied.result.tokensCompressed;
                preflightRounds++;
              } else {
                break; // 本段无法再压
              }
            }
          } catch { /* 自动兜底失败不影响主流程（仍走 nudge 提示） */ }
          // 记录 preflight 轮数（trace 诊断用）
          if (autoFolded) {
            try { console.log(`[acp] preflight rounds=${preflightRounds} freed=${emergencyFreedTokens}`); } catch { /* noop */ }
          }
        }

        if (autoFolded) {
          // 压缩成功：重新 processTurn 让投影含占位；重置 nudge 状态
          const turn2 = core.processTurn({ messages: mapping.messages, state: turn.state, config, tokenCount: tokenEstimate, renderTags: "none" });
          projectedMessages = turn2.messages;
          if (settings.hideConsumedCompressCalls && turn2.state.blocks.length > 0) {
            try { projectedMessages = kernelHideConsumedCompressCalls(turn2.state, turn2.messages).messages; } catch { /* noop */ }
          }
          const projTurns2 = coreMessagesToPromptTurns(projectedMessages, mapping.byKey);
          // 覆盖投影与状态
          projectedTurns.length = 0;
          projectedTurns.push(...projTurns2);
          turn.state = turn2.state;
          // —— 压缩结果可视化：自动折叠是插件静默行为，追加一条可见说明，
          //    让模型感知压缩发生（任务执行中屏幕会呈现），对齐 billion-context
          //    的"压缩完成"反馈；内容为干净中文、无内部标签。
          const newBlocks = turn2.state.blocks.length - cached.kernelState.blocks.length;
          if (newBlocks > 0) {
            const tokensFreed = (turn2.state.stats?.tokensCompressed ?? 0) - (cached.kernelState.stats?.tokensCompressed ?? 0);
            projectedTurns.push({
              kind: "SYSTEM",
              content: `上下文压缩完成：已将 ${newBlocks} 段较早的对话折叠为摘要，释放约 ${tokensFreed} tokens 空间。如需查看被压缩的原文可调用 decompress。`,
              metadata: { acpFoldNotice: true },
            });
          }
        }

        // —— V0.7.1：UsageManager 前置创建（emergency credit 与 effective pressure 共用）。
        // —— V0.7.3：统一走 collectAndEvaluatePressure（usage sampling + pressure + ledger 一体化，
        //   full/incremental/cache/stage2 四路径同一条 pressure 链）。
        const hopNo = (((cached.hostMetadata.usageState as UsageManagerState | undefined)?.lastHop) ?? 0) + 1; // V0.7.2 per-hop 计数
        const nextStats: AcpRuntimeStats = { ...prevStats };
        const newBlockIds = turn.state.blocks.filter((b) => !cached.kernelState.blocks.some((pb) => pb.blockId === b.blockId)).map((b) => b.blockId);
        if (autoFolded && newBlockIds.length > 0) {
          nextStats.emergencyTriggered += 1;
          nextStats.emergencySavedTokens += emergencyFreedTokens;
          nextStats.lastCompressSource = "emergency";
          nextStats.lastCompressAt = Date.now();
          // ACP Trace：紧急兜底折叠
          chatTrace(chatId, {
            type: "emergency",
            detail: { blocks: newBlockIds.length, tokens: emergencyFreedTokens },
          });
          // V0.4.1 usage credit：压缩完成当轮 usage 为基准，credit 内免打扰。
          // V0.7.1 修复：基准必须取"压缩后投影低位"，而非压缩前全量 tokenEstimate。
          //   根因：emergency 压缩发生在 tokenEstimate 计算之后，tokenEstimate 仍是
          //   压缩前全量估算（实测某会话 267,446），而压缩后窗口仅 2.2万~15.4万，
          //   于是 credit 判定 `creditBase+30k - tokenEstimate` 恒 > 0 → 永久免打扰，
          //   导致上下文涨到几百万 token 也无任何 nudge（另一会话实测 6.2 亿 token 全程静默）。
          const postCovered = collectCoveredMessageIds(turn.state);
          const postEstimate = estimateProjectionTokens(projectedMessages, postCovered);
          nextStats.creditBaseToken = Math.min(tokenEstimate, postEstimate) || tokenEstimate;
          nextStats.creditRemaining = settings.usageCreditTokens;
          // —— V0.7.1：compression credit 独立字段（不再兼任 creditBaseToken；折叠量入 credit）。
          //   实际 credit 发放统一在下方 um2（collectAndEvaluatePressure 返回的 usageManager）。
        }
        // nudge 状态机（Adapter 层 Continuous Pressure Controller）：V0.7
        //  - 取消 kernelShouldInject 作为硬总门，只作辅助 signal
        //  - effective pressure：usage 缺失/为0 用 estimate 兜底
        //  - cooldown/credit 只抑制 gentle；strong/emergency bypass
        //  - hostEscalationFloor：kernel 沉默区 Adapter 自接管
        //  - epoch 无限连续；compression baseline 记录
        // —— V0.7.3：统一 pressure 链（与 stage2/cache/incremental 完全一致）。
        const prevNudgeState = cached.hostMetadata.acpNudge ?? {};
        const { pressure, eff, pressurePct, usageManager: um2 } = await collectAndEvaluatePressure({
          sessionKey, chatId,
          tokenEstimate,
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
        // emergency 已发生的 credit 发放要并入 um2（collectAndEvaluatePressure 内部新建了
        // 自己的 usageManager，但 credit 已通过 nextStats.creditBaseToken 传递；
        // 为避免丢失 emergency credit，把 usageManager 的 credit 合并到 um2）。
        if (autoFolded && newBlockIds.length > 0) {
          try { um2.applyCompressionCredit(emergencyFreedTokens); } catch { /* noop */ }
        }
        const nextNudgeState: Record<string, unknown> = {
          ...pressure.nextNudgeState,
          // 持久化 epoch 到 acpNudge（跨轮/跨 VM 恢复压力档位）
          ...(pressure.nextEpoch ? { acpEpoch: pressure.nextEpoch } : {}),
        };

        // nudge 档位：pressure controller 输出（无注入时按 usage 兜底算档位供 stats）
        const level: NudgeLevel = pressure.level ??
          (emergency ? "emergency"
            : pressurePct >= settings.strongThresholdPct ? "strong"
            : pressurePct >= settings.gentleThresholdPct ? "gentle"
            : "gentle");

        // nudge 仅当 controller 允许时注入（SYSTEM 消息追加；UI 不渲染成新用户消息）。
        let nudgeText: string | undefined;
        if (pressure.allowInject && settings.nudgeEnabled) {
          nudgeText = buildNudgeText(turn.nudge!, level);
          // V0.6 Phase3.1：从持久化候选读取（检测已在 project 内与 nudge 解耦恒执行）。
          //    只消费候选，不在此处重新检测。文案提供可操作 ref（与 absorb 工具兼容）。
          const active = getActiveAbsorbCandidates(nextAbsorbCandidates);
          if (active.length > 0) {
            const lines = active.slice(0, 3).map((c) => `- ref=${c.ref} tool=${c.tool} size=${c.chars}`);
            nudgeText += `\n检测到可释放的大型工具输出。可吸收候选：\n${lines.join("\n")}${active.length > 3 ? `\n- 及另外 ${active.length - 3} 条` : ""}\n如果这些内容已被消费且后续不需要原文，请调用 absorb(ref="...", summary="...") 释放上下文空间。`;
          }
          projectedTurns.push({ kind: "SYSTEM", content: nudgeText, metadata: { acpNudge: true, acpNudgeLevel: level } });
          nextStats.nudgeIssued += 1;
          if (level === "gentle") nextStats.gentleNudges += 1;
          else if (level === "strong") nextStats.strongNudges += 1;
          else nextStats.emergencyNudges += 1;
        }

        // 裁剪投影输出体量（防宿主主线程解析超大 JSON 卡死——总预算 200K）。
        const cappedTurns = capProjectionSize(projectedTurns, { keepChars: 2000, maxRecent: 3, totalBudgetChars: 200_000 });

        const nextState: OperitAcpSessionState = {
          adapterStateVersion: cached.adapterStateVersion,
          kernelState: turn.state,
          hostMetadata: {
            ...cached.hostMetadata,
            lastProjectionFingerprint: fingerprint,
            toolLoopCoverage: "main-request-only",
            lastUpdatedAt: Date.now(),
            lastTokenEstimate: tokenEstimate,
            // V0.7.2：记录真实 chatId（供 applyCompression 显式查询 host DB，禁止 split 推导）。
            ...(chatId ? { lastChatId: String(chatId) } : {}),
            acpNudge: nextNudgeState,
            runtimeStats: nextStats,
            // V0.7.1：usage 事实持久化（estimate/actual/host/compressionCredit，per-session）
            usageState: um2.snapshot(),
            absorbCandidates: nextAbsorbCandidates,
            blockSources: {
              ...(cached.hostMetadata.blockSources ?? {}),
              // 新 emergency block 标记来源；保留历史标记。
              ...(autoFolded && newBlockIds.length > 0
                ? Object.fromEntries(newBlockIds.map((id) => [id, "emergency" as const]))
                : {}),
            },
          },
        };
        // 写内存投影缓存 + raw turns 缓存（save 剥离不落盘）。
        cacheSetLimited(projectionCache, sessionKey, { fingerprint, stateVersion, projection: cappedTurns });
        cacheSetLimited(rawTurnsCache, sessionKey, turns);
        nextState.lastRawTurns = turns;
        await persistence.save(sessionKey, nextState);
        // 持久化最近一轮 raw turns（跨 VM 供 compress/absorb 锚定 refs；不裁剪）。
        await persistence.saveRawTurns(sessionKey, turns);

        try {
          const active = turn.state.blocks.filter((b) => b.active).length;
          const nudgeReason = turn.nudge?.reason ? turn.nudge.reason.slice(0, 120) : "(kernel:no-nudge)";
          const gateInfo = `allow=${pressure.allowInject ? 1 : 0} kShould=${turn.nudge?.shouldInject ? 1 : 0} reason=${pressure.decisionReason} eff=${Math.round(pressurePct * 100)}% src=${eff.source}`;
          const st = nextStats;
          console.log(`[acp] project stage=${hookStage} chat=${chatId ? String(chatId).slice(0, 8) : "-"} sub=${isSubTask ? 1 : 0} fp=${fingerprint.slice(0, 12)} raw=${turns.length} proj=${cappedTurns.length} blocks=${active}/${turn.state.blocks.length} tok=${tokenEstimate} saved=${(cached.kernelState.stats?.tokensCompressed ?? 0) - (turn.state.stats?.tokensCompressed ?? 0)} nudge=${gateInfo} stats={n:${st.nudgeIssued},m:${st.compressSucceeded},e:${st.emergencyTriggered}} ${nudgeReason}`);
          // ACP Trace：投影事件（含 pressure 决策原因 + V0.7.1 多源 token 指标）
          chatTrace(chatId, {
            type: "project", stage: hookStage,
            detail: {
              hop: hopNo,
              raw: turns.length, proj: cappedTurns.length, blocks: turn.state.blocks.length,
              tok: tokenEstimate,
              actual: eff.actualTokens,
              host: eff.hostTokens,
              credit: eff.compressionCredit,
              effective: eff.effectiveTokens,
              effPct: Math.round(pressurePct * 100),
              level, nudgeAllow: pressure.allowInject, reason: pressure.decisionReason,
              source: eff.source, confidence: eff.confidence,
              emergency: autoFolded,
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
        return { preparedHistory: cappedTurns, fingerprint, nudgeText, state: turn.state };
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
        const mapping = promptTurnsToCoreMessages(rawTurns as PromptTurnLike[]);
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
            runtimeStats: nextStats,
            ...(usageStateForSave ? { usageState: usageStateForSave } : {}),
            blockSources: {
              ...(loaded.hostMetadata.blockSources ?? {}),
              ...(newBlockIds.length > 0
                ? Object.fromEntries(newBlockIds.map((id) => [id, "model" as const]))
                : {}),
            },
          },
        });
        projectionCache.delete(sessionKey); estimateCache.delete(sessionKey);
        return {
          state: applied.state,
          blocksCreated: applied.result.blocksCreated,
          tokensCompressed: applied.result.tokensCompressed,
          errors: applied.result.errors,
          warnings: applied.result.warnings,
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

    async absorb(sessionKey, ref, summary) {
      const release = await acquireLock(sessionKey);
      try {
        const config = resolveKernelConfig(settings);
        const loaded = await persistence.load(sessionKey);
        const rawTurns = (rawTurnsCache.get(sessionKey) ?? loaded.lastRawTurns ?? await persistence.loadRawTurns(sessionKey)) as PromptTurnLike[];
        const mapping = promptTurnsToCoreMessages(rawTurns);
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
  };
}

/** NudgeLevel 别名（来自 pressure controller）。 */
type NudgeLevel = PressureNudgeLevel;

/**
 * V0.7.3：buildNudgeTextFromReason —— stage2/cache/incremental 路径的 nudge 文案。
 * 这些路径没有 kernel nudge（turn.nudge 未计算），只有 pressure 决策；
 * 用 pressure 的档位 + reason 生成同款文案（与 buildNudgeText 同模板）。
 */
function buildNudgeTextFromReason(reason: string, level: NudgeLevel): string {
  const lines: string[] = [];
  if (level === "gentle") {
    lines.push("[ACP] 上下文使用率已接近阈值，请注意近期对话的上下文占用，建议在合适时机压缩已消费的旧内容。");
    lines.push("可选工具：compress（压缩一段范围）、absorb（吸收单条巨型输出）、decompress（恢复）、search_context（搜索）、acp_status（查状态/范围）。");
  } else if (level === "strong") {
    lines.push("[ACP] 上下文使用率已较高，请立即压缩已消费的旧内容以释放空间。");
    lines.push("可选工具：compress（压缩一段范围）、absorb（吸收单条巨型输出）、decompress（恢复）、search_context（搜索）、acp_status（查状态/范围）。");
  } else {
    lines.push("[ACP] 上下文已接近硬上限，请立即调用 compress 压缩最旧、已消费的内容。若本提示持续出现，压缩是继续任务的前提，不要忽略。");
  }
  if (reason) lines.push(`（pressure: ${reason}）`);
  return lines.join("\n");
}

function buildNudgeText(nudge: { reason: string; compressibleRanges: { startRef: string; endRef: string; tokens: number }[] }, level: NudgeLevel): string {
  // 固定模板（不嵌入动态 token 数/百分比——动态内容破坏 LLM 缓存前缀命中率）。
  // 三档递进文案：gentle = 提醒准备；strong = 要求主动压缩；emergency = 必须压缩。
  const lines: string[] = [];
  if (level === "gentle") {
    lines.push("[ACP] 上下文使用率已接近阈值。请在合适时机压缩已消费的旧内容：可先调用 acp_status 查看可压缩范围，再调用 compress 处理已完成且不再需要原文的部分。");
  } else if (level === "strong") {
    lines.push("[ACP] 上下文使用率已超过阈值。请直接调用 compress 工具压缩已消费的旧内容以降低上下文占用，无需询问用户、无需等待批准、不要中断当前任务。");
  } else {
    lines.push("[ACP] 上下文已接近硬上限，请立即调用 compress 压缩最旧、已消费的内容。若本提示持续出现，压缩是继续任务的前提，不要忽略。");
  }
  if (nudge.compressibleRanges.length > 0) {
    const top = [...nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
    lines.push(`建议压缩范围：${top.startRef}..${top.endRef}（调用 compress）。`);
    lines.push(`可选工具：acp_status（查状态/范围）、absorb（吸收单条巨型输出）、decompress（恢复）、search_context（搜索）。`);
  }
  return lines.join("\n");
}