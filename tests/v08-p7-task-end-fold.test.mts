/**
 * v08-p7-task-end-fold.test.mts — V0.8-P7 任务结束压缩状态机测试。
 *
 * 对应 P7 任务书：
 * - Test3：任务完成、压力不足 → 不触发（无指令）
 * - Test4：模型拒绝/未调用 → pending 过期 → 无假块、无注入
 * - Test5：重复 completed → 只一次 compression request
 * - Test2 链路（单元级）：pending → 注入(delivered) → compress 捕获 → applied
 * - 回声防护：压缩 turn 不注入（防 completion→compression→completion 循环）
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  onTaskCompleted,
  consumePendingTaskEndFold,
  markCompressReceived,
  markTaskEndFoldApplied,
  getTaskEndFoldState,
  resetTaskEndFoldStoreForTest,
} from "../src/acp/task-end-fold.ts";

const SK = "chat-p7-test";
const SNAP_HIGH = { effectiveTokens: 150000, contextLimit: 200000, creditTokens: 0 };
const SNAP_LOW = { effectiveTokens: 50000, contextLimit: 200000, creditTokens: 0 };

function setup(): void {
  resetTaskEndFoldStoreForTest();
}

test("T2 单元链：completed(高压) → pending → 注入 → compress 捕获 → applied", () => {
  setup();
  const st = onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 123 }, SNAP_HIGH, 7);
  assert.ok(st, "高压 completed 应置 pending");
  assert.equal(st!.phase, "pending");
  assert.equal(st!.compressionRequested, true);

  // 第一次 finalize：注入一次性指令
  const r1 = consumePendingTaskEndFold(SK, "用户的新消息");
  assert.ok(r1.instruction, "应返回注入指令");
  assert.ok(r1.instruction!.includes("acp_tools:compress"), "指令必须指向 acp_tools:compress");
  assert.equal(getTaskEndFoldState(SK)!.phase, "delivered");

  // 重复 finalize hop：不再注入（一次性）
  const r2 = consumePendingTaskEndFold(SK, "用户的新消息");
  assert.equal(r2.instruction, undefined, "delivered 后不得重复注入");

  // 模型主动 compress：捕获
  markCompressReceived(SK);
  assert.equal(getTaskEndFoldState(SK)!.compressReceived, true);

  // 落块成功：终态 + 清理
  markTaskEndFoldApplied(SK);
  assert.equal(getTaskEndFoldState(SK), undefined, "applied 后清理");
});

test("T3 压力不足：completed 不触发", () => {
  setup();
  const st = onTaskCompleted(SK, { chatId: SK, state: "completed" }, SNAP_LOW, 1);
  assert.equal(st, undefined);
  const r = consumePendingTaskEndFold(SK, "任意输入");
  assert.equal(r.instruction, undefined, "无 pending 则无注入");
});

test("T4 模型未执行：pending 过期 → 无假块、无注入", () => {
  setup();
  const st = onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 456 }, SNAP_HIGH, 2);
  assert.ok(st);
  // 直接把过期时间拨回（模拟 TTL 流逝，不真实 sleep 10min）
  const s = getTaskEndFoldState(SK)!;
  (s as unknown as { expiresAt: number }).expiresAt = Date.now() - 1;
  const r = consumePendingTaskEndFold(SK, "用户消息");
  assert.equal(r.instruction, undefined, "过期不得注入");
  assert.equal(getTaskEndFoldState(SK), undefined, "过期后清理");
});

test("T5 重复 completed：只一次 compression request", () => {
  setup();
  const s1 = onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 100 }, SNAP_HIGH, 1);
  assert.ok(s1);
  const s2 = onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 200 }, SNAP_HIGH, 2);
  assert.equal(s2!.turnIdentity, 100, "重复 completed 不得覆盖 identity");
  assert.equal(s2!.phase, "pending");
});

test("回声防护：压缩 turn 不注入（防 completion→compression→completion 循环）", () => {
  setup();
  onTaskCompleted(SK, { chatId: SK, state: "completed" }, SNAP_HIGH, 1);
  const r1 = consumePendingTaskEndFold(SK, "[ACP-LFOLD] fold prompt");
  assert.equal(r1.instruction, undefined, "echo turn 不得注入");
  // echo 消耗的是防护检查前的 pending（仍在），正常 turn 仍可注入
  const r2 = consumePendingTaskEndFold(SK, "正常消息");
  assert.ok(r2.instruction, "非 echo turn 正常注入");
});

test("注入指令内容检查：指向 acp_tools:compress 且带压力数据", () => {
  setup();
  onTaskCompleted(SK, { chatId: SK, state: "completed" }, SNAP_HIGH, 1);
  const r = consumePendingTaskEndFold(SK, "正常消息");
  assert.ok(r.instruction!.includes("acp_tools:acp_status"));
  assert.ok(r.instruction!.includes("150000"));
  assert.ok(r.instruction!.includes("75%"));
});

test("V0.10-P3 delivered 复核：块数增加 → VERIFIED 并允许重新评估", () => {
  setup();
  // 第一轮：高压 completed → pending（触发时块数=5）
  const s1 = onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 100 }, { ...SNAP_HIGH, blocks: 5 }, 1);
  assert.ok(s1);
  assert.equal(s1!.blocksAtTrigger, 5, "应记录触发时块数");
  // 注入 → delivered
  assert.ok(consumePendingTaskEndFold(SK, "新消息").instruction);
  assert.equal(getTaskEndFoldState(SK)!.phase, "delivered");
  // 下一任务完成：块数 5→7（模型压缩真实落块）→ 复核通过 + 重新评估置位新 pending
  const s2 = onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 200 }, { ...SNAP_HIGH, blocks: 7 }, 2);
  assert.ok(s2, "VERIFIED 后压力仍高 → 重新置位");
  assert.equal(s2!.turnIdentity, 200, "重新评估使用新 identity");
  assert.equal(s2!.blocksAtTrigger, 7);
});

test("V0.10-P3 delivered 复核：块数未增 → NOT-VERIFIED 仍重新评估", () => {
  setup();
  onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 100 }, { ...SNAP_HIGH, blocks: 5 }, 1);
  assert.ok(consumePendingTaskEndFold(SK, "新消息").instruction);
  assert.equal(getTaskEndFoldState(SK)!.phase, "delivered");
  // 模型未真实压缩：块数仍 5 → 复核失败，但压力仍高 → 重新置位（再给一次机会）
  const s2 = onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 300 }, { ...SNAP_HIGH, blocks: 5 }, 3);
  assert.ok(s2, "NOT-VERIFIED 后压力仍高 → 重新置位");
  assert.equal(s2!.blocksAtTrigger, 5);
});

test("V0.10-P3 delivered 复核：压力已回落 → 核查后收尾不重新触发", () => {
  setup();
  onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 100 }, { ...SNAP_HIGH, blocks: 5 }, 1);
  assert.ok(consumePendingTaskEndFold(SK, "新消息").instruction);
  const s2 = onTaskCompleted(SK, { chatId: SK, state: "completed", timestamp: 400 }, { ...SNAP_LOW, blocks: 6 }, 4);
  assert.equal(s2, undefined, "压力不足不重新触发");
  assert.equal(getTaskEndFoldState(SK), undefined, "核查后收尾清理");
});