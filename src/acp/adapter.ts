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
import { createPersistence, stripOldAnchorMessages, type Persistence, type OperitAcpSessionState } from "./persistence";

/** 投影缓存（globalThis 共享；compress 等 state mutation 后失效）。 */
const projectionCache = (globalThis as Record<string, unknown>).__acpProjectionCacheV2 as
  | Map<string, { fingerprint: string; stateVersion: number; projection: PromptTurnLike[] }>
  | undefined ?? new Map<string, { fingerprint: string; stateVersion: number; projection: PromptTurnLike[] }>();
if (!(globalThis as Record<string, unknown>).__acpProjectionCacheV2) {
  (globalThis as Record<string, unknown>).__acpProjectionCacheV2 = projectionCache;
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

  return {
    core,
    settings,

    /** 估算链路只读投影：与发送链路同款压缩（复用已形成 block），但只读：
     *  克隆状态计算、不持久化、不建块（emergency 兜底仅发送链路做，避免
     *  估算侧静默改状态）、不写 nudge/不注入提示（估算不发给模型）。
     *  估算侧不持锁（只读可并发；避免与发送 mutation 互相等待）。 */
    async estimate(sessionKey, chatId, turns) {
      if (!turns || turns.length === 0) return turns;
      try {
        const config = resolveKernelConfig(settings);
        const loaded = await persistence.load(sessionKey);
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
        //   内容（或原始历史）→ 直接透传，绝不重复 processTurn——否则 kernel
        //   syncBlocks 会因输入不含 block 覆盖的原始消息而 deactivate 已形成块。
        if (hookStage === "before_send_to_model") {
          const cached = await persistence.load(sessionKey);
          return { preparedHistory: turns, fingerprint: computeFingerprint(sessionKey, turns, resolveKernelConfig(settings)), state: cached.kernelState };
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
          if (projected && Array.isArray(projected) && projected.length > 0) {
            return { preparedHistory: projected, fingerprint, state: cached.kernelState };
          }
          // 兜底：无缓存投影（跨 VM / 内存被清）时透传 raw（不破坏请求）。
          return { preparedHistory: turns, fingerprint, state: cached.kernelState };
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
        // —— Emergency 自动兜底（对齐 preflight 设计）：kernel EMERGENCY 且仍无块时，
        //    插件直接用本轮推荐范围 + 抽取摘要自动压缩，不等模型 compress。
        //    保证"发送量封顶"（模型不主动时也有底线），摘要带 [ACP 自动折叠] 标记可 decompress 恢复。
        let autoFolded = false;
        const emergency = /EMERGENCY/i.test(turn.nudge?.reason ?? "");
        if (emergency && turn.state.blocks.length === 0 && turn.nudge?.compressibleRanges && turn.nudge.compressibleRanges.length > 0) {
          try {
            const ranges = (turn.nudge.compressibleRanges as { startRef: string; endRef: string; tokens?: number }[])
              .filter((r) => r.startRef && r.endRef)
              .slice(0, 2); // 每轮最多压 2 段，防一次压太多丢上下文
            if (ranges.length > 0) {
              const applied = core.applyCompression({
                ranges: ranges.map((r) => {
                  // 用范围对应消息做确定性抽取摘要
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
              }
            }
          } catch { /* 自动兜底失败不影响主流程（仍走 nudge 提示） */ }
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
        // nudge 状态机（Adapter 层门控）：达到阈值最多注入一次；压缩/下降后 reset。
        const prevNudgeState = cached.hostMetadata.acpNudge ?? {};
        const prevBlocks = cached.kernelState.blocks.length;
        const curBlocks = turn.state.blocks.length;
        const prevTokenCount = (cached.hostMetadata.lastTokenEstimate as number) ?? 0;
        const nudgeGate = evaluateNudgeGate({
          kernelShouldInject: turn.nudge?.shouldInject === true,
          kernelReason: turn.nudge?.reason ?? "",
          prevNudgeState,
          prevBlocks,
          curBlocks,
          prevTokenCount,
          tokenEstimate,
          nudgeCooldownTurns: settings.nudgeCooldownTurns,
          nudgeCooldownTokens: settings.nudgeCooldownTokens,
        });
        const nextNudgeState = nudgeGate.nextNudgeState;

        // nudge 仅当状态机允许时注入（SYSTEM 消息追加；UI 不渲染成新用户消息）。
        let nudgeText: string | undefined;
        if (nudgeGate.allowInject && settings.nudgeEnabled) {
          nudgeText = buildNudgeText(turn.nudge!);
          projectedTurns.push({ kind: "SYSTEM", content: nudgeText, metadata: { acpNudge: true } });
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
            acpNudge: nextNudgeState,
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
          const gateInfo = `allow=${nudgeGate.allowInject ? 1 : 0} kShould=${turn.nudge?.shouldInject ? 1 : 0}`;
          console.log(`[acp] project stage=${hookStage} chat=${chatId ? String(chatId).slice(0, 8) : "-"} sub=${isSubTask ? 1 : 0} fp=${fingerprint.slice(0, 12)} raw=${turns.length} proj=${cappedTurns.length} blocks=${active}/${turn.state.blocks.length} tok=${tokenEstimate} saved=${(cached.kernelState.stats?.tokensCompressed ?? 0) - (turn.state.stats?.tokensCompressed ?? 0)} nudge=${gateInfo} ${nudgeReason}`);
        } catch { /* noop */ }

        return { preparedHistory: cappedTurns, fingerprint, nudgeText, state: turn.state };
      } finally {
        release();
      }
    },

    async applyCompression(sessionKey, ranges, messages) {
      const release = await acquireLock(sessionKey);
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
        // state mutation 后 stateVersion++ 并让旧投影失效。
        await persistence.save(sessionKey, {
          ...loaded,
          kernelState: applied.state,
          hostMetadata: {
            ...loaded.hostMetadata,
            lastUpdatedAt: Date.now(),
            stateVersion: (loaded.hostMetadata.stateVersion ?? 0) + 1,
            lastProjectionFingerprint: undefined as string | undefined,
          },
        });
        projectionCache.delete(sessionKey);
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
        projectionCache.delete(sessionKey);
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
          },
        });
        projectionCache.delete(sessionKey);
        const record = result.state.absorbed?.slice(-1)[0] as { tokensReclaimed?: number } | undefined;
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
      return { report: JSON.stringify(report), state: loaded.kernelState };
    },

    async loadState(sessionKey) {
      return persistence.load(sessionKey);
    },
  };
}

function buildNudgeText(nudge: { reason: string; compressibleRanges: { startRef: string; endRef: string; tokens: number }[] }): string {
  // 固定模板（不嵌入动态 token 数/百分比——动态内容破坏 LLM 缓存前缀命中率）。
  const lines = [
    "[ACP] 上下文使用率已超过阈值。请直接调用 compress 工具压缩已消费的旧内容以降低上下文占用，无需询问用户、无需等待批准、不要中断当前任务。",
  ];
  if (nudge.compressibleRanges.length > 0) {
    const top = [...nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
    lines.push(`建议压缩范围：${top.startRef}..${top.endRef}（调用 compress）。`);
    lines.push(`可选工具：acp_status（查状态/范围）、decompress（恢复）、search_context（搜索）。`);
  }
  return lines.join("\n");
}

interface NudgeGateInput {
  kernelShouldInject: boolean;
  /** kernel 决策原因（含 EMERGENCY 表示超硬顶，应每轮提醒直到压缩）。 */
  kernelReason: string;
  prevNudgeState: Record<string, unknown>;
  prevBlocks: number;
  curBlocks: number;
  prevTokenCount: number;
  tokenEstimate: number;
  nudgeCooldownTurns: number;
  nudgeCooldownTokens: number;
}
interface NudgeGateResult {
  allowInject: boolean;
  nextNudgeState: Record<string, unknown>;
}

/**
 * Adapter 层 nudge 状态机：idle → pressure → nudge-once → waiting →
 * (compress-success | context-drop | new-cycle) → idle。
 * 规则：kernel 建议注入且未注入过才注入一次；compress 成功/context 明显
 * 下降后 reset；连续无视超过 cooldown 则抑制（不再打扰）。
 */
function evaluateNudgeGate(input: NudgeGateInput): NudgeGateResult {
  const prev = input.prevNudgeState;
  const lastInjectedAt = typeof prev.lastInjectedAt === "number" ? prev.lastInjectedAt : 0;
  const nudgeCount = typeof prev.nudgeCount === "number" ? prev.nudgeCount : 0;
  const lastTokensAtInject = typeof prev.lastTokensAtInject === "number" ? prev.lastTokensAtInject : 0;
  // EMERGENCY（usage 超过硬顶/emergency 阈值）：每轮提醒直到压缩成功或上下文回落。
  // 模型不 compress 时继续提醒（不回退冷却），避免"提醒一次被无视后死锁"。
  const emergency = /EMERGENCY/i.test(input.kernelReason);

  if (input.curBlocks > input.prevBlocks) {
    return { allowInject: false, nextNudgeState: { lastInjectedAt: 0, nudgeCount: 0, lastTokensAtInject: 0 } };
  }
  if (lastInjectedAt > 0 && input.tokenEstimate < lastTokensAtInject * 0.9) {
    return { allowInject: false, nextNudgeState: { lastInjectedAt: 0, nudgeCount: 0, lastTokensAtInject: 0 } };
  }
  if (!input.kernelShouldInject) {
    return { allowInject: false, nextNudgeState: prev };
  }
  if (!emergency && (lastInjectedAt > 0 || nudgeCount >= input.nudgeCooldownTurns)) {
    return { allowInject: false, nextNudgeState: prev };
  }
  if (emergency && lastInjectedAt > 0 && input.tokenEstimate >= lastTokensAtInject * 0.95) {
    // 已是 emergency 且上下文没回落：每轮继续提醒（更新 lastInjectedAt，持续增压）。
    return {
      allowInject: true,
      nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
    };
  }
  return {
    allowInject: true,
    nextNudgeState: {
      lastInjectedAt: Date.now(),
      nudgeCount: nudgeCount + 1,
      lastTokensAtInject: input.tokenEstimate,
    },
  };
}