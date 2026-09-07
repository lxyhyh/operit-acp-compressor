/**
 * acp/token.ts — Token 估算。
 *
 * ACP token decision 针对"当前发送 projection"，不是 Raw Session 总历史。
 * CJK 加权估算：CJK 字符 = 1 token/字；其他字符 = 1 token/4 字符。
 */

import type { CoreMessage, CompressionState } from "acp-kernel";

// CJK 统一表意文字 + 扩展A + 假名 + 谚文 + 全角标点
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g;

/** CJK 加权 token 估算。 */
export function countTokensCjk(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_RE) || []).length;
  const otherCount = text.length - cjkCount;
  return cjkCount + Math.ceil(otherCount / 4);
}

/** 收集所有 active block 覆盖的消息 id（压缩后不可见的消息）。 */
export function collectCoveredMessageIds(state: CompressionState): Set<string> {
  const ids = new Set<string>();
  for (const b of state.blocks) {
    if (!b.active) continue;
    for (const id of b.effectiveMessageIds) ids.add(id);
  }
  return ids;
}

/**
 * 估算 projection 的 token 数：
 * - 跳过 compress 工具自身的调用消息（不应计入上下文预算）。
 * - 跳过已被 active block 覆盖的消息。
 */
export function estimateProjectionTokens(
  messages: CoreMessage[],
  coveredIds?: Set<string>,
): number {
  let tokens = 0;
  for (const m of messages) {
    if (m.toolName === "compress" || (m.toolName && m.toolName.endsWith(":compress"))) continue;
    if (coveredIds?.has(m.id)) continue;
    tokens += countTokensCjk(m.text ?? "");
  }
  return tokens;
}