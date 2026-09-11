/**
 * acp/task-end-hook.ts — V0.8-P7 ChatRuntimeHook 桥。
 *
 * 宿主链路（docs/p7-audit.md）：
 * MessageProcessingDelegate(整轮完成) → ChatRuntimeHolder.observeRuntimeHooks
 * → ChatRuntimeHookRegistry.dispatchAsync（独立协程，不阻塞主链）
 * → ToolPkgChatRuntimeHookBridge → 本插件 onChatRuntimeEvent。
 *
 * 职责：仅处理 state=completed；从持久化 state 读压力快照；调 task-end-fold 状态机。
 * 绝不 dispatch 新请求、不生成摘要、不读无谓的大对象。
 */

import { createEngine } from "./adapter";
import { buildSessionKey } from "./session";
import {
  onTaskCompleted,
  type PressureSnapshot,
} from "./task-end-fold";

interface RuntimePayload {
  chatId?: string;
  slot?: string;
  state?: string;
  isActive?: boolean;
  timestamp?: number;
  eventName?: string;
  [k: string]: unknown;
}

function log(line: string): void {
  try {
    console.log(`[acp][task-end-hook] ${line}`);
  } catch { /* noop */ }
}

/**
 * ChatRuntimeHook 处理函数（state_changed）。
 * 宿主强校验模块具名导出——本函数经 main.ts 再导出。
 */
export async function onChatRuntimeEvent(event: unknown): Promise<void> {
  try {
    const ev = event as { eventName?: string; eventPayload?: RuntimePayload } | undefined;
    const payload = (ev?.eventPayload ?? {}) as RuntimePayload;
    const state = String(payload.state ?? "");
    const chatId = typeof payload.chatId === "string" ? payload.chatId : "";
    log(`state_changed state=${state} chat=${chatId.slice(0, 8)} slot=${String(payload.slot ?? "-")}`);
    if (state !== "completed" || !chatId) return;

    // 主对话 sessionKey = chatId（buildSessionKey 语义）。
    const sessionKey = buildSessionKey({ chatId });
    const engine = createEngine();

    // 压力快照：读持久化 state（completed 事件无 history）。
    // lastEstimateTokens = 最近一次 project 写入的发送估算；contextLimit = 配置。
    let effective = 0;
    let limit = 0;
    let credit = 0;
    let stateVersion = 0;
    try {
      const loaded = await engine.loadState(sessionKey);
      const k = loaded.kernelState as { stats?: { tokensCompressed?: number } };
      const hm = (loaded as { hostMetadata?: { stateVersion?: number } }).hostMetadata;
      const usage = (loaded as {
        hostMetadata?: { stateVersion?: number };
        usageState?: { lastEstimateTokens?: number; compressionCreditTokens?: number };
      }).usageState;
      effective = Number(usage?.lastEstimateTokens ?? 0);
      credit = Number(usage?.compressionCreditTokens ?? k?.stats?.tokensCompressed ?? 0);
      stateVersion = Number(hm?.stateVersion ?? 0);
      limit = Number(engine.settings.modelContextLimit ?? 0);
    } catch (e) {
      log(`loadState failed: ${String(e).slice(0, 120)}`);
      return;
    }
    const snap: PressureSnapshot = { effectiveTokens: effective, contextLimit: limit, creditTokens: credit };
    onTaskCompleted(sessionKey, { chatId, state, isActive: payload.isActive, timestamp: payload.timestamp }, snap, stateVersion);
  } catch (e) {
    log(`unhandled error: ${String(e).slice(0, 160)}`);
  }
}