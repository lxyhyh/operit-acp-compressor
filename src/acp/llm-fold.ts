/**
 * acp/llm-fold.ts — V0.8-P6.2 LLM Fold Job（压缩事务语义）。
 *
 * 背景（P6.1d 遗留）：fire-and-forget 回包后用 status() 重选 ranges[0] 再 apply，
 * summary 输入范围与 apply 范围未绑定 → 异步竞态下 summary 与 Block 内容错位。
 *
 * 本模块核心不变量：
 * 1. LLM 发起前冻结 range（startRef/endRef + inputTurnIds），prompt 输入即该 range
 *    的真实 turns 内容（禁 slice(0,40)/slice(0,80) 伪输入）。
 * 2. summary 与 range 是不可拆分的事务：apply 只允许用 snapshot 里保存的 range。
 * 3. 回包后 apply 前重查状态（stateVersion / range identity / coverage），
 *    任何冲突 → discard，禁止强行 apply。
 * 4. 尾部新增 turns 不使 job 失效（stateVersion 允许前进），但 range 被覆盖、
 *    identity 漂移、版本回滚必须丢弃（P6.2 任务书四/五的合并解释）。
 * 5. 单 session 同时最多一个 Fold Job（foldInFlight）。
 */

import type { CompressionState } from "acp-kernel";
import { collectCoveredMessageIds } from "./token";
import type { PromptTurnLike } from "./messages";

/** 范围选择结果（dispatch 前冻结）。 */
export interface FoldRange {
  startRef: string;
  endRef: string;
  startId: string;
  endId: string;
  /** 范围内全部消息 id（顺序 = 历史顺序）。 */
  ids: string[];
  /** 范围内真实文本字符量（与 kernel apply 的 real-text 口径同源）。 */
  chars: number;
  /** 范围内消息快照（构造 prompt 用；不进入持久化 job）。 */
  seg: Array<{ id: string; role: string; contentType: string; text: string }>;
}

/** LLM Fold Job snapshot（事务绑定单元）。 */
export interface LlmFoldJob {
  jobId: string;
  sessionKey: string;
  chatId?: string;
  /** 发起时的 stateVersion。 */
  stateVersion: number;
  startRef: string;
  endRef: string;
  startId: string;
  endId: string;
  /** 冻结的输入 turn ids（= range 覆盖的 kernel 消息 id）。 */
  inputTurnIds: string[];
  inputChars: number;
  /** 已构造好的完整压缩 prompt（与 range 一一对应）。 */
  prompt: string;
  promptHead: string;
  createdAt: number;
}

/** apply 前状态检查结果。 */
export type FoldApplyCheck =
  | { ok: true; versionDelta: number }
  | { ok: false; reason: string; versionDelta: number };

/** 单 session 并发槽：sessionKey → jobId。 */
const foldInFlight = (globalThis as Record<string, unknown>).__acpLlmFoldJobs as
  | Map<string, string>
  | undefined ?? new Map<string, string>();
if (!(globalThis as Record<string, unknown>).__acpLlmFoldJobs) {
  (globalThis as Record<string, unknown>).__acpLlmFoldJobs = foldInFlight;
}

/** 尝试占用 session 的 fold 槽（单并发）。成功返回 true。 */
export function tryAcquireFoldSlot(sessionKey: string, jobId: string): boolean {
  const cur = foldInFlight.get(sessionKey);
  if (cur) return false;
  foldInFlight.set(sessionKey, jobId);
  return true;
}

/** 释放 session 的 fold 槽（仅当仍持有同一 jobId）。 */
export function releaseFoldSlot(sessionKey: string, jobId: string): void {
  if (foldInFlight.get(sessionKey) === jobId) foldInFlight.delete(sessionKey);
}

export function currentFoldJobId(sessionKey: string): string | undefined {
  return foldInFlight.get(sessionKey);
}

/** 生成 jobId。 */
export function newFoldJobId(): string {
  return `lfold-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const PROMPT_TURN_CHAR_CAP = 4000;
const PROMPT_TOTAL_CHAR_CAP = 60_000;
const MIN_SUMMARY_CHARS = 200;

/**
 * 构造 fold prompt + job snapshot。
 * prompt 输入 = range 覆盖的真实 turns（每条上限 PROMPT_TURN_CHAR_CAP，
 * 总量上限 PROMPT_TOTAL_CHAR_CAP；超总限时截尾并在头部声明 truncated）。
 */
export function createFoldJob(args: {
  jobId: string;
  sessionKey: string;
  chatId?: string;
  stateVersion: number;
  range: FoldRange;
  truncateNote?: boolean;
}): LlmFoldJob {
  const { jobId, sessionKey, chatId, stateVersion, range } = args;
  const lines: string[] = [];
  let truncated = false;
  let total = 0;
  for (let i = 0; i < range.seg.length; i++) {
    const m = range.seg[i];
    let body = (m.text ?? "").slice(0, PROMPT_TURN_CHAR_CAP);
    if (total + body.length > PROMPT_TOTAL_CHAR_CAP) {
      truncated = true;
      break;
    }
    total += body.length;
    lines.push(`[#${i + 1} ${m.role}/${m.contentType}] ${body}`);
  }
  const head =
    `[ACP-LFOLD] job=${jobId} range=${range.startRef}..${range.endRef} turns=${range.seg.length}` +
    (truncated ? " (input-truncated)" : "") +
    `\n请把以下对话历史压缩为一段不超过 2000 字的中文摘要，保留关键决策、结论、数据与未完成任务。直接输出摘要正文。\n`;
  const prompt = head + lines.join("\n");
  return {
    jobId,
    sessionKey,
    chatId,
    stateVersion,
    startRef: range.startRef,
    endRef: range.endRef,
    startId: range.startId,
    endId: range.endId,
    inputTurnIds: [...range.ids],
    inputChars: range.chars,
    prompt,
    promptHead: prompt.slice(0, 60),
    createdAt: Date.now(),
  };
}

/**
 * apply 前状态检查（P6.2 任务书四/五）。
 * 允许：versionDelta === 0，或 > 0 且 range identity / inputTurnIds / coverage 全部未变
 *      （尾部增长推进 stateVersion 属于任务书五的"新增尾部 turns"场景，不失效）。
 * 丢弃：版本回滚 / 端点 ref 换绑 / inputTurnIds 缺失 / range 被覆盖。
 */
export function checkFoldApply(
  ctx: { stateVersion: number; kernelState: CompressionState },
  job: LlmFoldJob,
): FoldApplyCheck {
  const versionDelta = (ctx.stateVersion ?? 0) - job.stateVersion;
  if (versionDelta < 0) {
    return { ok: false, reason: "state-version-rollback", versionDelta };
  }
  const refs = (ctx.kernelState as { messageRefs?: { byRaw?: Record<string, string>; byRef?: Record<string, unknown> } }).messageRefs ?? {};
  const byRaw = refs.byRaw ?? {};
  // 1) 端点 ref 仍指向冻结 id（range identity 未漂移）。
  if (byRaw[job.startRef] !== job.startId || byRaw[job.endRef] !== job.endId) {
    return { ok: false, reason: "range-identity-changed", versionDelta };
  }
  // 2) 冻结的 inputTurnIds 仍存在于当前历史 id 集。
  const currentIds = new Set(Object.values(byRaw));
  const missing = job.inputTurnIds.filter((id) => !currentIds.has(id));
  if (missing.length > 0) {
    return { ok: false, reason: "input-turns-missing", versionDelta };
  }
  // 3) range 未被任何 active block 覆盖。
  const covered = collectCoveredMessageIds(ctx.kernelState);
  const coveredHit = job.inputTurnIds.filter((id) => covered.has(id));
  if (coveredHit.length > 0) {
    return { ok: false, reason: "range-covered", versionDelta };
  }
  return { ok: true, versionDelta };
}

/** runFoldJob 依赖（注入便于测试）。 */
export interface FoldJobDeps {
  /** 发送 LLM 请求（fire-and-forget 的 await 侧）。 */
  sendLLM: (prompt: string) => Promise<unknown>;
  /** 读取当前状态 + 当前 raw turns（apply 用当前历史，禁止 snapshot 旧历史）。 */
  getFoldApplyContext: (sessionKey: string) => Promise<{ stateVersion: number; kernelState: CompressionState; rawTurns: PromptTurnLike[] }>;
  /** 落块（kernel 原子 apply；summary+range 事务）。 */
  applyCompression: (sessionKey: string, ranges: Array<{ startRef: string; endRef: string; summary: string; topic?: string }>, turns: PromptTurnLike[], chatId?: string) => Promise<{ blocksCreated: number; tokensCompressed: number; errors: string[]; warnings: string[] }>;
  /** 诊断日志（[lfold-*] 行）。 */
  log: (line: string) => void;
  /** 完成回调（释放 running/inFlight 状态）。 */
  onDone: (result: { ok: boolean; reason?: string; blocksCreated?: number; tokensCompressed?: number }) => void;
}

/** 从 Chat.sendMessage 的回包提取文本（多形态兼容）。 */
export function extractReplyText(reply: unknown): string {
  const r = reply as { text?: unknown; response?: unknown; message?: unknown; result?: { text?: unknown } } | undefined;
  const t = r?.text ?? r?.response ?? r?.message ?? r?.result?.text;
  return typeof t === "string" ? t : "";
}

export interface FoldJobResult {
  ok: boolean;
  reason?: string;
  blocksCreated?: number;
  tokensCompressed?: number;
}

/**
 * 执行 Fold Job 后半程：await LLM → apply-check → 用 snapshot range 落块。
 * 在 dispatch 后台调用（不阻塞 hook）。任何路径都保证 onDone 恰好一次。
 */
export async function runFoldJob(job: LlmFoldJob, deps: FoldJobDeps): Promise<FoldJobResult> {
  const t0 = job.createdAt;
  const tag = `job=${job.jobId}`;
  let released = false;
  const done = (r: FoldJobResult): FoldJobResult => {
    if (!released) {
      released = true;
      deps.onDone(r);
    }
    return r;
  };
  try {
    const reply = await deps.sendLLM(job.prompt);
    const text = extractReplyText(reply);
    const t1 = Date.now();
    deps.log(`[lfold-llm] ${tag} ok=1 ms=${t1 - t0} textLen=${text.length} head=${text.slice(0, 60).replace(/\n/g, " ")}`);
    if (text.length < MIN_SUMMARY_CHARS) {
      return done({ ok: false, reason: "summary-too-short" });
    }
    // —— apply 前状态重查：禁止回包后重新选 range；冲突一律 discard。
    const ctx = await deps.getFoldApplyContext(job.sessionKey);
    const chk = checkFoldApply({ stateVersion: ctx.stateVersion, kernelState: ctx.kernelState }, job);
    deps.log(
      `[lfold-apply-check] ${tag} stateMatch=${chk.ok ? (chk.versionDelta === 0 ? 1 : 2) : 0} rangeMatch=${chk.ok || chk.reason !== "range-identity-changed" ? 1 : 0} coveredMatch=${chk.ok || chk.reason !== "range-covered" ? 1 : 0} identityMatch=${chk.ok || (chk.reason !== "input-turns-missing" && chk.reason !== "range-identity-changed") ? 1 : 0} versionDelta=${chk.versionDelta}`,
    );
    if (!chk.ok) {
      deps.log(`[lfold-discard] ${tag} reason=${chk.reason}`);
      return done({ ok: false, reason: chk.reason });
    }
    // —— apply：summary 与 snapshot range 不可拆分；messages 用当前历史。
    const turns = ctx.rawTurns;
    if (!Array.isArray(turns) || turns.length === 0) {
      deps.log(`[lfold-discard] ${tag} reason=no-current-turns`);
      return done({ ok: false, reason: "no-current-turns" });
    }
    const ac = await deps.applyCompression(
      job.sessionKey,
      [{ startRef: job.startRef, endRef: job.endRef, summary: text, topic: `V0.8-P6.2 llm-fold ${job.startRef}..${job.endRef}` }],
      turns,
      job.chatId,
    );
    if ((ac.errors?.length ?? 0) > 0 || (ac.blocksCreated ?? 0) === 0) {
      deps.log(`[lfold-discard] ${tag} reason=kernel-apply-failed errors=${JSON.stringify(ac.errors ?? []).slice(0, 200)}`);
      return done({ ok: false, reason: "kernel-apply-failed" });
    }
    deps.log(`[lfold-apply] ${tag} blocks=${ac.blocksCreated} tokens=${ac.tokensCompressed}`);
    return done({ ok: true, blocksCreated: ac.blocksCreated, tokensCompressed: ac.tokensCompressed });
  } catch (e) {
    deps.log(`[lfold-err] ${tag} ms=${Date.now() - t0} err=${String(e).slice(0, 160)}`);
    return done({ ok: false, reason: "llm-error" });
  } finally {
    // 兜底：任何 return 路径漏调 done 时仍保证释放。
    if (!released) {
      released = true;
      deps.onDone({ ok: false, reason: "fold-job-aborted" });
    }
  }
}