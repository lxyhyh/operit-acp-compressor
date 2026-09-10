/**
 * acp/lifecycle.ts — Hook 处理函数（宿主调用侧）。
 *
 * - onFinalize：PromptFinalizeHook。同一 send 周期（同 fingerprint）只做
 *   一次 state mutation：第一阶段投影，第二阶段复用缓存（幂等）。
 * - onSystemPromptCompose：after_compose_system_prompt 阶段幂等追加 ACP 提示
 *   （V0.7.13-P2 起提示统一指向 Operit 原生 package_proxy(tool_name="acp_tools:xxx")，
 *   不再注入裸名 ACP 工具，也不再注册 ToolPromptComposeHook）。
 * - onEstimateFinalize：恒 no-op（不注册估算钩子——宿主主线程同步等待
 *   估算钩子返回大 JSON 会 ANR；官方示例从不注册）。
 *
 * 注意：hook 在宿主独立 runtime 被调用，模块级闭包状态不可见，
 * 每次调用自行 createEngine()（settings 实时读文件）。
 */

import { createEngine, type AcpEngine } from "./adapter";
import { buildSessionKey, type SessionContext } from "./session";
import { appendAcpSystemPrompt } from "./system-prompt";
import { loadAdapterSettings } from "./config";
import { LOG_ACP_FILE, LOG_TOOLS_VISIBILITY_FILE } from "./paths";
import { deliveryTraceLine, findNudgeTurn, markFinalCheck, type NudgeDelivery } from "./nudge-delivery";

/** trace 写入器（lazy require；与 trace.ts 的 chatTrace 同构，失败不影响主流程）。 */
function requireTraceWriter(): ((line: string) => void) | undefined {
  try {
    // trace.ts 的 chatTrace(sessionKey, ...) 需要 sessionKey，这里仅做追加写。
    // 直接复用 Tools.Files.write 追加（路径与 trace.ts 的 ACP_TRACE_FILE 一致）。
    const path = "/sdcard/Download/Operit/plugins/com.operit.acp_compressor/logs/acp_trace.jsonl";
    return (line: string) => {
      Tools.Files.write(path, line, true, "android");
    };
  } catch {
    return undefined;
  }
}

/** 追加一行诊断日志（失败不影响主流程）。 */
function diagLog(file: string, line: string): void {
  try {
    Tools.Files.write(file, `${new Date().toISOString()} ${line}\n`, true, "android");
  } catch { /* ignore */ }
}

type PromptTurn = { kind: string; content: string; toolName?: string; metadata?: Record<string, unknown> | null };
type PromptHookObjectResult = { preparedHistory?: PromptTurn[]; systemPrompt?: string; availableTools?: unknown[] };

interface FinalizeHookEvent {
  eventPayload?: Record<string, unknown>;
  eventName?: string;
}
interface SystemPromptComposeHookEvent {
  eventPayload?: Record<string, unknown>;
}

/** 从事件 payload 提取 session 上下文。 */
function sessionContextFromPayload(payload: Record<string, unknown>): SessionContext {
  return {
    chatId: payload.chatId as string | undefined,
    isSubTask: false,
    functionType: payload.functionType as string | undefined,
    promptFunctionType: payload.promptFunctionType as string | undefined,
  };
}

/** 从 payload 取当前 turns（优先 preparedHistory，其次 chatHistory）。 */
function turnsFromPayload(payload: Record<string, unknown>): PromptTurn[] {
  const t = payload.preparedHistory ?? payload.chatHistory;
  return Array.isArray(t) ? (t as PromptTurn[]) : [];
}

/** 投影失败：透传原始 history（不破坏用户请求），绝不抛给宿主。 */
async function safeProject(engine: AcpEngine, sessionKey: string, chatId: string | undefined, isSubTask: boolean | undefined, stage: string, turns: PromptTurn[]): Promise<PromptTurn[] | undefined> {
  try {
    const result = await engine.project(sessionKey, chatId, isSubTask, stage, turns);
    return result.preparedHistory;
  } catch (error) {
    try { console.log(`[acp] projection failed, passthrough: ${String(error)}`); } catch { /* noop */ }
    return undefined;
  }
}

/**
 * PromptFinalizeHook 处理函数（具名导出；宿主强校验模块具名导出）。
 * 返回 { preparedHistory } 以应用投影；失败/未启用/无 turns 时不干预。
 *
 * V0.7.5（三边审计后）：
 * - 宿主对一次真实用户发送调用 2 次 finalize（before_finalize_prompt →
 *   before_send_to_model，同一 context 链式传递）。stage1 注入 nudge，
 *   stage2 验证 nudge 仍在 preparedHistory（finalPreparedHistoryHasNudge）。
 * - Tool Loop 内部 hop（processToolResults）直连 serviceForFunction.sendMessage，
 *   不经过 finalize → ACP 无法在工具循环 hop 注入；nudge 不会进入工具循环历史
 *   （SYSTEM carrier 不写回 conversationHistory，ephemeral 成立）。
 * - 同一次真实 send：stage1+stage2 共享同一 fingerprint/cycle，preflight 最多一次。
 */
export async function onFinalize(event: FinalizeHookEvent): Promise<PromptHookObjectResult | void> {
  const engine = createEngine();
  const payload = (event?.eventPayload && typeof event.eventPayload === "object" ? event.eventPayload : {}) as Record<string, unknown>;
  const ctx = sessionContextFromPayload(payload);
  const sessionKey = buildSessionKey(ctx);
  const turns = turnsFromPayload(payload);
  const stage = String(payload.stage ?? event?.eventName ?? "before_finalize_prompt");

  // [诊断] finalize 收到的 history 是否含 SYSTEM turn + ACP guide（外部 AI 判定根因用）
  try {
    const kinds = turns.slice(0, 20).map((t) => t.kind).join(",");
    const sysTurn = turns.find((t) => t.kind === "SYSTEM");
    const sysLen = sysTurn && typeof sysTurn.content === "string" ? sysTurn.content.length : 0;
    const sysHasAcp = sysTurn && typeof sysTurn.content === "string" ? sysTurn.content.includes("[ACP 上下文管理]") : false;
    diagLog(LOG_TOOLS_VISIBILITY_FILE, `[finalize-history] stage=${stage} count=${turns.length} firstKinds=${kinds} sysLen=${sysLen} sysHasAcp=${sysHasAcp}`);
  } catch { /* ignore */ }

  // [探针] 工具可见性诊断：ACP 工具是否真的在 availableTools（模型工具列表）。
  try {
    const tools = payload.availableTools as Array<{ name?: string }> | undefined;
    const toolNames = (tools ?? []).map((t) => t.name ?? "").filter(Boolean);
    const acpVisible = toolNames.filter((n) => /compress|decompress|search_context|acp_status/.test(n));
    diagLog(LOG_TOOLS_VISIBILITY_FILE, `[tools] stage=${stage} tools=${toolNames.length} acp=${acpVisible.join(",") || "NONE"} hasSysprompt=${typeof payload.systemPrompt === "string" && payload.systemPrompt.length > 0} sysPromptLen=${typeof payload.systemPrompt === "string" ? payload.systemPrompt.length : 0} sysPromptHasAcp=${typeof payload.systemPrompt === "string" ? payload.systemPrompt.includes("[ACP 上下文管理]") : false}`);
  } catch { /* ignore */ }

  if (!engine.settings.enabled) return;
  if (turns.length === 0) return;
  // [HOOK-EXP 探针] 无条件输出 settings 实际值（判定 hookExperiment 是否被读到）
  try {
    diagLog(LOG_TOOLS_VISIBILITY_FILE, `[hook-exp-probe] stage=${stage} hookExperiment=${String(engine.settings.hookExperiment)} enabled=${String(engine.settings.enabled)}`);
  } catch { /* ignore */ }
  // —— V0.7.13-PERF：hook-exp 实验完成（已实锤宿主链路 + 定位超时根因），彻底撤除。
  //   实验结论：finalize hook 返回 { preparedHistory } 能真正接管发送内容；
  //   真正根因是 stage1 全量投影 >10s 超出宿主 hook 预算 → mutation 被丢弃。

  // V0.7.5：stage2（before_send_to_model）先验证 stage1 注入的 nudge 是否仍在
  // preparedHistory（宿主 applyFinalizedCurrentUserTurn / mergeAdjacentTurns 可能改动）。
  // 记录 delivery 证据（delivered=true 但 final=false → reason=operit-finalize-replaced）。
  if (stage === "before_send_to_model") {
    try {
      const nudge = findNudgeTurn(turns);
      diagLog(LOG_TOOLS_VISIBILITY_FILE, `[nudge-delivery] stage=${stage} finalHasNudge=${nudge ? 1 : 0} kind=${nudge?.turn.kind ?? "-"}`);
    } catch { /* ignore */ }
  }

  const projected = await safeProject(engine, sessionKey, ctx.chatId, ctx.isSubTask, stage, turns);
  if (projected === undefined) return;
  // finalize 返回：preparedHistory 投影 + systemPrompt 追加 ACP 指南。
  // （SystemPromptComposeHook 返回值宿主不采纳——19:49 实测 after 阶段 len 未变，
  //  而 PromptFinalizeHookReturn 支持 systemPrompt 字段，改由此通道注入。）
  const result: PromptHookObjectResult = { preparedHistory: projected as PromptTurn[] };
  const sp = typeof payload.systemPrompt === "string" ? payload.systemPrompt : undefined;
  if (sp && sp.length > 0) {
    const next = appendAcpSystemPrompt(sp);
    if (next !== sp) {
      result.systemPrompt = next;
      diagLog(LOG_TOOLS_VISIBILITY_FILE, `[finalize] INJECT sysprompt via finalize: len ${sp.length} -> ${next.length}`);
    }
  } else {
    diagLog(LOG_TOOLS_VISIBILITY_FILE, `[finalize] payload.systemPrompt empty (len=0), cannot inject via finalize`);
  }
  // V0.7.5：delivery 证明链 trace——engine 已返回 delivery（armed/carrier/delivered），
  // 这里补 final 验证（本次返回的 preparedHistory 是否含 nudge）。
  const engineDelivery = projected as unknown as { delivery?: NudgeDelivery };
  if (engineDelivery?.delivery) {
    const finalHasNudge = findNudgeTurn(projected as PromptTurn[]) !== undefined;
    const final = markFinalCheck(engineDelivery.delivery, finalHasNudge);
    diagLog(LOG_TOOLS_VISIBILITY_FILE, `[nudge-delivery] stage=${stage} armed=${final.armed ? 1 : 0} carrier=${final.carrierSelected ?? "-"} delivered=${final.deliveredToPreparedHistory ? 1 : 0} final=${final.finalPreparedHistoryHasNudge ? 1 : 0} reason=${final.reason ?? "-"}`);
    // 也写进 trace.jsonl（与 chatTrace 同构；失败不影响主流程）
    try {
      const line = deliveryTraceLine(final);
      const trace = requireTraceWriter();
      if (trace) trace(JSON.stringify(line) + "\n");
    } catch { /* ignore */ }
  }
  return result;
}

/** 注入用的 ACP 工具（模块级单例）。 */
// V0.7.13-P2：不再注入 ACP 裸工具到 availableTools。
// 走 Operit 原生 package_proxy(tool_name="acp_tools:xxx") 契约，见 docs/v0.7.13-p1-toolprompt-contract.md。

/**
 * SystemPromptComposeHook 处理函数（具名导出）。
 * 只在 after_compose_system_prompt 阶段追加 ACP 提示（该阶段 systemPrompt
 * 已完整；before 阶段注入会让原生角色/准则/工具清单丢失）。
 */
export async function onSystemPromptCompose(event: SystemPromptComposeHookEvent): Promise<string | PromptHookObjectResult | void> {
  const payload = (event?.eventPayload && typeof event.eventPayload === "object" ? event.eventPayload : {}) as Record<string, unknown>;
  const stage = String(payload.stage ?? "");
  const systemPrompt = typeof payload.systemPrompt === "string" ? payload.systemPrompt : undefined;
  const p = payload as { systemPrompt?: string };
  const len = p.systemPrompt?.length ?? 0;
  diagLog(LOG_TOOLS_VISIBILITY_FILE, `[sysprompt] stage=${stage || "(none)"} len=${len} hasAcp=${p.systemPrompt?.includes("[ACP 上下文管理]") ?? false}`);
  if (stage !== "after_compose_system_prompt") return;
  if (!systemPrompt || systemPrompt.length === 0) return;
  const next = appendAcpSystemPrompt(systemPrompt);
  if (next === systemPrompt) return;
  // 方式 3：返回完整 payload 对象（含修改后的 systemPrompt），宿主若做
  // mutation merge 即可生效。string 与 {systemPrompt} 已实测不被采纳。
  diagLog(LOG_TOOLS_VISIBILITY_FILE, `[sysprompt] INJECT full-payload: len ${systemPrompt.length} -> ${next.length} (${next.length - systemPrompt.length} chars added)`);
  return { ...payload, systemPrompt: next };
}

/** 从估算事件 payload 提取 session 上下文（与 finalize 同构）。 */
function estimateContextFromPayload(payload: Record<string, unknown>): SessionContext {
  return {
    chatId: payload.chatId as string | undefined,
    isSubTask: false,
    functionType: payload.functionType as string | undefined,
    promptFunctionType: payload.promptFunctionType as string | undefined,
  };
}

/** 估算链路只读投影（onEstimateFinalize / onEstimateHistory 共用）：
 *  - 与发送链路同款压缩（复用已形成 block），使宿主估算的"上下文占用"
 *    （右上角计数 / summary 阈值判断）与实际发送一致。
 *  - 只读：不持久化、不建块、不写 nudge、不注入提示。
 *  - 任何失败/未启用/无 turns → 不干预（透传原始估算）。 */
async function projectEstimate(event: { eventPayload?: Record<string, unknown> }): Promise<PromptHookObjectResult | void> {
  try {
    const engine = createEngine();
    if (!engine.settings.enabled) return;
    const payload = (event?.eventPayload && typeof event.eventPayload === "object" ? event.eventPayload : {}) as Record<string, unknown>;
    const ctx = estimateContextFromPayload(payload);
    const sessionKey = buildSessionKey(ctx);
    const turns = turnsFromPayload(payload);
    if (turns.length === 0) return;
    const projected = await engine.estimate(sessionKey, ctx.chatId, turns);
    if (!projected || projected === turns || projected.length === 0) return;
    // 只返回 preparedHistory（估算链路的 mutation 通道），不动其他字段。
    return { preparedHistory: projected as PromptTurn[] };
  } catch (error) {
    try { console.log(`[acp] estimate hook failed, passthrough: ${String(error)}`); } catch { /* noop */ }
    return;
  }
}

/**
 * PromptEstimateFinalizeHook 处理函数（估算 finalize：右上角计数/阈值判断）。
 * 只读投影：返回压缩后的 preparedHistory，使宿主估算基于"实际发送视图"。
 */
export async function onEstimateFinalize(event: { eventPayload?: Record<string, unknown> }): Promise<PromptHookObjectResult | void> {
  return projectEstimate(event);
}

/**
 * PromptEstimateHistoryHook 处理函数（估算 history 早期阶段）。
 * 同样只读投影。若宿主在估算阶段把 history 喂给本 hook，计数即一致。
 */
export async function onEstimateHistory(event: { eventPayload?: Record<string, unknown> }): Promise<PromptHookObjectResult | void> {
  return projectEstimate(event);
}

/** 巨型工具输出阈值（字符）。超过即视为可 absorb 候选（V0.6 ToolLoop）。 */
const HUGE_TOOL_OUTPUT_CHARS = 8000;

/**
 * ToolLifecycleHook 处理函数（V0.6 ToolLoop 集成）。
 * 监听 tool_execution_result / finished：检测巨型工具输出（≥8k 字符），
 * 记 trace 事件 + 诊断日志（供后续 absorb 候选提示）。只读，不改上下文。
 */
export async function onToolLifecycle(event: { eventPayload?: Record<string, unknown>; eventName?: string }): Promise<unknown> {
  try {
    const payload = (event?.eventPayload && typeof event.eventPayload === "object" ? event.eventPayload : {}) as Record<string, unknown>;
    const stage = String(event?.eventName ?? payload.stage ?? "");
    if (!/tool_execution_result|tool_execution_finished/.test(stage)) return;
    const toolName = String(payload.toolName ?? "");
    if (!toolName) return;
    const resultText = typeof payload.resultText === "string" ? payload.resultText : "";
    const resultJson = payload.resultJson;
    let jsonLen = 0;
    try { jsonLen = resultJson ? JSON.stringify(resultJson).length : 0; } catch { /* ignore */ }
    const totalLen = resultText.length + jsonLen;
    if (totalLen < HUGE_TOOL_OUTPUT_CHARS) return;
    diagLog(LOG_TOOLS_VISIBILITY_FILE, `[huge-tool] tool=${toolName} len=${totalLen} stage=${stage} candidate=absorb`);
    try {
      const { trace } = await import("./trace");
      trace({ t: Date.now(), type: "huge_tool_output", detail: { tool: toolName, chars: totalLen, stage } });
    } catch { /* ignore */ }
  } catch (error) {
    try { console.log(`[acp] onToolLifecycle failed: ${String(error)}`); } catch { /* noop */ }
  }
  return;
}