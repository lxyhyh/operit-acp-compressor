/**
 * acp/messages.ts — PromptTurn ↔ CoreMessage 转换与投影裁剪。
 *
 * 与既有 src/types.ts（coreToTurn / turnToCore / estimateTokens）互补：
 * 本模块提供新架构（宿主 hook 投影）需要的：
 * - stableKeyForTurn：稳定内容指纹（排除易变 metadata 字段），供 fingerprint。
 * - promptTurnsToCoreMessages：带 toolCallId FIFO 配对与 XML 工具名解析。
 * - coreMessagesToPromptTurns：把 kernel 输出还原为 PromptTurn（SUMMARY 保留）。
 * - capProjectionSize：总字符预算裁剪（防宿主主线程解析超大 JSON 卡死）。
 */

import type { CoreMessage } from "acp-kernel";

// 注意：acp-kernel 根入口同时导出两个 MessageRole（types.d.ts 含 "system"、
// search/types.d.ts 不含），TS 解析到 search 版导致 "system" 赋值报错。
// 因此这里不 import MessageRole，用 CoreMessage 字段的结构类型 + 自有联合。
type MessageRole = CoreMessage["role"];
type MessageContentType = CoreMessage["contentType"];

/** 轻量字符串 hash（FNV-1a 变体），用于 fingerprint。 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** 稳定 JSON 序列化：按键排序后 stringify，避免键插入顺序影响指纹稳定性。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** PromptTurn 结构（结构类型，避免强依赖 ToolPkg 全局）。 */
export interface PromptTurnLike {
  kind: string;
  content: string;
  toolName?: string;
  metadata?: Record<string, unknown> | null;
}

const KIND_TO_ROLE: Record<string, MessageRole> = {
  SYSTEM: "system",
  USER: "user",
  ASSISTANT: "assistant",
  TOOL_RESULT: "tool",
  TOOL_CALL: "assistant",
  SUMMARY: "system",
};

const KIND_TO_CONTENT_TYPE: Record<string, MessageContentType> = {
  SYSTEM: "text",
  USER: "text",
  ASSISTANT: "text",
  TOOL_RESULT: "tool-result",
  TOOL_CALL: "tool-call",
  SUMMARY: "text",
};

/** 从 Operit 工具消息 XML content 解析工具名：`<tool_x name="pkg:tool">`。 */
export function toolNameFromXml(content: string): string {
  if (typeof content !== "string") return "";
  const m = /<tool(?:_result)?_[a-zA-Z0-9_]+ name="([^"]*)"/.exec(content);
  return m ? m[1] : "";
}

/** 从 XML content 解析随机 tag 标识：`<tool_Wjpd>` -> "Wjpd"。 */
export function toolTagIdFromXml(content: string): string {
  if (typeof content !== "string") return "";
  const m = /<tool(?:_result)?_([a-zA-Z0-9_]+)/.exec(content);
  return m ? m[1] : "";
}

/** 为一条 PromptTurn 生成 stableKey（内容指纹；排除易变 metadata）。 */
export function stableKeyForTurn(turn: PromptTurnLike): string {
  const kind = turn.kind || "UNKNOWN";
  const content = typeof turn.content === "string" ? turn.content : "";
  let toolName = turn.toolName || "";
  if (toolName === "null" || toolName === "undefined") toolName = "";
  // 排除易变配对字段（toolCallId 等），只保留稳定元数据。
  const stableMeta: Record<string, unknown> = {};
  if (turn.metadata && typeof turn.metadata === "object") {
    for (const [k, v] of Object.entries(turn.metadata)) {
      if (k === "toolCallId" || k === "tool_call_id") continue;
      stableMeta[k] = v;
    }
  }
  const meta = Object.keys(stableMeta).length > 0 ? stableStringify(stableMeta) : "";
  return `${kind}|${toolName}|${hashString(JSON.stringify([content, meta]))}`;
}

export interface CoreMapping {
  messages: CoreMessage[];
  /** stableKey -> PromptTurn 原始对象（用于反向映射） */
  byKey: Map<string, PromptTurnLike>;
}

/**
 * 将 PromptTurn[] 转换为 CoreMessage[]。
 * - V0.7.8：id 由 identity-bridge 生成（namespace-aware + legacy continuity），
 *   重复 id 追加 #2、#3…。
 * - TOOL_CALL/TOOL_RESULT：从 XML 解析工具名；toolCallId 用 FIFO 配对
 *   （call 生成 id 入队，下一条 result 出队继承），无法配对时用 orphan_ 前缀。
 */
export function promptTurnsToCoreMessages(
  turns: PromptTurnLike[],
  identity?: {
    identityForTurn?: (turn: PromptTurnLike) => { id: string };
    getLegacyExists?: () => (key: string) => boolean;
  },
): CoreMapping {
  const messages: CoreMessage[] = [];
  const byKey = new Map<string, PromptTurnLike>();
  const seen = new Map<string, number>();
  const pendingCallIds: string[] = [];
  const identityFn = identity?.identityForTurn
    ? identity.identityForTurn
    : (turn: PromptTurnLike) => ({ id: stableKeyForTurn(turn) });

  for (const turn of turns) {
    const idBase = identityFn(turn).id;
    const occurrence = (seen.get(idBase) || 0) + 1;
    seen.set(idBase, occurrence);
    const key = occurrence === 1 ? idBase : `${idBase}#${occurrence}`;

    const role = KIND_TO_ROLE[turn.kind] || "user";
    const contentType = KIND_TO_CONTENT_TYPE[turn.kind] || "text";
    const text = typeof turn.content === "string" ? turn.content : "";

    const core: CoreMessage = {
      id: key,
      role,
      contentType,
      text,
    };

    if (turn.kind === "TOOL_CALL" || turn.kind === "TOOL_RESULT") {
      const xmlName = toolNameFromXml(text);
      if (xmlName) core.toolName = xmlName;
      else if (turn.toolName && turn.toolName !== "null" && turn.toolName !== "undefined") {
        core.toolName = turn.toolName;
      }
    }

    // toolCallId：优先 metadata 显式值；否则 call/result 顺序配对。
    let explicitCallId: string | undefined;
    if (turn.metadata && typeof turn.metadata.toolCallId === "string") {
      explicitCallId = turn.metadata.toolCallId;
    } else if (turn.metadata && typeof (turn.metadata as { tool_call_id?: string }).tool_call_id === "string") {
      explicitCallId = (turn.metadata as { tool_call_id?: string }).tool_call_id;
    }
    if (explicitCallId) {
      core.toolCallId = explicitCallId;
      if (turn.kind === "TOOL_CALL") {
        pendingCallIds.push(explicitCallId);
      } else if (turn.kind === "TOOL_RESULT") {
        if (pendingCallIds.length > 0 && pendingCallIds[0] === explicitCallId) {
          pendingCallIds.shift();
        }
      }
    } else if (turn.kind === "TOOL_CALL") {
      const tagId = toolTagIdFromXml(text);
      const callId = tagId ? `tc_${tagId}` : `tc_${hashString(text + "|call").slice(0, 8)}`;
      core.toolCallId = callId;
      pendingCallIds.push(callId);
    } else if (turn.kind === "TOOL_RESULT") {
      const paired = pendingCallIds.shift();
      if (paired) {
        core.toolCallId = paired;
      } else {
        const tagId = toolTagIdFromXml(text);
        if (tagId) core.toolCallId = `orphan_${tagId}`;
      }
    }

    messages.push(core);
    byKey.set(key, turn);
  }

  return { messages, byKey };
}

/**
 * 限制投影输出体量（防宿主主线程解析超大 JSON 卡死）。
 * - 单条超限裁剪（最近 maxRecent 条不裁；SUMMARY 不裁——保压缩内容完整）。
 * - 总预算超限时从最旧开始逐条降级到 keepChars/4，直到达标（硬上界）。
 */
export function capProjectionSize(
  turns: PromptTurnLike[],
  opts?: { keepChars?: number; maxRecent?: number; totalBudgetChars?: number },
): PromptTurnLike[] {
  const keepChars = opts?.keepChars ?? 2000;
  const maxRecent = opts?.maxRecent ?? 3;
  const totalBudgetChars = opts?.totalBudgetChars ?? 0;
  const protectFrom = Math.max(0, turns.length - maxRecent);

  const truncate = (t: PromptTurnLike, chars: number): PromptTurnLike => {
    const content = typeof t.content === "string" ? t.content : "";
    if (content.length <= chars) return t;
    // SUMMARY 与 SYSTEM 不裁：SUMMARY 保压缩内容完整；SYSTEM 是模型指令核心
    //（含 ACP 上下文管理指南），裁剪会丢失"主动压缩"指引——本插件存在的意义。
    if (t.kind === "SUMMARY" || t.kind === "SYSTEM") return t;
    const prefix = content.slice(0, chars);
    const suffix = content.slice(-chars);
    return {
      ...t,
      content: `${prefix}\n...[truncated for context space (original ${content.length} chars)]...\n${suffix}`,
    };
  };
  let out = turns.map((t, i) => (i >= protectFrom ? t : truncate(t, keepChars)));

  if (totalBudgetChars > 0) {
    let total = out.reduce((s, t) => s + (typeof t.content === "string" ? t.content.length : 0), 0);
    let rounds = 0;
    while (total > totalBudgetChars && rounds < 3) {
      rounds++;
      let reduced = false;
      for (let i = 0; i < out.length && total > totalBudgetChars; i++) {
        if (i >= protectFrom) continue;
        if (out[i].kind === "SYSTEM" || out[i].kind === "SUMMARY") continue; // 保护指令与摘要
        const before = typeof out[i].content === "string" ? (out[i].content as string).length : 0;
        if (before > Math.floor(keepChars / 4)) {
          out[i] = truncate(out[i], Math.floor(keepChars / 4));
          const after = (out[i].content as string).length;
          if (after < before) {
            total -= before - after;
            reduced = true;
          }
        }
      }
      if (!reduced) break;
    }
  }
  return out;
}

/**
 * 将 kernel 输出的 CoreMessage[] 转回 PromptTurn[]。
 * - 通过 byKey 恢复原始 PromptTurn（保留宿主元数据）；
 * - kernel 生成的 summary（id 以 acp_summary_ / acp_block_ 开头）→ SUMMARY 类型；
 * - 写回 toolCallId 到 metadata（FIFO 配对关系持久化，防跨轮重新配对错位）。
 */
export function coreMessagesToPromptTurns(
  coreMessages: CoreMessage[],
  byKey: Map<string, PromptTurnLike>,
): PromptTurnLike[] {
  const out: PromptTurnLike[] = [];
  const emitted = new Set<string>();

  for (const core of coreMessages) {
    if (!core.id) continue;
    if (emitted.has(core.id)) continue;
    emitted.add(core.id);

    if (core.id.startsWith("acp_summary_") || core.id.startsWith("acp_block_")) {
      out.push({
        kind: "SUMMARY",
        content: core.text || "",
        metadata: { acp: true, blockId: core.toolCallId || undefined },
      });
      continue;
    }

    const original = byKey.get(core.id);
    if (original) {
      const isStructured = original.kind === "TOOL_CALL" || original.kind === "TOOL_RESULT";
      const outTurn: PromptTurnLike = { ...original };
      if (!isStructured && typeof core.text === "string" && core.text !== original.content) {
        outTurn.content = core.text;
      }
      if (core.toolCallId && (!outTurn.metadata || !(outTurn.metadata as Record<string, unknown>).toolCallId)) {
        outTurn.metadata = { ...(outTurn.metadata || {}), toolCallId: core.toolCallId };
      }
      out.push(outTurn);
      continue;
    }

    const role = core.role;
    const kind =
      role === "system" ? "SYSTEM"
      : role === "user" ? "USER"
      : role === "tool" ? "TOOL_RESULT"
      : "ASSISTANT";
    out.push({
      kind,
      content: core.text || "",
      toolName: core.toolName,
      metadata: { acpSynthetic: true },
    });
  }

  return out;
}