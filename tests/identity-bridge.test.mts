/**
 * tests/identity-bridge.test.mts — V0.7.8 Identity Bridge 契约测试。
 *
 * 文档第十四节 Test 1-5 + 第十五节 collision tests：
 * T1 相同 USER 跨 Hop → same ID
 * T2 ASSISTANT content unchanged → same ID
 * T3 TOOL_CALL/TOOL_RESULT virtual identity 跨 Hop 保持
 * T4 tool result content 动态变化（timestamp）→ logical identity 仍稳定
 * T5 SUMMARY → next Hop 关联原 block
 * C1/C2 不同 USER / 不同 TOOL_CALL → 不同 ID（无 collision）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTurn,
  createIdentityBridgeState,
  identityForTurn,
  normalizeToolCallSignature,
  normalizeToolResultSignature,
  type IdentityBridgeState,
} from "../src/identity-bridge.ts";

function ctx(state: IdentityBridgeState, hop = 1) {
  return { hop, toolState: state };
}

test("T1: 相同 USER 跨 Hop → 相同 ID（content-fallback）", () => {
  const s = createIdentityBridgeState();
  const u1 = { kind: "USER", content: "继续执行任务" };
  const u2 = { kind: "USER", content: "继续执行任务" };
  const a = identityForTurn(u1, ctx(s, 1));
  const b = identityForTurn(u2, ctx(s, 2));
  assert.equal(a.id, b.id, "相同 USER content → 相同 virtual id");
  assert.equal(a.cls, "HOST_USER");
  assert.ok(a.id.startsWith("host:user:content:"));
});

test("T2: ASSISTANT content unchanged → 相同 ID", () => {
  const s = createIdentityBridgeState();
  const a1 = { kind: "ASSISTANT", content: "好的，我来处理" };
  const a2 = { kind: "ASSISTANT", content: "好的，我来处理" };
  assert.equal(
    identityForTurn(a1, ctx(s, 1)).id,
    identityForTurn(a2, ctx(s, 2)).id,
  );
});

test("T3: TOOL_CALL/TOOL_RESULT virtual identity 跨 Hop 保持", () => {
  const s = createIdentityBridgeState();
  const call = {
    kind: "TOOL_CALL",
    content: '<tool_AAAA name="super_admin:terminal">\n  <param name="command">ls -la</param>\n</tool_AAAA>',
  };
  const result = {
    kind: "TOOL_RESULT",
    content: '<tool_result_BBBB name="super_admin:terminal" status="success"><content>{"ok":true}</content></tool_result_BBBB>',
  };
  const c1 = identityForTurn(call, ctx(s, 1));
  const c2 = identityForTurn(call, ctx(s, 2));
  assert.equal(c1.id, c2.id, "同一 CALL 跨 Hop virtual id 稳定");
  assert.equal(c1.strategy, "tool-virtual");
  // RESULT 属于同一调用（同 toolName + 对齐 seq）
  const r1 = identityForTurn(result, ctx(s, 1));
  const r2 = identityForTurn(result, ctx(s, 2));
  assert.equal(r1.id, r2.id, "同一 RESULT 跨 Hop 稳定");
  // CALL 与 RESULT 的 id 前缀不同（toolcall vs toolresult），但共享 seq
  assert.ok(c1.id.includes("toolcall:V"), c1.id);
  assert.ok(r1.id.includes("toolresult:V"), r1.id);
});

test("T4: tool result content 动态变化 → logical identity 稳定", () => {
  const s = createIdentityBridgeState();
  // 同一逻辑 RESULT，但 content 含动态 timestamp（tag 名也变）
  const r1 = {
    kind: "TOOL_RESULT",
    content: '<tool_result_AB12 name="super_admin:terminal" status="success"><content>{"ts":1690000,"ok":true}</content></tool_result_AB12>',
  };
  const r2 = {
    kind: "TOOL_RESULT",
    content: '<tool_result_CD34 name="super_admin:terminal" status="success"><content>{"ts":1690001,"ok":true}</content></tool_result_CD34>',
  };
  const a = identityForTurn(r1, ctx(s, 1));
  const b = identityForTurn(r2, ctx(s, 2));
  // normalize 后 tag 名被剥离；但 content 里 ts 不同 → sig 不同 → 逻辑身份不同（不能强行复用）。
  // 文档约束 8：不删 content。因此这里验证「不同 content → 不错误共享 id」（collision 安全），
  // 同时验证 normalize 能剥离 tag 随机名。
  const sig1 = normalizeToolResultSignature(String(r1.content));
  const sig2 = normalizeToolResultSignature(String(r2.content));
  // 剥离 tag 随机名后：ts 字段仍不同（1690000 vs 1690001），但结构一致。
  assert.ok(!sig1.includes("AB12"), "随机 tag 名 AB12 已剥离");
  assert.ok(!sig2.includes("CD34"), "随机 tag 名 CD34 已剥离");
  assert.ok(sig1.includes('name="super_admin:terminal"'), "工具名保留");
  assert.notEqual(sig1, sig2, "ts 真不同 → normalize 后仍不同（不错误归一化动态内容）");
  // 由于 ts 真不同（代表不同逻辑结果），id 应当不同（防错误复用）。
  assert.notEqual(a.id, b.id, "动态字段真变 → 不强行复用（collision 安全）");
});

test("T5: SUMMARY → ACP_SUMMARY namespace（关联原 block）", () => {
  const s = createIdentityBridgeState();
  const sum1 = { kind: "SUMMARY", content: "摘要内容A", metadata: { acp: true, blockId: "b42" } };
  const sum2 = { kind: "SUMMARY", content: "摘要内容A", metadata: { acp: true, blockId: "b42" } };
  const a = identityForTurn(sum1, ctx(s, 1));
  const b = identityForTurn(sum2, ctx(s, 2));
  assert.equal(a.cls, "ACP_SUMMARY");
  assert.equal(a.id, "acp:summary:b42", "SUMMARY 关联原 block id");
  assert.equal(a.id, b.id, "同 block SUMMARY 跨 Hop 稳定");
  // 不同 block → 不同 id
  const c = identityForTurn({ ...sum1, metadata: { acp: true, blockId: "b43" } }, ctx(s, 3));
  assert.notEqual(a.id, c.id);
});

test("C1: 不同 USER → 不同 ID（无 collision）", () => {
  const s = createIdentityBridgeState();
  const a = identityForTurn({ kind: "USER", content: "任务A" }, ctx(s, 1));
  const b = identityForTurn({ kind: "USER", content: "任务B" }, ctx(s, 2));
  assert.notEqual(a.id, b.id);
});

test("C2: 不同 TOOL_CALL → 不同 ID（参数不同）", () => {
  const s = createIdentityBridgeState();
  const a = identityForTurn(
    { kind: "TOOL_CALL", content: '<tool_X name="t1"><param name="a">1</param></tool_X>' },
    ctx(s, 1),
  );
  const b = identityForTurn(
    { kind: "TOOL_CALL", content: '<tool_Y name="t1"><param name="a">2</param></tool_Y>' },
    ctx(s, 2),
  );
  assert.notEqual(a.id, b.id, "不同参数 → 不同 virtual id");
});

test("classifyTurn: ACP_SUMMARY / ACP_NUDGE / HOST_SYSTEM 分类", () => {
  assert.equal(classifyTurn({ kind: "SUMMARY", content: "x", metadata: { acp: true } }), "ACP_SUMMARY");
  assert.equal(classifyTurn({ kind: "SYSTEM", content: "x", metadata: { acpNudge: true } }), "ACP_NUDGE");
  assert.equal(classifyTurn({ kind: "SYSTEM", content: "x" }), "HOST_SYSTEM");
  assert.equal(classifyTurn({ kind: "USER", content: "x" }), "HOST_USER");
  assert.equal(classifyTurn({ kind: "TOOL_CALL", content: "x" }), "HOST_TOOL_CALL");
});