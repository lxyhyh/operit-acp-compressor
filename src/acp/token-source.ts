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
 * computeEffectiveTokens：候选取最大值，但先对 actual 应用 compression credit 修正。
 * 依据建议文档第 8 阶段：
 *   correctedActual = max(0, actualTokens - compressionCredit)
 *   effectiveTokens  = max(correctedActual, hostTokens, estimatedTokens)
 * 说明：credit 只用于修正"压缩后仍代表旧未折叠历史的 usage"，不是从一切里减。
 */
export function computeEffectiveTokens(input: {
  estimatedTokens: number;
  actualTokens?: number;
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

  const candidates: number[] = [];
  if (correctedActual !== undefined) candidates.push(correctedActual);
  if (host !== undefined) candidates.push(host);
  const est = Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? estimatedTokens : 0;
  if (est > 0) candidates.push(est);

  const effectiveTokens = candidates.length > 0 ? Math.max(...candidates) : 0;

  let source: TokenSource = "estimate";
  if (actual !== undefined && host !== undefined) source = "hybrid";
  else if (actual !== undefined) source = "upstream";
  else if (host !== undefined) source = "host";

  const confidence: TokenConfidence =
    actual !== undefined ? "high"
    : host !== undefined ? "medium"
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