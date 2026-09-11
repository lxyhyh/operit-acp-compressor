/**
 * v08-p62-llm-fold.test.mts — V0.8-P6.2 LLM Fold Job 事务语义测试。
 *
 * 对应 P6.2 任务书 Test 1~5：
 * - T1 正常完成：snapshot → LLM → snapshot range apply → Block
 * - T2 LLM 期间新增消息：versionDelta>0 但 range/ids 未变 → 仍用 snapshot range 落块
 * - T3 LLM 期间其他 compression：range covered → discard
 * - T4 并发：同 session 第二个 job 被拒绝
 * - T5 失败：LLM 异常 → onDone(fail)，无半成品 Block
 * - 端点漂移 / 版本回滚 → discard（任务书四）
 * - prompt 输入 = range 真实 turns（禁伪输入）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "acp-kernel";
import type { CompressionState } from "acp-kernel";
import {
  createFoldJob,
  runFoldJob,
  tryAcquireFoldSlot,
  releaseFoldSlot,
  newFoldJobId,
  type FoldRange,
  type LlmFoldJob,
} from "../src/acp/llm-fold.ts";
import type { PromptTurnLike } from "../src/acp/messages.ts";

// —— 工具：构造 CompressionState（byRaw: ref → id）。
function makeKernelState(byRaw: Record<string, string>, coveredIds: string[] = []): CompressionState {
  const ks = createInitialState() as unknown as CompressionState & { messageRefs: { byRaw: Record<string, string> }; blocks: Array<{ blockId: string; active: boolean; effectiveMessageIds: string[] }> };
  ks.messageRefs = { byRaw, byRef: {}, byId: {} } as never;
  ks.blocks = coveredIds.length > 0
    ? [{ blockId: "bx", active: true, effectiveMessageIds: coveredIds, refs: coveredIds, summary: "", tokens: 0, title: "", createdAt: 0 } as never]
    : [];
  return ks;
}

function makeRange(over: Partial<FoldRange> = {}): FoldRange {
  const seg = [
    { id: "m1", role: "user", contentType: "text", text: "第一轮：项目初始化决策 A" },
    { id: "m2", role: "assistant", contentType: "text", text: "已完成初始化，采用方案 A，配置如下：alpha=1 beta=2。后续按此执行。" },
    { id: "m3", role: "user", contentType: "text", text: "第二轮：讨论部署方案，确定使用 Docker Compose 并写入文档。" },
    { id: "m4", role: "assistant", contentType: "text", text: "部署方案已定：docker-compose.yml 三服务编排，端口 8080，含健康检查。" },
  ];
  return {
    startRef: "m00001",
    endRef: "m00004",
    startId: "m1",
    endId: "m4",
    ids: ["m1", "m2", "m3", "m4"],
    chars: seg.reduce((n, m) => n + m.text.length, 0),
    seg,
    ...over,
  };
}

function makeJob(over: Partial<LlmFoldJob> = {}): LlmFoldJob {
  return createFoldJob({ jobId: newFoldJobId(), sessionKey: "s1", chatId: "c1", stateVersion: 5, range: makeRange(), ...over }) as LlmFoldJob;
}

const okState = () => ({ stateVersion: 5, kernelState: makeKernelState({ m00001: "m1", m00002: "m2", m00003: "m3", m00004: "m4" }), rawTurns: [{ kind: "USER", content: "x" }] as unknown as PromptTurnLike[] });

test("T1 正常完成：summary 与 snapshot range 落块，禁止回包后重选 range", async () => {
  let appliedRanges: Array<{ startRef: string; endRef: string; summary: string }> = [];
  let applyCount = 0;
  let statusCalls = 0;
  const result = await runFoldJob(makeJob(), {
    sendLLM: async () => ({ text: "x".repeat(250) }),
    getFoldApplyContext: async () => { statusCalls++; return okState(); },
    applyCompression: async (_sk, ranges) => { applyCount++; appliedRanges = ranges as never; return { blocksCreated: 1, tokensCompressed: 500, errors: [], warnings: [] }; },
    log: () => {},
    onDone: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(applyCount, 1);
  assert.equal(statusCalls, 1, "apply 前恰好重查一次");
  assert.equal(appliedRanges[0].startRef, "m00001", "用 snapshot range 而非重选");
  assert.equal(appliedRanges[0].endRef, "m00004");
  assert.equal(appliedRanges[0].summary.length, 250);
});

test("T2 LLM 期间新增消息：versionDelta>0 但 identity/ids 未变 → 仍落块", async () => {
  const ctx = okState();
  ctx.stateVersion = 7; // 尾部增长推进版本
  let applied: Array<{ startRef: string }> = [];
  const result = await runFoldJob(makeJob(), {
    sendLLM: async () => ({ text: "x".repeat(250) }),
    getFoldApplyContext: async () => ctx,
    applyCompression: async (_sk, ranges) => { applied = ranges as never; return { blocksCreated: 1, tokensCompressed: 500, errors: [], warnings: [] }; },
    log: () => {},
    onDone: () => {},
  });
  assert.equal(result.ok, true, "尾部新增不应使 job 失效");
  assert.equal(applied[0].startRef, "m00001");
});

test("T3 LLM 期间其他 compression 覆盖 range → discard，禁止覆盖", async () => {
  const ctx = okState();
  ctx.kernelState = makeKernelState({ m00001: "m1", m00002: "m2", m00003: "m3", m00004: "m4" }, ["m1", "m2"]);
  let applyCount = 0;
  const result = await runFoldJob(makeJob(), {
    sendLLM: async () => ({ text: "x".repeat(250) }),
    getFoldApplyContext: async () => ctx,
    applyCompression: async () => { applyCount++; return { blocksCreated: 1, tokensCompressed: 1, errors: [], warnings: [] }; },
    log: () => {},
    onDone: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "range-covered");
  assert.equal(applyCount, 0, "被覆盖的 range 绝不允许 apply");
});

test("T4 同 session 并发：第二个 job 被单并发槽拒绝", () => {
  const jid1 = newFoldJobId();
  assert.equal(tryAcquireFoldSlot("sess", jid1), true);
  assert.equal(tryAcquireFoldSlot("sess", newFoldJobId()), false, "同 session 第二个 job 必须被拒绝");
  assert.equal(tryAcquireFoldSlot("other", newFoldJobId()), true, "不同 session 不受限");
  releaseFoldSlot("sess", jid1);
  assert.equal(tryAcquireFoldSlot("sess", newFoldJobId()), true, "释放后可再次占用");
  releaseFoldSlot("other", "dummy");
});

test("T5 LLM 失败：不影响宿主请求、无半成品 Block、onDone 恰好一次", async () => {
  let applyCount = 0;
  let doneCount = 0;
  const result = await runFoldJob(makeJob(), {
    sendLLM: async () => { throw new Error("Timeout waiting for AI reply"); },
    getFoldApplyContext: async () => { throw new Error("should not be called"); },
    applyCompression: async () => { applyCount++; throw new Error("should not apply"); },
    log: () => {},
    onDone: () => { doneCount++; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "llm-error");
  assert.equal(applyCount, 0);
  assert.equal(doneCount, 1);
});

test("端点 ref 漂移 → discard（range identity）", async () => {
  const ctx = okState();
  // 端点 m00004 被换绑到别的 id → range identity 漂移。
  ctx.kernelState = makeKernelState({ m00001: "m1", m00002: "m2", m00003: "m3", m00004: "m9" });
  let applyCount = 0;
  const result = await runFoldJob(makeJob(), {
    sendLLM: async () => ({ text: "x".repeat(250) }),
    getFoldApplyContext: async () => ctx,
    applyCompression: async () => { applyCount++; return { blocksCreated: 1, tokensCompressed: 1, errors: [], warnings: [] }; },
    log: () => {},
    onDone: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "range-identity-changed");
  assert.equal(applyCount, 0);
});

test("版本回滚 → discard", async () => {
  const ctx = okState();
  ctx.stateVersion = 3;
  let applyCount = 0;
  const result = await runFoldJob(makeJob({ stateVersion: 5 }), {
    sendLLM: async () => ({ text: "x".repeat(250) }),
    getFoldApplyContext: async () => ctx,
    applyCompression: async () => { applyCount++; return { blocksCreated: 1, tokensCompressed: 1, errors: [], warnings: [] }; },
    log: () => {},
    onDone: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "state-version-rollback");
  assert.equal(applyCount, 0);
});

test("prompt 输入 = range 真实 turns（非伪输入）", () => {
  const job = makeJob();
  const seg = makeRange().seg;
  assert.ok(job.prompt.includes("第一轮：项目初始化决策 A"), "含 range 内真实内容");
  assert.ok(job.prompt.includes("m00001..m00004"), "头部声明 range");
  assert.ok(job.prompt.includes(`turns=${seg.length}`));
  assert.ok(!job.prompt.includes("slice"), "不含伪输入痕迹");
});

test("summary 过短（<200 字）→ 不落块", async () => {
  let applyCount = 0;
  const result = await runFoldJob(makeJob(), {
    sendLLM: async () => ({ text: "太短" }),
    getFoldApplyContext: async () => okState(),
    applyCompression: async () => { applyCount++; return { blocksCreated: 1, tokensCompressed: 1, errors: [], warnings: [] }; },
    log: () => {},
    onDone: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "summary-too-short");
  assert.equal(applyCount, 0);
});