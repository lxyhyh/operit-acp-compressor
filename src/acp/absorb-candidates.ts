/**
 * acp/absorb-candidates.ts — V0.6 Phase3.1：巨型 TOOL_RESULT → 稳定 absorb 候选。
 *
 * 目标（与文档一致）：
 * - huge-result detection = always（与 nudge 解耦）
 * - candidate 有稳定 ref（= kernel messageRefs.byRaw[stableKey]，与 absorb 工具兼容）
 * - 幂等：同一 TOOL_RESULT 多 Hop 只产生一个 candidate
 * - 持久化到 hostMetadata.absorbCandidates
 * - 已被 compression block 覆盖的 → 不新增 candidate
 * - absorb 成功后 → status=absorbed，不再提示
 */

import type { CompressionState, CoreMessage } from "acp-kernel";
import { stableKeyForTurn, type PromptTurnLike } from "./messages";

export type AbsorbCandidateStatus = "candidate" | "absorbed";

export interface AbsorbCandidate {
  /** kernel ref（m00042 等），与 absorb 工具/ kernelApplyAbsorb 完全兼容。 */
  ref: string;
  /** 稳定 key（stableKeyForTurn 输出），用于幂等去重。 */
  stableKey: string;
  tool?: string;
  chars: number;
  turnIndex: number;
  status: AbsorbCandidateStatus;
  createdAt: number;
}

/** 巨型阈值：单个 TOOL_RESULT content ≥ 此字符数视为 absorb 候选。 */
export const HUGE_TOOL_RESULT_CHARS = 6000;

export interface CoreMappingLike {
  messages: CoreMessage[];
  byKey: Map<string, PromptTurnLike>;
}

/**
 * 扫描 turns 中的巨型 TOOL_RESULT，返回候选（ref 从 kernel messageRefs.byRaw 取）。
 * 与 nudge 完全解耦——无论 usage 高低都检测。
 * coveredKeys：已被 compression block 覆盖的消息 stableKey 集合（跳过多余候选）。
 */
export function detectAbsorbCandidates(
  turns: PromptTurnLike[],
  mapping: CoreMappingLike,
  state: CompressionState,
  coveredKeys: Set<string>,
  minChars = HUGE_TOOL_RESULT_CHARS,
): AbsorbCandidate[] {
  const candidates: AbsorbCandidate[] = [];
  const byRaw = (state.messageRefs?.byRaw ?? {}) as Record<string, string>;
  const now = Date.now();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t || typeof t !== "object") continue;
    const kind = t.kind;
    if (kind !== "TOOL_RESULT" && kind !== "tool") continue;
    const content = typeof t.content === "string" ? t.content : "";
    if (content.length < minChars) continue;
    const key = stableKeyForTurn(t);
    // 已被压缩 block 覆盖 → 不新增（避免 block + candidate 重复描述同一内容）。
    if (coveredKeys.has(key)) continue;
    const ref = byRaw[key];
    if (!ref) continue; // 无 kernel ref（protected/未映射）→ 跳过，保持与 kernel 兼容
    candidates.push({
      ref,
      stableKey: key,
      tool: t.toolName || "tool",
      chars: content.length,
      turnIndex: i,
      status: "candidate",
      createdAt: now,
    });
  }
  return candidates;
}

/**
 * 幂等合并：新检测候选与已有持久化候选合并。
 * - 同一 stableKey → 更新已有（保持 ref/createdAt 稳定，多 Hop 不重复）
 * - 保留已 absorbed 的（不复活）
 * - 返回合并后列表（按 chars 降序，供 nudge 消费）
 */
export function upsertAbsorbCandidates(
  existing: AbsorbCandidate[] | undefined,
  detected: AbsorbCandidate[],
): AbsorbCandidate[] {
  const map = new Map<string, AbsorbCandidate>();
  for (const c of existing ?? []) map.set(c.stableKey, c);
  for (const c of detected) {
    const prev = map.get(c.stableKey);
    if (prev) {
      // 已存在：更新字段但保持 ref/status/createdAt 稳定（幂等）。
      map.set(c.stableKey, {
        ...prev,
        chars: c.chars,
        turnIndex: c.turnIndex,
        tool: c.tool ?? prev.tool,
      });
    } else {
      map.set(c.stableKey, c);
    }
  }
  return [...map.values()].sort((a, b) => b.chars - a.chars);
}

/** 只取活跃（未 absorb）候选，供 nudge 文案。 */
export function getActiveAbsorbCandidates(candidates: AbsorbCandidate[] | undefined): AbsorbCandidate[] {
  return (candidates ?? []).filter((c) => c.status !== "absorbed");
}

/** absorb 成功后标记指定 ref 为 absorbed（返回新数组）。 */
export function markAbsorbed(candidates: AbsorbCandidate[] | undefined, ref: string): AbsorbCandidate[] {
  return (candidates ?? []).map((c) =>
    c.ref === ref && c.status !== "absorbed"
      ? { ...c, status: "absorbed" as const }
      : c,
  );
}
