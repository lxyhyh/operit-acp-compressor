/**
 * tests/system-protect.test.mts — 折叠内容修复（系统提示词保护）端到端测试。
 *
 * 修复内容：折叠绝不吞系统提示词。折叠后发送的应是"系统提示词 + 折叠后的内容"，
 * 与原版 billion-context 行为一致（anthropic system 独立参数 / openai 转换时
 * 剥离 systemParts，折叠永不涉及系统提示）。
 *
 * 覆盖两条修复路径：
 * - 段扫描起点跳过开头连续 system（foldOldestUncoveredSegment / foldSelectRange /
 *   buildViableRanges 共用同构逻辑）
 * - applyCompression 注入 protectedMessageIds（kernel 把命中保护的消息排除出压缩块）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname, tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../src/acp/adapter.ts";

const SK = "chat-sys-protect";

/** 测试环境无 ToolPkg 宿主：mock Tools.Files（Node fs 实现），persistence 依赖它。 */
function mockTools(): void {
  const g = globalThis as unknown as { Tools?: unknown };
  if (g.Tools) return;
  const Files = {
    mkdir: async (path: string) => { mkdirSync(path, { recursive: true }); },
    read: async (path: string) => {
      try { return { content: readFileSync(path, "utf-8") }; } catch { return { content: undefined }; }
    },
    write: async (path: string, content: string) => { writeFileSync(path, content, "utf-8"); },
    move: async (from: string, to: string) => { renameSync(from, to); },
    info: (path: string) => {
      try { const s = statSync(path); return { mtimeMs: s.mtimeMs }; } catch { return undefined; }
    },
    deleteFile: async (path: string) => { try { rmSync(path, { force: true }); } catch { /* noop */ } },
  };
  g.Tools = { Files };
}
mockTools();

/** 构造 [SYSTEM, u0, a0, ..., u19, a19] 共 41 条。 */
function mkTurns(): Array<{ kind: string; content: string }> {
  const turns: Array<{ kind: string; content: string }> = [
    { kind: "SYSTEM", content: "你是 Operit 助手。系统提示词包含角色设定、工具使用指南与 ACP 上下文管理说明（此处模拟宿主原生 18743 字符系统提示）。" },
  ];
  for (let i = 0; i < 20; i++) {
    // 每条 >=1000 字符：首次折叠段 32×1000=32k、二次折叠段 10×1000=10k，
    // 都超过 kernel minCompressRange(5000) 门槛，两次折叠均可成功。
    turns.push({ kind: "USER", content: `用户问题 ${i}：` + "A".repeat(1000) });
    turns.push({ kind: "ASSISTANT", content: `助手回答 ${i}：` + "B".repeat(1000) });
  }
  return turns;
}

/** runDeferredFold 要求先登记（project 预算守卫路径才登记）；测试直接注入待办。 */
async function registerDeferredFold(
  engine: ReturnType<typeof createEngine>,
  sk: string,
): Promise<void> {
  const st = await engine.loadState(sk);
  const g = globalThis as Record<string, unknown>;
  const store = (g.__acpDeferredFold as Map<string, { sessionKey: string; blocksAtDefer: number; stateVersionAtDefer: number; level: string; at: number }> | undefined)
    ?? new Map<string, { sessionKey: string; blocksAtDefer: number; stateVersionAtDefer: number; level: string; at: number }>();
  g.__acpDeferredFold = store;
  store.set(sk, {
    sessionKey: sk,
    blocksAtDefer: st.kernelState.blocks.length,
    stateVersionAtDefer: st.hostMetadata.stateVersion ?? 0,
    level: "deferred",
    at: Date.now(),
  });
}

test("折叠内容修复：runDeferredFold 后系统提示词保留在发送历史首位（SYSTEM + 折叠内容）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-sys-"));
  try {
    const engine = createEngine(dir);
    const turns = mkTurns();
    // 第一轮投影：建立 messageRefs（低压不折叠）。
    const p0 = await engine.project(SK, SK, false, "before_finalize_prompt", turns);
    assert.equal(p0.preparedHistory[0].kind, "SYSTEM", "投影首位应保持 SYSTEM");

    // 后台 deferred fold：折叠最旧未覆盖段（从第一条非 system 消息开始）。
    await registerDeferredFold(engine, SK);
    const r = await engine.runDeferredFold(SK);
    assert.ok(r.ok, `runDeferredFold 应成功（reason=${r.reason}）`);
    assert.ok((r.blocksCreated ?? 0) >= 1, "应创建折叠块");

    // 折叠后重新投影：SYSTEM 必须仍在首位（不被折叠吞掉），且出现 SUMMARY。
    const p1 = await engine.project(SK, SK, false, "before_finalize_prompt", turns);
    assert.equal(p1.preparedHistory[0].kind, "SYSTEM", "折叠后系统提示词必须保留在发送历史首位");
    assert.equal(p1.preparedHistory[0].content, turns[0].content, "系统提示词内容应原样保留（不被摘要替换）");
    const summaryIdx = p1.preparedHistory.findIndex((t) => t.kind === "SUMMARY");
    assert.ok(summaryIdx > 0, "折叠后应出现 SUMMARY 且位于 SYSTEM 之后");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("折叠内容修复：foldSelectRange 选择的段不含系统提示词", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-sys-"));
  try {
    const engine = createEngine(dir);
    const turns = mkTurns();
    await engine.project(SK, SK, false, "before_finalize_prompt", turns);
    const fs = await engine.foldSelectRange(SK, turns);
    assert.ok(fs.ok, `foldSelectRange 应选出段（reason=${fs.reason}）`);
    assert.ok(fs.range, "应返回 range");
    assert.ok(fs.range!.ids.length >= 8, "段应有足够的消息数");
    assert.notEqual(fs.range!.seg[0].role, "system", "折叠段第一条消息不得是 system");
    assert.equal(fs.range!.seg[0].role, "user", "折叠段应从第一条 user 消息开始");
    assert.ok(!fs.range!.seg.some((m) => m.role === "system"), "折叠段内不得夹带 system 消息");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("折叠内容修复：连续两次折叠后旧摘要与系统提示词都保留（前缀稳定）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-sys-"));
  try {
    const engine = createEngine(dir);
    const turns = mkTurns(); // [SYSTEM, u0..u19, a0..a19] 41 条
    await engine.project(SK, SK, false, "before_finalize_prompt", turns);
    await registerDeferredFold(engine, SK);
    const r1 = await engine.runDeferredFold(SK);
    assert.ok(r1.ok && (r1.blocksCreated ?? 0) >= 1, `第一次折叠应成功（reason=${r1.reason}）`);
    // 缓存前缀稳定性：第一次折叠后的发送历史作为缓存基准（[SYSTEM, SUMMARY_1, ...]）。
    const p1 = await engine.project(SK, SK, false, "before_finalize_prompt", turns);
    assert.equal(p1.preparedHistory[0].kind, "SYSTEM", "首次折叠后 SYSTEM 仍在首位");
    assert.equal(p1.preparedHistory[1].kind, "SUMMARY", "首次折叠后第二位是折叠摘要");

    // 会话增长：追加 10 条新消息（5 对，使第二轮出现 ≥8 条的可折叠段）。
    const turns2 = [...turns];
    for (let i = 20; i < 25; i++) {
      turns2.push({ kind: "USER", content: `用户问题 ${i}：` + "A".repeat(1000) });
      turns2.push({ kind: "ASSISTANT", content: `助手回答 ${i}：` + "B".repeat(1000) });
    }
    await engine.project(SK, SK, false, "before_finalize_prompt", turns2);
    await registerDeferredFold(engine, SK);
    const r2 = await engine.runDeferredFold(SK);
    assert.ok(r2.ok && (r2.blocksCreated ?? 0) >= 1, `第二次折叠应成功（reason=${r2.reason}）`);

    const p2 = await engine.project(SK, SK, false, "before_finalize_prompt", turns2);
    assert.equal(p2.preparedHistory[0].kind, "SYSTEM", "两次折叠后 SYSTEM 仍在首位");
    assert.equal(p2.preparedHistory[0].content, turns[0].content, "系统提示词内容原样保留");
    // 缓存前缀稳定性：第二次折叠后 [SYSTEM, SUMMARY_1] 前缀必须与第一次逐字节一致
    // （DeepSeek prefix cache 跨折叠命中的前提：折叠点 1 之前的部分永不变化）。
    assert.equal(p2.preparedHistory[0].content, p1.preparedHistory[0].content, "SYSTEM 前缀跨折叠稳定");
    assert.equal(p2.preparedHistory[1].kind, "SUMMARY", "第二次折叠后第二位仍为首个折叠摘要");
    assert.equal(p2.preparedHistory[1].content, p1.preparedHistory[1].content, "首个折叠摘要跨轮确定性（缓存前缀可复用）");
    const summaryKinds = p2.preparedHistory.filter((t) => t.kind === "SUMMARY");
    assert.ok(summaryKinds.length >= 2, `两次折叠后应累积至少两个 SUMMARY 块（实际 ${summaryKinds.length}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
