/**
 * acp/token-source.ts — V0.7.1 统一 Token Source 抽象。
 *
 * 依据建议文档第 2~9 阶段：Estimate ≠ Actual，必须区分
 *   estimate（发送前预测）
 *   upstream actual（已完成请求的真实 provider usage）
 *   host（宿主侧测量，如 chats.currentWindowSize）
 *   compression credit（压缩导致的暂时性 usage 偏差修正）
 * 并生成 effectiveTokens 供 pressure controller 使用。
 * 严禁把 estimate 冒充 actualUsage（见 audit：fake actualUsage 已移除）。
 */

export type TokenSource = "upstream" | "host" | "estimate" | "hybrid";

export interface UsageSample {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** 该样本代表的 context token 数（协议归一后）。 */
  contextTokens?: number;
  source: TokenSource;
  /** 采样时间戳 ms。 */
  timestamp: number;
  /** 可选的请求/回合标识。 */
  hop?: number;
}

export type TokenConfidence = "low" | "medium" | "high";

export interface TokenSnapshot {
  estimatedTokens: number;
  /** 真实 upstream actual（无则 undefined，绝不冒充）。 */
  actualTokens?: number;
  /** 宿主侧测量（无则 undefined）。 */
  hostTokens?: number;
  /** 压缩后 provider 仍可能返回旧 usage 的修正值。 */
  compressionCredit?: number;
  effectiveTokens: number;
  source: TokenSource;
  confidence: TokenConfidence;
}

/**
 * computeEffectiveTokens：实际发送上下文的 Token 唯一合成规则（V0.8 重构）。
 *
 * 权威优先级（任务书第四节）：
 *   1. correctedActual —— provider 真实 usage（压缩 credit 修正后）。
 *      生产链路暂无 provider usage 回调，恒 undefined（绝不伪造）。
 *   2. projectionEstimate —— 本次实际发送投影（requestHistory 同一份输入）的
 *      本地估算。它是"实际发送上下文"的最佳可用近似，source 明确标 estimate。
 *   3. hostTokens（DB currentWindowSize）只是宿主回合结束的滞后重算，
 *      反映的是"上一回合结束时的原始 DB 历史计数"，与实际发送内容脱节，
 *      ——仅存档审计（getLatestHost / ledger.hostTokens），不再参与 effective 决策。
 *
 * 禁止 effective = max(...)（estimate 高估时顶掉真实值，V0.7.13-P3-E 实证）。
 */
export function computeEffectiveTokens(input: {
  estimatedTokens: number;
  actualTokens?: number;
  /** 仅存档，不参与 effective 决策。 */
  hostTokens?: number;
  compressionCredit?: number;
}): TokenSnapshot {
  const { estimatedTokens } = input;
  const actual = typeof input.actualTokens === "number" && Number.isFinite(input.actualTokens) && input.actualTokens > 0
    ? input.actualTokens
    : undefined;
  const host = typeof input.hostTokens === "number" && Number.isFinite(input.hostTokens) && input.hostTokens > 0
    ? input.hostTokens
    : undefined;
  const credit = typeof input.compressionCredit === "number" && Number.isFinite(input.compressionCredit) && input.compressionCredit > 0
    ? input.compressionCredit
    : 0;

  const correctedActual = actual !== undefined ? Math.max(0, actual - credit) : undefined;

  const est = Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? estimatedTokens : 0;
  let effectiveTokens: number;
  if (correctedActual !== undefined && correctedActual > 0) {
    effectiveTokens = correctedActual;
  } else {
    effectiveTokens = est;
  }

  let source: TokenSource = "estimate";
  if (actual !== undefined) source = "upstream";
  const confidence: TokenConfidence =
    actual !== undefined ? "high"
    : est > 0 ? "medium"
    : "low";

  return {
    estimatedTokens: est,
    actualTokens: correctedActual !== undefined && actual !== undefined ? actual : undefined,
    hostTokens: host,
    compressionCredit: credit > 0 ? credit : undefined,
    effectiveTokens,
    source,
    confidence,
  };
}

export type ProviderProtocol = "anthropic" | "openai-chat" | "responses" | "unknown";

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
}

export interface NormalizedUsage {
  /** 该次请求计入上下文的 token（协议感知，避免 cached double-count）。 */
  contextTokens: number;
  outputTokens?: number;
}

/**
 * normalizeUsage：protocol-aware usage 归一。
 * 依据建议文档第 8 阶段：
 * - Anthropic：input + cache_read + cache_creation = total context
 * - OpenAI Chat：prompt_tokens 本身就是 total，不能再加 cached
 * - Responses：input_tokens 本身就是 total，同样不能重复加 cached
 */
export function normalizeUsage(
  protocol: ProviderProtocol,
  usage: ProviderUsage,
): NormalizedUsage {
  switch (protocol) {
    case "anthropic": {
      const base = usage.inputTokens ?? 0;
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheCreate = usage.cacheCreationTokens ?? 0;
      return {
        contextTokens: base + cacheRead + cacheCreate,
        outputTokens: usage.outputTokens,
      };
    }
    case "openai-chat":
    case "responses":
    default:
      // prompt_tokens / input_tokens 已是 total；cached 是其子集，勿重复加。
      return {
        contextTokens: usage.inputTokens ?? usage.totalTokens ?? 0,
        outputTokens: usage.outputTokens,
      };
  }
}

/** 字符串协议名 → ProviderProtocol（忽略大小写/常见命名变体）。 */
export function detectProtocol(modelIdOrProvider: string | undefined): ProviderProtocol {
  const s = (modelIdOrProvider ?? "").toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return "anthropic";
  if (s.includes("gpt") || s.includes("o1") || s.includes("o3") || s.includes("openai")) return "openai-chat";
  if (s.includes("responses")) return "responses";
  return "unknown";
}