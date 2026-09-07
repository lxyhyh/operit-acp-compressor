/**
 * acp/trace.ts — ACP Trace：全链路事件时间线（V0.5）。
 *
 * 记录 ACP 每个关键动作（投影/压缩/吸收/解压/nudge/epoch/credit），
 * JSONL 追加到 {LOG_DIR}/acp_trace.jsonl，供 UI/人工复盘主动压缩链路。
 * 内存环形缓冲（防高频事件刷爆文件）+ 异步批量落盘。
 * 失败静默——trace 绝不影响主流程。
 */

import { LOG_DIR } from "./paths";

declare const Tools: {
  Files: {
    write(path: string, content: string, append?: boolean, environment?: string): Promise<unknown>;
    mkdir(path: string, recursive?: boolean, environment?: string): Promise<unknown>;
  };
};

export interface AcpTraceEvent {
  t: number;            // epoch ms
  type: string;         // project|estimate|compress|absorb|decompress|nudge|epoch|credit|emergency|error
  chat?: string;        // chatId 前 8 位
  stage?: string;
  level?: string;
  detail?: Record<string, unknown>;
}

const MAX_PENDING = 200;
const pending: AcpTraceEvent[] = [];
let flushTimer: unknown = undefined;

/** 记录一条 trace（内存缓冲，批量异步落盘）。 */
export function trace(ev: AcpTraceEvent): void {
  try {
    pending.push(ev);
    if (pending.length >= MAX_PENDING) flushSync();
    else if (flushTimer === undefined) {
      // 防抖 1s 批量写（避免每事件一次 IO）
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        flushSync();
      }, 1000);
    }
  } catch { /* ignore */ }
}

/** 同步写空缓冲（进程退出/满缓冲时调用）。 */
export function flushSync(): void {
  try {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const lines = batch.map((e) => JSON.stringify(e)).join("\n");
    Tools.Files.mkdir(LOG_DIR, true, "android").catch(() => {});
    Tools.Files.write(`${LOG_DIR}/acp_trace.jsonl`, `${lines}\n`, true, "android").catch(() => {});
  } catch { /* ignore */ }
}

/** 便捷封装：带 chat 前缀的事件。 */
export function chatTrace(chatId: string | undefined, ev: Omit<AcpTraceEvent, "t" | "chat">): void {
  trace({ ...ev, t: Date.now(), chat: chatId ? String(chatId).slice(0, 8) : undefined });
}
