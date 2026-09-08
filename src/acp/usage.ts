/**
 * acp/usage.ts — V0.7.2 UsageManager（per-session token 事实管理 + hop ledger）。
 *
 * V0.7.2 Actual Usage Closure 修正（ACTUAL-USAGE-CLOSURE-AUDIT）：
 * 1. recordUpstreamUsage 是"Actual 的唯一入口"，但插件没有任何 provider 回调可以
 *    收到真实 usage —— 生产链路中它从未被调用（见 audit 第 1 节）。本文件保持接口，
 *    等待未来宿主暴露 usage hook 时接线；Actual 拿不到就保持 undefined，绝不伪造。
 * 2. Net accounting：收到一次真实 usage 后，credit 只按「usage 超出折叠后窗口」的
 *    部分消费，剩余保留 —— 处理"压缩后 re-request 仍携带 unfolded history"的场景
 *    （旧实现无条件清零，导致 credit 白送、下一 hop 压力虚高）。
 * 3. 每个 hop 记录 ledger（estimate/actual/host/credit/effective/source/confidence/hop），
 *    最近 N 条随 usageState 持久化（供审计与 trace）。
 * 4. estimate 记入 lastEstimateTokens（真实字段，不冒充 actual）。
 */

import {
  computeEffectiveTokens,
  type TokenConfidence,
  type TokenSnapshot,
} from "./token-source";

/** V0.7.2 hop ledger：每 hop 的 token 事实记录（持久化、审计用）。 */
export interface HopUsageLedgerEntry {
  hop: number;
  /** 发送前插件自算 estimate。 */
  estimateTokens?: number;
  /** 上游真实 usage（undefined = 未拿到，绝不以 estimate 伪造）。 */
  actualTokens?: number;
  /** 宿主侧测量（chats.currentWindowSize）。 */
  hostTokens?: number;
  /** 该 hop 计算时的 compression credit。 */
  compressionCredit: number;
  /** 三源合成的 effective tokens。 */
  effectiveTokens: number;
  /** 本 hop 的压力来源标记。 */
  source: string;
  confidence: TokenConfidence;
  /** 记录时间戳。 */
  at: number;
}

export interface UsageManager {
  /** 记录已完成请求的上游真实 usage（provider 归一后）。Actual 唯一入口。 */
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
  /** 最近一次 estimate。 */
  getLatestEstimate(): number | undefined;
  /** 当前 compression credit（压缩导致旧 usage 的修正值）。 */
  getCompressionCredit(): number;
  /** 压缩成功：累加 credit = foldedTokens。 */
  applyCompressionCredit(tokens: number): void;
  /**
   * V0.7.2：按真实 usage 消费 credit（net accounting）。
   * consumed = max(0, min(credit, actual - foldedWindow))
   * 其中 foldedWindow = 压缩后插件投影的 estimate（re-request 仍带 unfolded
   * history 时 actual 会虚高，只有超出折叠窗口的部分才真正被 fold 反映）。
   * 返回剩余 credit。
   */
  consumeCompressionCredit(actualTokens: number, foldedWindowTokens: number): number;
  clearCompressionCredit(): void;
  /** 计算 effective snapshot（estimate 参与求 max，绝不冒充 actual）。 */
  getEffectiveSnapshot(estimatedTokens: number): TokenSnapshot;
  /**
   * V0.7.2：显式记录一个 hop 的 pressure 决策快照（project 每轮调用）。
   * 与 recordUpstreamUsage 的自动 ledger 分开：这里是"发送前决策视图"。
   */
  recordHopEntry(entry: {
    estimateTokens?: number;
    actualTokens?: number;
    hostTokens?: number;
    compressionCredit: number;
    effectiveTokens: number;
    source: string;
    confidence: TokenConfidence;
    hop?: number;
  }): void;
  /** 最近一次样本的 hop 号。 */
  getLastHop(): number;
  /** 取当前快照用于 trace / 持久化。 */
  snapshot(): {
    lastActualTokens?: number;
    lastHostTokens?: number;
    lastEstimateTokens?: number;
    compressionCreditTokens: number;
    lastHop: number;
    hopLedger: HopUsageLedgerEntry[];
  };
  /** 取 hop ledger（最近 N 条）。 */
  getHopLedger(): HopUsageLedgerEntry[];
}

export interface UsageManagerState {
  lastActualTokens?: number;
  lastActualAt?: number;
  lastHostTokens?: number;
  lastHostAt?: number;
  lastEstimateTokens?: number;
  compressionCreditTokens: number;
  lastHop: number;
  /** V0.7.2：hop ledger（最近 N 条，随 usageState 持久化）。 */
  hopLedger?: HopUsageLedgerEntry[];
}

/** hop ledger 持久化上限（防 state 文件膨胀）。 */
const MAX_LEDGER = 40;

export function createUsageManager(
  initialState?: Partial<UsageManagerState>,
): UsageManager {
  const s: UsageManagerState = {
    lastActualTokens: initialState?.lastActualTokens,
    lastActualAt: initialState?.lastActualAt,
    lastHostTokens: initialState?.lastHostTokens,
    lastHostAt: initialState?.lastHostAt,
    lastEstimateTokens: initialState?.lastEstimateTokens,
    compressionCreditTokens: initialState?.compressionCreditTokens ?? 0,
    lastHop: initialState?.lastHop ?? 0,
    hopLedger: Array.isArray(initialState?.hopLedger) ? initialState.hopLedger : [],
  };

  /** 记录一条 ledger（hop 缺省用 lastHop+1 递增）。 */
  function pushLedger(entry: Omit<HopUsageLedgerEntry, "hop" | "at"> & { hop?: number }): void {
    const ledger = s.hopLedger ?? [];
    const hop = entry.hop ?? s.lastHop + 1;
    ledger.push({
      hop,
      estimateTokens: entry.estimateTokens,
      actualTokens: entry.actualTokens,
      hostTokens: entry.hostTokens,
      compressionCredit: entry.compressionCredit,
      effectiveTokens: entry.effectiveTokens,
      source: entry.source,
      confidence: entry.confidence,
      at: Date.now(),
    });
    s.hopLedger = ledger.slice(-MAX_LEDGER);
    s.lastHop = Math.max(s.lastHop, hop);
  }

  return {
    recordUpstreamUsage(sample) {
      if (typeof sample.contextTokens === "number" && Number.isFinite(sample.contextTokens) && sample.contextTokens > 0) {
        s.lastActualTokens = sample.contextTokens;
        s.lastActualAt = Date.now();
        if (sample.hop !== undefined) s.lastHop = Math.max(s.lastHop, sample.hop);
        // V0.7.2 net accounting：真实 usage 到达时按超额部分消费 credit。
        // foldedWindow 用"当时最近的 estimate"近似折叠后窗口（estimate 在压缩后
        // 的下一 hop 就是折叠投影的体量）；无 estimate 时退化为全额消费。
        const foldedWindow = s.lastEstimateTokens;
        if (s.compressionCreditTokens > 0) {
          if (typeof foldedWindow === "number" && foldedWindow > 0) {
            const excess = Math.max(0, sample.contextTokens - foldedWindow);
            s.compressionCreditTokens = Math.max(0, s.compressionCreditTokens - excess);
          } else {
            s.compressionCreditTokens = 0;
          }
        }
        // ledger（actual 到达即记一条；estimate/host 用当前已知值）。
        const snap = computeEffectiveTokens({
          estimatedTokens: s.lastEstimateTokens ?? 0,
          actualTokens: s.lastActualTokens,
          hostTokens: s.lastHostTokens,
          compressionCredit: s.compressionCreditTokens,
        });
        pushLedger({
          hop: sample.hop,
          estimateTokens: s.lastEstimateTokens,
          actualTokens: sample.contextTokens,
          hostTokens: s.lastHostTokens,
          compressionCredit: s.compressionCreditTokens,
          effectiveTokens: snap.effectiveTokens,
          source: snap.source,
          confidence: snap.confidence,
        });
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
        s.lastEstimateTokens = tokens;
        if (hop !== undefined) s.lastHop = Math.max(s.lastHop, hop);
      }
    },
    getLatestActual: () => s.lastActualTokens,
    getLatestHost: () => s.lastHostTokens,
    getLatestEstimate: () => s.lastEstimateTokens,
    getCompressionCredit: () => s.compressionCreditTokens,
    applyCompressionCredit(tokens) {
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
        s.compressionCreditTokens += tokens;
      }
    },
    consumeCompressionCredit(actualTokens, foldedWindowTokens) {
      if (s.compressionCreditTokens <= 0) return 0;
      if (typeof actualTokens !== "number" || !Number.isFinite(actualTokens) || actualTokens <= 0) {
        return s.compressionCreditTokens;
      }
      const window = typeof foldedWindowTokens === "number" && foldedWindowTokens > 0
        ? foldedWindowTokens
        : (s.lastEstimateTokens ?? 0);
      const excess = Math.max(0, actualTokens - window);
      const consume = Math.min(s.compressionCreditTokens, excess);
      s.compressionCreditTokens -= consume;
      return s.compressionCreditTokens;
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
    recordHopEntry(entry) {
      pushLedger({
        hop: entry.hop,
        estimateTokens: entry.estimateTokens,
        actualTokens: entry.actualTokens,
        hostTokens: entry.hostTokens,
        compressionCredit: entry.compressionCredit,
        effectiveTokens: entry.effectiveTokens,
        source: entry.source,
        confidence: entry.confidence,
      });
    },
    getHopLedger: () => [...(s.hopLedger ?? [])],
    snapshot: () => ({
      lastActualTokens: s.lastActualTokens,
      lastHostTokens: s.lastHostTokens,
      lastEstimateTokens: s.lastEstimateTokens,
      compressionCreditTokens: s.compressionCreditTokens,
      lastHop: s.lastHop,
      hopLedger: [...(s.hopLedger ?? [])],
    }),
  };
}

/** EMPTY 状态（用于未初始化的 UsageManager 持久化兜底）。 */
export const EMPTY_USAGE_STATE: UsageManagerState = {
  lastActualTokens: undefined,
  lastActualAt: undefined,
  lastHostTokens: undefined,
  lastHostAt: undefined,
  lastEstimateTokens: undefined,
  compressionCreditTokens: 0,
  lastHop: 0,
  hopLedger: [],
};

export type { TokenConfidence, TokenSnapshot };