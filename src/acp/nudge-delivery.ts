/**
 * acp/nudge-delivery.ts — V0.7.5 nudge delivery 证明链。
 *
 * 文档第五节：不能把 "pressure.allowInject=1" 等同于 "model received nudge"。
 * 必须建立：
 *   armed → carrierSelected → deliveredToPreparedHistory → finalPreparedHistoryHasNudge
 *
 * 三边审计（AAswordman/Operit 宿主源码）：
 * - 宿主 sendMessage 对用户消息触发 2 次 finalize（before_finalize_prompt →
 *   before_send_to_model），同一 context 链式传递；
 * - ClaudeProvider 把 SYSTEM turns 提取为 systemBlocks（独立 system 参数），
 *   USER/ASSISTANT 进 messagesArray；
 * - requestHistory 写回 execContext.conversationHistory（EnhancedAIService 1110-1111），
 *   因此 USER carrier 会泄漏到 Tool Loop 下一 hop；SYSTEM carrier 不写回历史 → ephemeral。
 *
 * 结论：SYSTEM turn 是 Operit 唯一同时满足
 *   (1) 模型可见（Claude: systemBlocks；OpenAI/Gemini: system role）
 *   (2) ephemeral（不进入 conversationHistory / rawTurns / kernelState）
 *   (3) 不被 mergeAdjacentTurns 合并（SYSTEM 被显式排除）
 * 的 nudge carrier。V0.7.5 保留 SYSTEM carrier 并补齐 delivery 证明链。
 */

export type NudgeCarrierKind = "SYSTEM" | "USER";

export interface NudgeDelivery {
  /** pressure 允许注入（决策层） */
  armed: boolean;
  /** 选择的载体（当前固定 SYSTEM；USER 因写回历史被否决） */
  carrierSelected?: NudgeCarrierKind;
  /** 是否已放入本次返回的 preparedHistory（engine 层注入） */
  deliveredToPreparedHistory: boolean;
  /** finalize 阶段 2（before_send_to_model）验证 nudge 仍在 preparedHistory */
  finalPreparedHistoryHasNudge?: boolean;
  /** 注入的文本 */
  nudgeText?: string;
  /** 失败/被宿主替换原因（如 operit-finalize-replaced） */
  reason?: string;
  /** 宿主阶段（before_finalize_prompt / before_send_to_model） */
  stage?: string;
  /** nudge 档位（gentle/strong/emergency） */
  level?: string;
}

export interface NudgeCarrier {
  kind: NudgeCarrierKind;
  content: string;
  metadata: Record<string, unknown>;
}

/** 在 preparedHistory 中查找 ACP nudge turn（metadata.acpNudge === true）。 */
export function findNudgeTurn(turns: Array<{ kind?: string; content?: string; metadata?: Record<string, unknown> | null }>): { index: number; turn: { kind: string; content: string } } | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.metadata && t.metadata.acpNudge === true && typeof t.content === "string" && t.content.length > 0) {
      return { index: i, turn: { kind: String(t.kind), content: t.content } };
    }
  }
  return undefined;
}

/** 构造 nudge 载体 turn（当前固定 SYSTEM；USER 已审计否决）。 */
export function buildNudgeCarrier(nudgeText: string, level: string): NudgeCarrier {
  return {
    kind: "SYSTEM",
    content: nudgeText,
    metadata: { acpNudge: true, acpNudgeLevel: level },
  };
}

/** 创建 delivery 记录（默认失败态）。 */
export function createNudgeDelivery(stage: string): NudgeDelivery {
  return { armed: false, deliveredToPreparedHistory: false, stage };
}

/** 标记已放入 preparedHistory（返回新的 delivery，不修改原对象）。 */
export function markDelivered(d: NudgeDelivery, nudgeText: string, carrier: NudgeCarrier, level?: string): NudgeDelivery {
  return { ...d, armed: true, carrierSelected: carrier.kind, deliveredToPreparedHistory: true, nudgeText, level };
}

/** 标记最终验证结果（stage2 检查 preparedHistory 是否仍含 nudge）。 */
export function markFinalCheck(d: NudgeDelivery, hasNudge: boolean, reason?: string): NudgeDelivery {
  return { ...d, finalPreparedHistoryHasNudge: hasNudge, reason: reason ?? (hasNudge ? undefined : "operit-finalize-replaced") };
}

/** 生成 trace 行（供 acp_trace.jsonl；与 trace.ts 的 chatTrace 格式一致）。 */
export function deliveryTraceLine(d: NudgeDelivery): Record<string, unknown> {
  return {
    type: "nudge-delivery",
    armed: d.armed,
    carrier: d.carrierSelected,
    delivered: d.deliveredToPreparedHistory,
    final: d.finalPreparedHistoryHasNudge ?? false,
    reason: d.reason,
    stage: d.stage,
    level: d.level,
  };
}
