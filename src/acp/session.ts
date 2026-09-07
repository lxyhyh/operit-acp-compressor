/**
 * Session 边界管理。
 *
 * ACP 是 session-scoped：session key 由 chatId + host scope 共同决定，
 * 保证子任务不会意外共享主会话的 ACP State。
 * 主对话 functionType=CHAT 不算子任务；有子任务标记才隔离。
 */

export interface SessionContext {
  chatId?: string;
  isSubTask?: boolean;
  functionType?: string;
  promptFunctionType?: string;
}

function safe(s: unknown): string {
  if (s == null) return "";
  return String(s);
}

/** 生成 session key：主对话=chatId；子任务=chatId|sub|fn|pfn（隔离）。 */
export function buildSessionKey(ctx: SessionContext): string {
  const chatId = safe(ctx.chatId);
  if (!chatId) return "no-chat";
  const isMainChat =
    ctx.isSubTask !== true &&
    (safe(ctx.functionType) === "CHAT" || safe(ctx.functionType) === "") &&
    (safe(ctx.promptFunctionType) === "CHAT" || safe(ctx.promptFunctionType) === "");
  const isSub = !isMainChat && (ctx.isSubTask === true || !!ctx.functionType || !!ctx.promptFunctionType);
  if (isSub) {
    return `${chatId}|sub|${safe(ctx.functionType)}|${safe(ctx.promptFunctionType)}`;
  }
  return chatId;
}
