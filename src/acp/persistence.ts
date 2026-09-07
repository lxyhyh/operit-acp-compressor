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

export interface OperitAcpSessionState {
  adapterStateVersion: number;
  kernelState: CompressionState;
  hostMetadata: {
    lastProjectionFingerprint?: string;
    toolLoopCoverage: "full" | "main-request-only" | "unknown";
    lastUpdatedAt: number;
    lastTokenEstimate?: number;
    stateVersion?: number;
    acpNudge?: Record<string, unknown>;
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
      // 不持久化 lastRawTurns（完整 raw history 副本，占体积且随会话膨胀）。
      const { lastRawTurns: _omit, ...persistState } = state;
      const content = JSON.stringify(persistState);
      try {
        await Tools.Files.write(tmpPath, content, false, "android");
        await Tools.Files.move(tmpPath, path, "android");
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