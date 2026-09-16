/**
 * acp/task-end-hook.ts — V0.8-P7 ChatRuntimeHook 桥。
 *
 * 宿主链路（docs/archive/p7-audit.md）：
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

    // —— V0.10-P1：先执行 project() 预算守卫登记的 deferred fold（发送前没来得及
    //   建块，整轮结束后无 hook 预算压力，后台补建块，下轮生效）。失败不影响主链。
    try {
      const defer = await engine.runDeferredFold(sessionKey);
      if (defer.ok) {
        log(`deferred-fold applied blocks=${defer.blocksCreated} tokens=${defer.tokensCompressed}`);
      }
    } catch (e) {
      log(`runDeferredFold failed: ${String(e).slice(0, 120)}`);
    }

    // 压力快照：读持久化 state（completed 事件无 history）。
    // lastEstimateTokens = 最近一次 project 写入的发送估算；contextLimit = 配置。
    let effective = 0;
    let limit = 0;
    let credit = 0;
    let stateVersion = 0;
    let blocks = 0;
    try {
      const loaded = await engine.loadState(sessionKey);
      const k = loaded.kernelState as { stats?: { tokensCompressed?: number }; blocks?: unknown[] };
      const hm = (loaded as { hostMetadata?: { stateVersion?: number } }).hostMetadata;
      // V0.10-B1-M 修复：usageState 实际存于 hostMetadata.usageState
      //（persistence 写入 `hostMetadata: {... usageState}`）；旧代码从顶层读
      // 恒 undefined → task-end 压力核查永不触发（P7 形同虚设）。
      const usage = (loaded as {
        hostMetadata?: {
          stateVersion?: number;
          usageState?: { lastEstimateTokens?: number; compressionCreditTokens?: number };
        };
      }).hostMetadata?.usageState;
      effective = Number(usage?.lastEstimateTokens ?? 0);
      credit = Number(usage?.compressionCreditTokens ?? k?.stats?.tokensCompressed ?? 0);
      stateVersion = Number(hm?.stateVersion ?? 0);
      limit = Number(engine.settings.modelContextLimit ?? 0);
      blocks = Array.isArray(k?.blocks) ? k.blocks.length : 0;
    } catch (e) {
      log(`loadState failed: ${String(e).slice(0, 120)}`);
      return;
    }
    const snap: PressureSnapshot = { effectiveTokens: effective, contextLimit: limit, creditTokens: credit, blocks };
    onTaskCompleted(sessionKey, { chatId, state, isActive: payload.isActive, timestamp: payload.timestamp }, snap, stateVersion);
  } catch (e) {
    log(`unhandled error: ${String(e).slice(0, 160)}`);
  }
}