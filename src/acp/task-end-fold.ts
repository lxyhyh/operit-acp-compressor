/**
 * acp/task-end-fold.ts — V0.8-P7 任务结束压缩状态机。
 *
 * 设计（docs/p7-audit.md 阶段3 方案B）：
 * - `state_changed(state=completed)` = 任务真结束信号（宿主 MessageProcessingDelegate
 *   在整轮流式响应+工具循环+消息落库后置位一次；ChatRuntimeHookRegistry.dispatchAsync
 *   独立协程派发，不阻塞、不打断任何进行中的 LLM stream）。
 * - completed 时刻：评估压缩压力 → 置 PENDING（含过期时间）。**绝不 dispatch 新请求**
 *   （P6.1 实锤同 chat sendMessage 断链），**绝不在此刻生成摘要**。
 * - 下一次正常请求的 finalize(before_finalize_prompt) 阶段：一次性 SYSTEM task-end
 *   指令注入 preparedHistory → 模型在响应开头主动调用 acp_tools:compress（真实模型
 *   摘要，非插件生成）→ 落块成功后 markTaskEndFoldApplied 终态。
 * - 模型未执行：pending 过期自动失效，无假块（Test4）。
 *
 * 约束（任务书「最重要的设计约束」）：
 * - 任务执行过程中不压缩（completed 才置 pending）
 * - 任务没有结束不触发最终 compress（pending 只在 completed 后存在）
 * - 插件不自己生成正式 compressed summary（只注入指令，摘要必由模型给出）
 * - 不另开第二个 Chat 请求（注入复用下一次正常请求）
 */

import { LOG_TOOLS_VISIBILITY_FILE } from "./paths";

/** pending 有效期（ms）：过期即作废，等待下一次 completed 重新评估。 */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** completed 触发阈值系数：effectiveTokens >= contextLimit * TASK_END_TRIGGER_PCT 才置 pending。 */
const TASK_END_TRIGGER_PCT = 0.6;

export type TaskEndFoldPhase = "pending" | "delivered" | "applied" | "expired";

/** P7 状态机（任务书第六阶段 TaskEndCompressionState）。 */
export interface TaskEndCompressionState {
  sessionKey: string;
  /** 触发 pending 的 completed 事件 timestamp（= task/turn identity）。 */
  turnIdentity: number;
  /** 触发时的宿主 stateVersion（诊断用）。 */
  stateVersion: number;
  compressionRequested: boolean;
  compressReceived: boolean;
  applied: boolean;
  phase: TaskEndFoldPhase;
  createdAt: number;
  expiresAt: number;
  /** 触发时的压力快照（指令文本数据源；completed 事件本身无 history）。 */
  snapshot: PressureSnapshot;
}

/** completed 事件最小载荷（插件侧解析 ChatRuntimeEventPayload）。 */
export interface TaskEndEvent {
  chatId: string;
  state: string;
  isActive?: boolean;
  timestamp?: number;
}

/** 压力评估输入（来自持久化 state 快照）。 */
export interface PressureSnapshot {
  effectiveTokens: number;
  contextLimit: number;
  creditTokens: number;
}

/** 注入指令文本（SYSTEM carrier；一次性；模型主动 compress 的唯一要求）。 */
export function buildTaskEndFoldInstruction(snap: PressureSnapshot): string {
  const pct = snap.contextLimit > 0 ? Math.round((snap.effectiveTokens / snap.contextLimit) * 100) : 0;
  return [
    "[ACP] 上一任务已结束。当前上下文占用约 " + snap.effectiveTokens + " tokens（" + pct + "%），需要在开始处理用户新请求之前先完成一次上下文压缩。",
    "请立即执行：先通过 package_proxy 调用 acp_tools:acp_status 查看可压缩范围，然后调用 acp_tools:compress 压缩最旧、已消费、本次任务不再需要原文的范围（summary 保留关键决策/数据/结论）。",
    "这是任务收尾的强要求：压缩完成后再继续用户的请求；无需询问用户、无需汇报压缩动作。若 acp_status 显示无可压缩范围，则跳过本要求继续正常处理。",
  ].join("\n");
}

/** 全局状态机存储（per sessionKey；跨 hook 调用共享，进程内生命周期）。 */
interface Store {
  states: Map<string, TaskEndCompressionState>;
}
function store(): Store {
  const g = globalThis as Record<string, unknown>;
  if (!g.__acpTaskEndFoldStore) {
    g.__acpTaskEndFoldStore = { states: new Map<string, TaskEndCompressionState>() };
  }
  return g.__acpTaskEndFoldStore as Store;
}

function log(sessionKey: string, line: string): void {
  try {
    Tools.Files.write(
      LOG_TOOLS_VISIBILITY_FILE,
      `${new Date().toISOString()} [task-end-fold] ${line} sk=${sessionKey.slice(0, 12)}\n`,
      true,
      "android",
    );
  } catch { /* noop */ }
}

/**
 * completed 事件入口：评估压力并置 pending（或忽略）。
 * 由 ChatRuntimeHook（state_changed）调用。绝不 dispatch、不生成摘要。
 *
 * 返回置位的状态（未触发/跳过时返回 undefined）。
 */
export function onTaskCompleted(
  sessionKey: string,
  evt: TaskEndEvent,
  snap: PressureSnapshot,
  stateVersion: number
): TaskEndCompressionState | undefined {
  const s = store();
  const prev = s.states.get(sessionKey);
  if (prev && (prev.phase === "pending" || prev.phase === "delivered")) {
    // 已有待处理/已交付请求：不重复触发（Test5：重复结束事件只允许一次 compression request）。
    log(sessionKey, `phase=${prev.phase} skip-duplicate-completed identity=${prev.turnIdentity}`);
    return prev;
  }
  const threshold = Math.round(snap.contextLimit * TASK_END_TRIGGER_PCT);
  if (!(snap.effectiveTokens >= threshold) || snap.contextLimit <= 0) {
    // 压力不足：不触发（Test3）。清理历史终态记录。
    if (prev) s.states.delete(sessionKey);
    log(sessionKey, `below-threshold eff=${snap.effectiveTokens} thr=${threshold} no-op`);
    return undefined;
  }
  const now = Date.now();
  const st: TaskEndCompressionState = {
    sessionKey,
    turnIdentity: evt.timestamp ?? now,
    stateVersion,
    compressionRequested: true,
    compressReceived: false,
    applied: false,
    phase: "pending",
    createdAt: now,
    expiresAt: now + PENDING_TTL_MS,
    snapshot: { ...snap },
  };
  s.states.set(sessionKey, st);
  log(sessionKey, `pending armed eff=${snap.effectiveTokens} thr=${threshold} identity=${st.turnIdentity}`);
  return st;
}

/**
 * finalize 注入点：存在有效 pending 时返回一次性 SYSTEM 指令并推进到 delivered。
 * 由 onFinalize(before_finalize_prompt) 在投影完成后调用（stage1 一次）。
 *
 * 返回 { instruction } 或 {}（无需注入）。
 */
export function consumePendingTaskEndFold(
  sessionKey: string,
  rawInput?: string
): { instruction?: string } {
  const s = store();
  const st = s.states.get(sessionKey);
  if (!st) return {};
  if (st.phase !== "pending") {
    // delivered（重复 finalize hop）或历史终态：不再注入；delivered 由落块/过期收尾。
    if (st.phase === "applied" || st.phase === "expired") s.states.delete(sessionKey);
    return {};
  }
  if (Date.now() > st.expiresAt) {
    st.phase = "expired";
    s.states.delete(sessionKey);
    log(sessionKey, `pending expired identity=${st.turnIdentity} (no model compress within TTL)`);
    return {};
  }
  // 压缩回声防护：本请求本身是压缩/摘要生成调用则不注入。
  if (rawInput && (rawInput.includes("[ACP-LFOLD]") || rawInput.includes("[ACP 压缩请求]"))) {
    log(sessionKey, "skip: compression echo turn");
    return {};
  }
  st.phase = "delivered";
  log(sessionKey, `delivered identity=${st.turnIdentity} eff=${st.snapshot.effectiveTokens}`);
  return { instruction: buildTaskEndFoldInstruction(st.snapshot) };
}

/** 模型 compress 已捕获（acp_tools:compress 执行时调用；Test2 证据链一环）。 */
export function markCompressReceived(sessionKey: string): void {
  const st = store().states.get(sessionKey);
  if (st && st.phase === "delivered") {
    st.compressReceived = true;
    log(sessionKey, `compress received identity=${st.turnIdentity}`);
  }
}

/** 落块成功后调用：状态机终态并清理（Test2 完成链）。 */
export function markTaskEndFoldApplied(sessionKey: string): void {
  const s = store();
  const st = s.states.get(sessionKey);
  if (st) {
    st.applied = true;
    st.phase = "applied";
    log(sessionKey, `applied identity=${st.turnIdentity}`);
    s.states.delete(sessionKey);
  }
}

/** 查询当前状态（acp_status/诊断）。 */
export function getTaskEndFoldState(sessionKey: string): TaskEndCompressionState | undefined {
  return store().states.get(sessionKey);
}

/** 测试隔离：清空状态机。 */
export function resetTaskEndFoldStoreForTest(): void {
  store().states.clear();
}