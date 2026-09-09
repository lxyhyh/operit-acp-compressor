/**
 * acp/persistence.ts — CompressionState 持久化。
 *
 * 原则：
 * - App/ToolPkg runtime 重启后 state 可恢复（per-session 文件 + 原子写）。
 * - 只保存 kernel CompressionState + host metadata，不复制 raw chat history。
 * - 状态目录 {DATA_DIR}/acp-state/（与旧版 sessions/ 区分，避免格式混写）。
 */

import type { CompressionState } from "acp-kernel";
import { createInitialState, isSummaryMessageId } from "acp-kernel";
import { hashString } from "./messages";
import { STATE_DIR } from "./paths";
import type { AbsorbCandidate } from "./absorb-candidates";

export interface AcpRuntimeStats {
  /** 发出 nudge 的次数（分档计数）。 */
  nudgeIssued: number;
  gentleNudges: number;
  strongNudges: number;
  emergencyNudges: number;
  /** 模型实际调用 compress 的次数（无论成败）。 */
  compressCalled: number;
  /** compress 成功（建块 >0）次数。 */
  compressSucceeded: number;
  /** 模型 compress 失败次数。 */
  compressFailed: number;
  /** 自动兜底折叠次数（safety-emergency 最终兜底）。 */
  emergencyTriggered: number;
  /** 自动兜底释放 token。 */
  emergencySavedTokens: number;
  /** 模型主动压缩释放 token。 */
  modelSavedTokens: number;
  /** nudge 后经历轮数（用于算 ignore 率）。 */
  nudgeIgnored: number;
  /** 最近一次 compress 来源（model/emergency）。 */
  lastCompressSource?: "model" | "emergency";
  lastCompressAt?: number;
  /** V0.4.1 usage credit：compress 后 N token 内免除 nudge（防刚压缩又提醒）。 */
  creditUntilToken?: number;
  /** 上次 credit 发放时的 context token 数（用于判断 credit 是否已消费完）。 */
  creditBaseToken?: number;
  /** credit 剩余 token（估算：creditBaseToken + 增长 - 当前）。 */
  creditRemaining?: number;
}

export const EMPTY_RUNTIME_STATS: AcpRuntimeStats = {
  nudgeIssued: 0,
  gentleNudges: 0,
  strongNudges: 0,
  emergencyNudges: 0,
  compressCalled: 0,
  compressSucceeded: 0,
  compressFailed: 0,
  emergencyTriggered: 0,
  emergencySavedTokens: 0,
  modelSavedTokens: 0,
  nudgeIgnored: 0,
};

export interface OperitAcpSessionState {
  adapterStateVersion: number;
  kernelState: CompressionState;
  hostMetadata: {
    lastProjectionFingerprint?: string;
    /** V0.7.13-P3-I.6：发送时最终投影（跨 runtime 供 estimate 前缀复用，静态计数对齐）。 */
    lastProjection?: Array<{ kind: string; content: string; toolName?: string; metadata?: Record<string, unknown> | null }>;
    toolLoopCoverage: "full" | "main-request-only" | "unknown";
    lastUpdatedAt: number;
    lastTokenEstimate?: number;
    stateVersion?: number;
    acpNudge?: Record<string, unknown>;
    /** V0.4：运行时统计（nudge/compress/emergency 全链路）。 */
    runtimeStats?: AcpRuntimeStats;
    /** V0.7.1：usage 事实（estimate/actual/host + compressionCredit，per-session）。 */
    usageState?: {
      lastActualTokens?: number;
      lastActualAt?: number;
      lastHostTokens?: number;
      lastHostAt?: number;
      lastEstimateTokens?: number;
      compressionCreditTokens: number;
      lastHop: number;
      /** V0.7.2：hop ledger（最近 N 条 per-hop token 事实，审计用）。 */
      hopLedger?: Array<{
        hop: number;
        estimateTokens?: number;
        actualTokens?: number;
        hostTokens?: number;
        compressionCredit: number;
        effectiveTokens: number;
        source: string;
        confidence: string;
        at: number;
      }>;
    };
    /** V0.7.2：最近一次真实 chatId（hook 链路记录；供 applyCompression 按真实 chatId 查 host DB）。 */
    lastChatId?: string;
    /** V0.4：block 来源映射 blockId → model | emergency（搜索/统计用）。 */
    blockSources?: Record<string, "model" | "emergency">;
    /** V0.7.9：identity-bridge 持久化状态（toolAlignments + seq；跨 VM 共享）。
     *  结构见 src/identity-bridge.ts IdentityBridgeState。 */
    identityBridge?: { toolAlignments: Record<string, { seq: number; toolName: string; callSig: string; resultSig: string; lastHop: number }[]>; toolSeqCounter: number };
    /** V0.6 Phase3.1：巨型工具输出 absorb 候选（持久化，跨 Hop 幂等）。 */
    absorbCandidates?: AbsorbCandidate[];
  };
  /** 仅内存载体（hook 最近一次投影的原始 turns），save 不落盘。 */
  lastRawTurns?: Array<{ kind: string; content: string; toolName?: string; metadata?: Record<string, unknown> | null }>;
}

export const ADAPTER_STATE_VERSION = 2;

const STATE_PREFIX = "state_";

/** 将 session key 转为安全文件名。 */
export function sessionKeyToFile(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const hash = hashString(sessionKey).slice(0, 12);
  return `${STATE_PREFIX}${safe}_${hash}.json`;
}

/** 用 kernel 的 createInitialState 填充缺失字段（前向兼容加载）。 */
export function mergeInitialState(parsed: CompressionState): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: Array.isArray(parsed.blocks) ? parsed.blocks : fresh.blocks,
    messageRefs: parsed.messageRefs && parsed.messageRefs.byRaw && parsed.messageRefs.byRef
      ? parsed.messageRefs
      : fresh.messageRefs,
    tokenSnapshot: parsed.tokenSnapshot && typeof parsed.tokenSnapshot === "object"
      ? parsed.tokenSnapshot
      : (fresh.tokenSnapshot ?? {}),
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
    absorbed: Array.isArray(parsed.absorbed) ? parsed.absorbed : (fresh.absorbed ?? []),
    nextBlockId: typeof parsed.nextBlockId === "number" ? parsed.nextBlockId : fresh.nextBlockId,
    nextRunId: typeof parsed.nextRunId === "number" ? parsed.nextRunId : fresh.nextRunId,
  };
}

export interface Persistence {
  statePathFor(sessionKey: string): string;
  load(sessionKey: string): Promise<OperitAcpSessionState>;
  save(sessionKey: string, state: OperitAcpSessionState): Promise<void>;
  appendLog(line: string): Promise<void>;
  /** 保存最近一轮投影的原始 turns（供 compress/absorb 跨 VM 锚定 refs）。 */
  saveRawTurns(sessionKey: string, turns: unknown[]): Promise<void>;
  /** 读取最近保存的原始 turns（无则 []）。 */
  loadRawTurns(sessionKey: string): Promise<unknown[]>;
}

/** 清理宿主可能回传的旧锚点残留消息（[Compressed conversation section] / summary id）。 */
export function stripOldAnchorMessages(
  messages: Array<{ id?: string; text?: string }>,
): Array<{ id?: string; text?: string }> {
  const ANCHOR_MARKER = "[Compressed conversation section]";
  return messages.filter(
    (m) => !(m.id && isSummaryMessageId(m.id)) && !String(m.text || "").startsWith(ANCHOR_MARKER)
  );
}

/** 构造 hostMetadata 默认值（load 缺失时 / stale-merge 时使用）。 */
function freshHostMeta(): OperitAcpSessionState["hostMetadata"] {
  return { toolLoopCoverage: "unknown", lastUpdatedAt: Date.now() };
}

export function createPersistence(dataDir?: string): Persistence {
  const stateDir = dataDir ? `${dataDir}/acp-state` : STATE_DIR;
  const logFile = stateDir.replace(/\/state$/, "") + "/logs/acp.log";

  // 内存缓存（按文件路径 + mtime）：避免每次 hook 全量读大 state。
  const globalCache = (globalThis as Record<string, unknown>).__acpLoadCacheV2 as
    | Map<string, { mtime: number; state: OperitAcpSessionState }>
    | undefined;
  const cache = globalCache ?? new Map<string, { mtime: number; state: OperitAcpSessionState }>();
  if (!(globalThis as Record<string, unknown>).__acpLoadCacheV2) {
    (globalThis as Record<string, unknown>).__acpLoadCacheV2 = cache;
  }

  async function ensureDirs(): Promise<void> {
    try {
      await Tools.Files.mkdir(stateDir, true, "android");
      await Tools.Files.mkdir(stateDir.replace(/\/state$/, "") + "/logs", true, "android");
    } catch {
      // 目录可能已存在；忽略
    }
  }

  return {
    statePathFor(sessionKey: string): string {
      return `${stateDir}/${sessionKeyToFile(sessionKey)}`;
    },

    async load(sessionKey: string): Promise<OperitAcpSessionState> {
      await ensureDirs();
      const path = `${stateDir}/${sessionKeyToFile(sessionKey)}`;
      const fresh: OperitAcpSessionState = {
        adapterStateVersion: ADAPTER_STATE_VERSION,
        kernelState: createInitialState(),
        hostMetadata: { toolLoopCoverage: "unknown", lastUpdatedAt: Date.now() },
      };
      try {
        let mtime = 0;
        try {
          const info = Tools.Files.info(path) as unknown as { mtimeMs?: number } | undefined;
          mtime = info?.mtimeMs ?? 0;
          const cached = cache.get(path);
          if (cached && cached.mtime === mtime) return cached.state;
        } catch { /* info 不可用：跳过缓存 */ }
        const res = await Tools.Files.read(path);
        const content = (res && res.content) as string | undefined;
        if (!content) return fresh;
        const parsed = JSON.parse(content);
        if (!parsed || !parsed.kernelState) return fresh;
        const state: OperitAcpSessionState = {
          adapterStateVersion: parsed.adapterStateVersion ?? ADAPTER_STATE_VERSION,
          kernelState: mergeInitialState(parsed.kernelState),
          hostMetadata: { ...fresh.hostMetadata, ...(parsed.hostMetadata ?? {}) },
          lastRawTurns: Array.isArray(parsed.lastRawTurns) ? parsed.lastRawTurns : undefined,
        };
        cache.set(path, { mtime, state });
        return state;
      } catch {
        return fresh;
      }
    },

    async save(sessionKey: string, state: OperitAcpSessionState): Promise<void> {
      await ensureDirs();
      const path = `${stateDir}/${sessionKeyToFile(sessionKey)}`;
      const tmpPath = `${path}.tmp`;

      // —— V0.7.13-P3-D：stale-write monotonic guard。
      //   防止旧 kernel snapshot（如 STAGE2/CACHE-HIT/INCREMENTAL 误写的 V1）
      //   回滚 authoritative snapshot（FULL 的 V2）。
      //   规则：incoming.stateVersion < current.stateVersion → 禁止 kernelState 回滚，
      //   但允许 hostMetadata 前向合并（usage/nudge/stats 属于决策元数据，非权威 kernel）。
      const incomingVersion = state.hostMetadata.stateVersion ?? 0;
      let currentVersion = 0;
      try {
        const info = Tools.Files.info(path) as unknown as { mtimeMs?: number } | undefined;
        const cur = info && (cache.get(path)?.mtime === info.mtimeMs) ? cache.get(path)?.state : undefined;
        if (!cur) {
          const res = await Tools.Files.read(path);
          const content = (res && res.content) as string | undefined;
          if (content) {
            const parsed = JSON.parse(content);
            currentVersion = (parsed?.hostMetadata?.stateVersion ?? 0);
          }
        } else {
          currentVersion = cur.hostMetadata.stateVersion ?? 0;
        }
      } catch {
        // 读失败不阻断；guard 尽力而为（最坏等于无 guard，但绝不 crash）。
      }

      // 不持久化 lastRawTurns（完整 raw history 副本，占体积且随会话膨胀）。
      const { lastRawTurns: _omit, ...persistState } = state;
      if (incomingVersion < currentVersion) {
        // —— stale kernel snapshot：合并 hostMetadata（新 usage/nudge/stats），
        //   但绝不回滚 kernelState。
        try {
          const existingRes = await Tools.Files.read(path);
          const existingContent = (existingRes && existingRes.content) as string | undefined;
          const existingParsed = existingContent ? JSON.parse(existingContent) : undefined;
          const existing: OperitAcpSessionState = existingParsed && existingParsed.kernelState
            ? {
                adapterStateVersion: existingParsed.adapterStateVersion ?? ADAPTER_STATE_VERSION,
                kernelState: mergeInitialState(existingParsed.kernelState),
                hostMetadata: { ...freshHostMeta(), ...(existingParsed.hostMetadata ?? {}) },
              }
            : { adapterStateVersion: ADAPTER_STATE_VERSION, kernelState: createInitialState(), hostMetadata: freshHostMeta() };
          const merged: OperitAcpSessionState = {
            adapterStateVersion: existing.adapterStateVersion,
            kernelState: existing.kernelState, // 保留 authoritative V2
            hostMetadata: {
              ...existing.hostMetadata,
              ...persistState.hostMetadata,
              stateVersion: existing.hostMetadata.stateVersion ?? currentVersion, // 不降级
            },
          };
          const mergedContent = JSON.stringify(merged);
          await Tools.Files.write(tmpPath, mergedContent, false, "android");
          await Tools.Files.move(tmpPath, path, "android");
          cache.set(path, { mtime: (Tools.Files.info(path) as unknown as { mtimeMs?: number })?.mtimeMs ?? 0, state: merged });
          try {
            console.log(`[acp] [stale-write-blocked] session=${sessionKey} currentVersion=${currentVersion} incomingVersion=${incomingVersion} source=persistence-guard`);
          } catch { /* noop */ }
        } catch {
          // 合并失败则完全跳过写入（宁可丢 metadata 更新，也不回滚 kernelState）
        }
        return;
      }

      const content = JSON.stringify(persistState);
      try {
        await Tools.Files.write(tmpPath, content, false, "android");
        await Tools.Files.move(tmpPath, path, "android");
        // —— V0.7.13-P3-D.1：save 成功后必须同步内存 cache。
        //   否则同一 engine 实例内后续 load() 会命中旧缓存（mtime 未变）
        //   返回 stale state（compress 建块后 acp_status 仍报 0 blocks）。
        try {
          const newInfo = Tools.Files.info(path) as unknown as { mtimeMs?: number } | undefined;
          cache.set(path, { mtime: newInfo?.mtimeMs ?? 0, state });
        } catch { /* 缓存更新失败不影响主流程 */ }
      } catch {
        try {
          await Tools.Files.deleteFile(tmpPath, false, "android");
        } catch {
          // ignore
        }
        throw new Error(`ACP state save failed for session ${sessionKey}`);
      }
    },

    async appendLog(line: string): Promise<void> {
      try {
        await Tools.Files.write(logFile, `${new Date().toISOString()} ${line}\n`, true, "android");
      } catch {
        // 日志失败不影响主流程
      }
    },

    async saveRawTurns(sessionKey: string, turns: unknown[]): Promise<void> {
      try {
        const path = `${stateDir}/${sessionKeyToFile(sessionKey).replace(/\.json$/, ".raw.json")}`;
        // 注意：content 必须原样保存——stableKey 基于完整 content hash，
        // 任何裁剪都会导致 refs 无法锚定。文件是 compress 可用性的前提。
        const tmp = `${path}.tmp`;
        await Tools.Files.write(tmp, JSON.stringify(turns), false, "android");
        await Tools.Files.move(tmp, path, "android");
      } catch {
        // raw turns 保存失败不影响主流程（compress 会报"无法锚定"）
      }
    },

    async loadRawTurns(sessionKey: string): Promise<unknown[]> {
      try {
        const path = `${stateDir}/${sessionKeyToFile(sessionKey).replace(/\.json$/, ".raw.json")}`;
        const res = await Tools.Files.read(path);
        const content = (res && res.content) as string | undefined;
        if (!content) return [];
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
  };
}