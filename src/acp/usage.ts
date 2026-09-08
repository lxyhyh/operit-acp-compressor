/**
 * acp/usage.ts — V0.7.1 UsageManager（per-session token 事实管理）。
 *
 * 依据建议文档第 4/6/9 阶段：
 * - 收集 estimate / upstream actual / host 三类样本，per-session 隔离，无 global state。
 * - 维护 compressionCreditTokens 生命周期：压缩成功累加；被真实 usage 消费后清零；
 *   不允许无限累计；不把 creditBaseToken 兼任 lastCompressionContextTokens。
 * - getEffectiveSnapshot() 输出 estimate/actual/host/credit/effective/source/confidence。
 */

import {
  computeEffectiveTokens,
  type TokenConfidence,
  type TokenSnapshot,
} from "./token-source";

export interface UsageManager {
  /** 记录已完成请求的上游真实 usage（provider 归一后）。 */
  recordUpstreamUsage(sample: {
    contextTokens?: number;
    outputTokens?: number;
    hop?: number;
  }): void;
  /** 记录宿主侧测量（currentWindowSize）。 */
  recordHostUsage(tokens: number, hop?: number): void;
  /** 记录发送前预测 estimate。 */
  recordEstimate(tokens: number, hop?: number): void;
  /** 最近一次真实的 upstream actual（无则 undefined）。 */
  getLatestActual(): number | undefined;
  /** 最近一次宿主测量。 */
  getLatestHost(): number | undefined;
  /** 当前 compression credit（压缩导致旧 usage 的修正值）。 */
  getCompressionCredit(): number;
  /** 压缩成功：累加 credit = foldedTokens。 */
  applyCompressionCredit(tokens: number): void;
  /** 压缩后由真实 usage 消费 credit（返回消费后的剩余）。 */
  consumeCompressionCredit(): number;
  clearCompressionCredit(): void;
  /** 计算 effective snapshot（estimate 参与求 max，绝不冒充 actual）。 */
  getEffectiveSnapshot(estimatedTokens: number): TokenSnapshot;
  /** 最近一次样本的 hop 号。 */
  getLastHop(): number;
  /** 取当前快照用于 trace / 持久化。 */
  snapshot(): {
    lastActualTokens?: number;
    lastHostTokens?: number;
    compressionCreditTokens: number;
    lastHop: number;
  };
}

export interface UsageManagerState {
  lastActualTokens?: number;
  lastActualAt?: number;
  lastHostTokens?: number;
  lastHostAt?: number;
  compressionCreditTokens: number;
  lastHop: number;
}

export function createUsageManager(
  initialState?: Partial<UsageManagerState>,
): UsageManager {
  const s: UsageManagerState = {
    lastActualTokens: initialState?.lastActualTokens,
    lastActualAt: initialState?.lastActualAt,
    lastHostTokens: initialState?.lastHostTokens,
    lastHostAt: initialState?.lastHostAt,
    compressionCreditTokens: initialState?.compressionCreditTokens ?? 0,
    lastHop: initialState?.lastHop ?? 0,
  };

  return {
    recordUpstreamUsage(sample) {
      if (typeof sample.contextTokens === "number" && Number.isFinite(sample.contextTokens) && sample.contextTokens > 0) {
        s.lastActualTokens = sample.contextTokens;
        s.lastActualAt = Date.now();
        s.lastHop = sample.hop ?? s.lastHop;
        // 真实 usage 反映折叠后窗口，消费掉对应 credit（第 9 阶段：已被真实 fold 反映的部分清零）。
        if (s.compressionCreditTokens > 0 && sample.contextTokens < s.compressionCreditTokens) {
          s.compressionCreditTokens = 0;
        } else if (s.compressionCreditTokens > 0) {
          s.compressionCreditTokens = 0;
        }
      }
    },
    recordHostUsage(tokens, hop) {
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
        s.lastHostTokens = tokens;
        s.lastHostAt = Date.now();
        if (hop !== undefined) s.lastHop = Math.max(s.lastHop, hop);
      }
    },
    recordEstimate(tokens, hop) {
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
        if (hop !== undefined) s.lastHop = Math.max(s.lastHop, hop);
      }
    },
    getLatestActual: () => s.lastActualTokens,
    getLatestHost: () => s.lastHostTokens,
    getCompressionCredit: () => s.compressionCreditTokens,
    applyCompressionCredit(tokens) {
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
        s.compressionCreditTokens += tokens;
      }
    },
    consumeCompressionCredit() {
      const left = s.compressionCreditTokens;
      return left;
    },
    clearCompressionCredit() {
      s.compressionCreditTokens = 0;
    },
    getEffectiveSnapshot(estimatedTokens) {
      return computeEffectiveTokens({
        estimatedTokens,
        actualTokens: s.lastActualTokens,
        hostTokens: s.lastHostTokens,
        compressionCredit: s.compressionCreditTokens,
      });
    },
    getLastHop: () => s.lastHop,
    snapshot: () => ({
      lastActualTokens: s.lastActualTokens,
      lastHostTokens: s.lastHostTokens,
      compressionCreditTokens: s.compressionCreditTokens,
      lastHop: s.lastHop,
    }),
  };
}

/** EMPTY 状态（用于未初始化的 UsageManager 持久化兜底）。 */
export const EMPTY_USAGE_STATE: UsageManagerState = {
  lastActualTokens: undefined,
  lastActualAt: undefined,
  lastHostTokens: undefined,
  lastHostAt: undefined,
  compressionCreditTokens: 0,
  lastHop: 0,
};

export type { TokenConfidence, TokenSnapshot };