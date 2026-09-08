/**
 * acp/identity-bridge.ts — V0.7.8 Adapter Identity Bridge。
 *
 * 目标：PromptTurn → classification → stable host/tool/acp identity → CoreMessage.id。
 * 证据（V0.7.7 audit + Phase 0）：Operit 无稳定 host id / toolCallId（13/1240），
 * CALL 用 <tool_XXX>、RESULT 用 <tool_result_YYY> 无交叉引用 → 走 virtual identity。
 * 约束：不伪造 id、不删 content、不纯 index、不改 kernel。
 */
import { hashString, stableStringify, type PromptTurnLike } from "./acp/messages";

export type IdentityClass =
  | "HOST_USER" | "HOST_ASSISTANT" | "HOST_TOOL_CALL" | "HOST_TOOL_RESULT"
  | "HOST_SYSTEM" | "ACP_SUMMARY" | "ACP_NUDGE" | "UNKNOWN";

/** 纯函数分类；不改动原始 PromptTurn。 */
export function classifyTurn(turn: PromptTurnLike): IdentityClass {
  const kind = turn.kind || "UNKNOWN";
  const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : undefined;
  const isAcp = md?.acp === true || md?.acpNudge === true;
  switch (kind) {
    case "SYSTEM": return isAcp ? "ACP_NUDGE" : "HOST_SYSTEM";
    case "USER": return "HOST_USER";
    case "ASSISTANT": return "HOST_ASSISTANT";
    case "TOOL_CALL": return "HOST_TOOL_CALL";
    case "TOOL_RESULT": return "HOST_TOOL_RESULT";
    case "SUMMARY": return isAcp ? "ACP_SUMMARY" : "HOST_ASSISTANT";
    default: return "UNKNOWN";
  }
}

export interface ToolAlignmentEntry {
  seq: number;
  toolName: string;
  callSig: string;
  resultSig: string;
  lastHop: number;
}
export interface IdentityBridgeState {
  toolAlignments: Record<string, ToolAlignmentEntry[]>;
  toolSeqCounter: number;
}
export function createIdentityBridgeState(): IdentityBridgeState {
  return { toolAlignments: {}, toolSeqCounter: 0 };
}
export function loadIdentityBridgeState(raw: unknown): IdentityBridgeState {
  if (raw && typeof raw === "object") {
    const r = raw as Partial<IdentityBridgeState>;
    return {
      toolAlignments: r.toolAlignments && typeof r.toolAlignments === "object" ? r.toolAlignments : {},
      toolSeqCounter: typeof r.toolSeqCounter === "number" ? r.toolSeqCounter : 0,
    };
  }
  return createIdentityBridgeState();
}

export function normalizeToolCallSignature(content: string): string {
  return content
    .replace(/<tool_[a-zA-Z0-9_]+/g, "<tool")
    .replace(/<\/tool_[a-zA-Z0-9_]+>/g, "</tool>")
    .trim();
}
export function normalizeToolResultSignature(content: string): string {
  return content
    .replace(/<tool_result_[a-zA-Z0-9_]+/g, "<tool_result")
    .replace(/<\/tool_result_[a-zA-Z0-9_]+>/g, "</tool_result>")
    .trim();
}
export function toolNameFromContent(content: string): string {
  const m = /<tool(?:_result)?_[a-zA-Z0-9_]+ name="([^"]*)"/.exec(content || "");
  return m ? m[1] : "";
}
export function explicitToolCallId(turn: PromptTurnLike): string | undefined {
  const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : undefined;
  if (md) {
    if (typeof md.toolCallId === "string" && md.toolCallId) return md.toolCallId;
    const v = (md as { tool_call_id?: string }).tool_call_id;
    if (typeof v === "string" && v) return v;
  }
  const c = typeof turn.content === "string" ? turn.content : "";
  const m = /tool_call_id["']?\s*[:=]\s*["']([^"']+)["']/.exec(c);
  return m ? m[1] : undefined;
}

export interface IdentityContext {
  legacyRefExists?: (stableKey: string) => boolean;
  hop?: number;
  toolState: IdentityBridgeState;
}
export interface IdentityResult {
  id: string;
  strategy: "host-anchor" | "tool-call-id" | "tool-virtual" | "acp-summary" | "acp-nudge" | "content-fallback" | "legacy-continuity";
  cls: IdentityClass;
  legacyKey: string;
}

/** 与 messages.ts stableKeyForTurn 完全一致的 legacy key（fingerprint/兼容用）。 */
export function legacyStableKey(turn: PromptTurnLike): string {
  const kind = turn.kind || "UNKNOWN";
  const content = typeof turn.content === "string" ? turn.content : "";
  let toolName = turn.toolName || "";
  if (toolName === "null" || toolName === "undefined") toolName = "";
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

function hostAnchor(turn: PromptTurnLike): string | undefined {
  const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : undefined;
  if (md) {
    if (typeof md.messageId === "string" && md.messageId) return md.messageId;
    if (typeof md.hostMessageId === "string" && md.hostMessageId) return md.hostMessageId;
  }
  return undefined;
}

/** 分层 identity 生成（文档第十节）。 */
export function identityForTurn(turn: PromptTurnLike, ctx?: IdentityContext): IdentityResult {
  const cls = classifyTurn(turn);
  const legacyKey = legacyStableKey(turn);
  if (ctx?.legacyRefExists) {
    try {
      if (ctx.legacyRefExists(legacyKey)) {
        return { id: legacyKey, strategy: "legacy-continuity", cls, legacyKey };
      }
    } catch { /* noop */ }
  }
  switch (cls) {
    case "HOST_USER": {
      const a = hostAnchor(turn);
      if (a) return { id: `host:user:${a}`, strategy: "host-anchor", cls, legacyKey };
      return { id: `host:user:content:${hashString(JSON.stringify([turn.content]))}`, strategy: "content-fallback", cls, legacyKey };
    }
    case "HOST_ASSISTANT": {
      const a = hostAnchor(turn);
      if (a) return { id: `host:assistant:${a}`, strategy: "host-anchor", cls, legacyKey };
      return { id: `host:assistant:content:${hashString(JSON.stringify([turn.content]))}`, strategy: "content-fallback", cls, legacyKey };
    }
    case "HOST_TOOL_CALL": {
      const real = explicitToolCallId(turn);
      if (real) return { id: `host:toolcall:${real}`, strategy: "tool-call-id", cls, legacyKey };
      return virtualToolIdentity(turn, "toolcall", ctx);
    }
    case "HOST_TOOL_RESULT": {
      const real = explicitToolCallId(turn);
      if (real) return { id: `host:toolresult:${real}`, strategy: "tool-call-id", cls, legacyKey };
      return virtualToolIdentity(turn, "toolresult", ctx);
    }
    case "ACP_SUMMARY": {
      const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : undefined;
      const blockId = typeof md?.blockId === "string" && md.blockId ? md.blockId : hashString(String(turn.content)).slice(0, 10);
      return { id: `acp:summary:${blockId}`, strategy: "acp-summary", cls, legacyKey };
    }
    case "ACP_NUDGE": {
      const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : undefined;
      const nudgeId = typeof md?.nudgeId === "string" && md.nudgeId ? md.nudgeId : hashString(String(turn.content)).slice(0, 10);
      return { id: `acp:nudge:${nudgeId}`, strategy: "acp-nudge", cls, legacyKey };
    }
    case "HOST_SYSTEM":
      return { id: `host:system:content:${hashString(String(turn.content))}`, strategy: "content-fallback", cls, legacyKey };
    default:
      return { id: `host:unknown:content:${hashString(JSON.stringify([turn.kind, turn.content]))}`, strategy: "content-fallback", cls, legacyKey };
  }
}

/** Tool virtual identity：无真实 call id 时用 seq + toolName + sigHash（seq 仅 alignment）。 */
function virtualToolIdentity(turn: PromptTurnLike, role: "toolcall" | "toolresult", ctx?: IdentityContext): IdentityResult {
  const content = typeof turn.content === "string" ? turn.content : "";
  const toolName = toolNameFromContent(content) || turn.toolName || "";
  const sig = role === "toolcall" ? normalizeToolCallSignature(content) : normalizeToolResultSignature(content);
  const sigHash = hashString(sig).slice(0, 12);
  const state = ctx?.toolState ?? createIdentityBridgeState();
  const list = state.toolAlignments[toolName] ?? [];
  const existing = list.find((e) => e.callSig === sigHash || e.resultSig === sigHash);
  let seq: number;
  if (existing) {
    seq = existing.seq;
    if (role === "toolcall") existing.callSig = sigHash;
    else existing.resultSig = sigHash;
    existing.lastHop = ctx?.hop ?? 0;
  } else {
    seq = ++state.toolSeqCounter;
    state.toolAlignments[toolName] = [...list, {
      seq, toolName,
      callSig: role === "toolcall" ? sigHash : "",
      resultSig: role === "toolresult" ? sigHash : "",
      lastHop: ctx?.hop ?? 0,
    }];
  }
  return {
    id: `host:${role}:V${seq}_${toolName || "unknown"}_${sigHash}`,
    strategy: "tool-virtual",
    cls: classifyTurn(turn),
    legacyKey: legacyStableKey(turn),
  };
}