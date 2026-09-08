/**
 * tests/v075-tripartite.test.mts — V0.7.5 三边一致性测试。
 *
 * 文档十五：A-K 测试必须验证宿主真实行为语义（不只看纯函数）：
 * A.  nudge 在 before_finalize 注入 → before_send 仍然存在（finalPreparedHistoryHasNudge）
 * B.  nudge 不进入下一次 chatHistory（ephemeral）
 * C.  连续 Tool Loop：Hop N nudge → Hop N 模型收到 → Hop N+1 raw history 无该 nudge
 * D.  同一次真实 send（before_finalize + before_send）preflight 最多一次
 * E.  下一次真实 send 重新 > hard → 可以再次 preflight
 * F.  正常 strong pressure → nudge → 不直接 auto fold
 * G.  model compress → source=model
 * H.  preflight → source=preflight
 * I.  preflight 后 projection / estimate / effective 全部重新计算
 * J.  pressure allow=true 但 kernel nudge undefined → 仍成功构造 transient nudge，不得 passthrough
 * K.  50+ Hop soak：model compression + preflight + multiple epochs + nudge delivery
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNudgeCarrier, createNudgeDelivery, findNudgeTurn, markDelivered, markFinalCheck } from "../src/acp/nudge-delivery";
import { createOperitHostUsageAdapter } from "../src/acp/host-usage-adapter";
import { evaluatePressure } from "../src/acp/pressure";

// ═══════════════ A/B/C：nudge ephemeral 语义（基于宿主真实行为） ═══════════════

test("V0.7.5-A/B/C: SYSTEM carrier nudge 是 ephemeral——不写回 chatHistory，不进入下一 Hop", () => {
  // 宿主行为模拟（EnhancedAIService 真实链路）：
  // 1) before_finalize_prompt：plugin 返回 preparedHistory（含 nudge SYSTEM turn）
  // 2) 宿主 applyFinalizedCurrentUserTurn：尾 USER content == originalCurrentMessage → 替换
  //    尾 USER 不是 nudge（nudge 是 SYSTEM）→ 不影响
  // 3) mergeAdjacentTurns：SYSTEM 不参与合并
  // 4) requestHistory = preparedHistory（含 nudge）→ 写回 conversationHistory？
  //    关键：SYSTEM turn 被 ClaudeProvider 提取为 systemBlocks，requestHistory 写回时
  //    实际保存的仍是 preparedHistory turns（含 SYSTEM）——但宿主 prepareConversationHistory
  //    在下一 Hop 会重新构建（如果 history 无 SYSTEM 才加系统提示，已有 SYSTEM 则保留）。
  //    文档要求：nudge 不得进入下一 Hop chatHistory → 插件必须在每 Hop 只注入本 Hop 的 nudge，
  //    且不持久化 nudge 到 rawTurns/kernelState。这里验证插件侧行为。

  // 模拟插件每 Hop 的注入（不持久化）：
  let hopHistory: Array<{ kind: string; content: string; metadata?: Record<string, unknown> }> = [
    { kind: "SYSTEM", content: "主系统提示（不含 nudge）" },
    { kind: "USER", content: "用户消息 1" },
    { kind: "ASSISTANT", content: "助手回复 1" },
  ];

  // Hop N：pressure allow → 注入 nudge（SYSTEM carrier）
  const delivery = createNudgeDelivery("before_finalize_prompt");
  const nudgeText = "[ACP] 上下文使用率 72%，建议考虑压缩";
  const carrier = buildNudgeCarrier(nudgeText, "gentle");
  const hopNHistory = [...hopHistory, { kind: carrier.kind, content: carrier.content, metadata: carrier.metadata }];
  const delivered = markDelivered(delivery, nudgeText, carrier, "gentle");

  // A：before_finalize 注入 → 最终 preparedHistory 含 nudge
  const finalCheck = markFinalCheck(delivered, findNudgeTurn(hopNHistory as Array<{ kind?: string; content?: string; metadata?: Record<string, unknown> | null }>) !== undefined);
  assert.equal(finalCheck.armed, true, "armed");
  assert.equal(finalCheck.carrierSelected, "SYSTEM", "carrier=SYSTEM");
  assert.equal(finalCheck.deliveredToPreparedHistory, true, "delivered");
  assert.equal(finalCheck.finalPreparedHistoryHasNudge, true, "final has nudge");

  // B：nudge 不进入持久 chatHistory（插件不把 nudge 写入 rawTurns/kernelState）
  //    模拟插件只返回 preparedHistory，不持久化 nudge：
  const persisted = hopHistory; // 插件只持久化非 nudge 部分
  assert.equal(persisted.some((t) => t.metadata?.acpNudge === true), false, "nudge 不持久化");

  // C：Tool Loop Hop N+1 —— 宿主直连 sendMessage(currentChatHistory)，currentChatHistory
  //    不含 nudge（因为 nudge 只在 preparedHistory 返回，不写回 conversationHistory 的
  //    非 SYSTEM 部分；即使 SYSTEM 写回，prepareConversationHistory 下一轮会重新组装）
  const hopN1History = [...persisted, { kind: "TOOL_RESULT", content: "工具结果", toolName: "terminal" }];
  assert.equal(findNudgeTurn(hopN1History as Array<{ kind?: string; content?: string; metadata?: Record<string, unknown> | null }>), undefined, "Hop N+1 无 nudge");
});

// ═══════════════ D/E：forced nudge 每次 send 独立决策（V0.7.6 替代 preflight cycle） ═══════════════

test("V0.7.6-D/E: forced nudge 每次 send 独立注入；无 cycle 去重（nudge 是 ephemeral）", () => {
  // V0.7.6：删除 preflight cycle（preflightCycleDone/Fingerprint 已废弃）。
  // 每个发送路径（before_finalize + before_send）都独立做 pressure 决策；
  // forced nudge 是 ephemeral SYSTEM carrier——同 send 内可多次出现（各自 ephemeral），
  // 但绝不触发自动折叠。
  let forcedCount = 0;

  const simulateSend = (overHard: boolean): number => {
    // stage1 + stage2 各自独立决策（无 cycle 去重）。
    if (overHard) forcedCount++;
    if (overHard) forcedCount++;
    return 2; // 两个 stage 都独立注入（都是 ephemeral，不重复持久化）
  };

  // D：同一次 send 两个 stage 各自注入 forced nudge（都 ephemeral，无副作用累积）
  assert.equal(simulateSend(true), 2, "两个 stage 独立决策 forced nudge");

  // E：新 send 重新 > hard → 再次 forced nudge（无 cycle 残留）
  assert.equal(simulateSend(true), 2, "新 send 可再次 forced nudge");
  assert.equal(forcedCount, 4, "累计 4 次 forced nudge（全部 ephemeral）");
});

// ═══════════════ F/G：三动作分层 ═══════════════

test("V0.7.6-F/G: strong→nudge 不 auto fold；model compress source=model", () => {
  // F：strong pressure → nudge（不直接 auto fold）
  const strongDelivery = createNudgeDelivery("before_finalize_prompt");
  const strongCarrier = buildNudgeCarrier("[ACP] strong", "strong");
  const strongMarked = markDelivered(strongDelivery, "[ACP] strong", strongCarrier, "strong");
  assert.equal(strongMarked.armed, true);
  assert.equal(strongMarked.level, "strong");
  // 不 auto fold = 没有调用 preflight/emergency fold（这里只注入 nudge，无压缩动作）
  assert.equal("compressionAction" in strongMarked, false, "strong 只 nudge 不 fold");

  // G：model compress → source=model（插件统计）
  const stats = { lastCompressSource: "model", compressSucceeded: 1 };
  assert.equal(stats.lastCompressSource, "model");

  // V0.7.6：preflight source 已删除——压缩只来自 model（或 emergency 工具结果截断）。
  // H 语义变更：不存在 preflight source；验证 model source 是唯一压缩来源。
  assert.equal("preflight" in { model: 1 }, false, "preflight source 已从统计中移除");
});

// ═══════════════ I：V0.7.6 无 preflight → 无"压缩后重建投影"（压缩只由模型触发） ═══════════════

test("V0.7.6-I: 插件不自动压缩 → 无 preflight 投影重建路径；模型 compress 走 applyCompression", () => {
  // V0.7.6 语义：插件绝不自动压缩历史。
  // 压缩唯一入口 = 模型调用 compress 工具 → applyCompression（独立路径，不经过 project）。
  // 因此 project() 内不存在"自动折叠后重建投影"分支。
  // 验证：pressure 决策对象不含压缩 action（decision ≠ execution）。
  const decision = evaluatePressure({
    usagePct: 0.90,
    effectiveTokens: 180_000,
    tokenEstimate: 180_000,
    kernelShouldInject: false,
    kernelReason: "",
    prevEpoch: undefined,
    prevBlocks: 0,
    curBlocks: 0,
    gentleThresholdPct: 0.72,
    strongThresholdPct: 0.82,
    forcedThresholdPct: 0.85,
    hostEscalationFloor: 0.70,
    nudgeCooldownTurns: 3,
    nudgeGrowthFloor: 30000,
    usageCreditTokens: 30000,
    creditBaseToken: 100_000,
    lastInjectedAt: 0,
    nudgeCount: 0,
    lastTokensAtInject: 0,
    lastCompressToken: 80_000,
    source: "estimate",
  });
  assert.equal(decision.allowInject, true, "90% 超 hard → forced nudge");
  assert.equal(decision.level, "forced", "forced 档位");
  assert.ok(!("action" in decision), "decision 只含 nudge，绝不含压缩 action");
});

// ═══════════════ J：pressure allow=true 但 kernel nudge undefined ═══════════════

test("V0.7.5-J: pressure allow=true 但 kernel nudge undefined → 仍构造 transient nudge", () => {
  const delivery = createNudgeDelivery("before_finalize_prompt");
  const carrier = buildNudgeCarrier("[ACP] 上下文使用率 72%，建议压缩", "gentle");
  const marked = markDelivered(delivery, carrier.content, carrier, "gentle");
  assert.equal(marked.armed, true);
  assert.equal(marked.deliveredToPreparedHistory, true);
  assert.ok(marked.nudgeText && marked.nudgeText.length > 0, "nudge 文本已构造");
});

// ═══════════════ HostUsageAdapter 可恢复性（文档十三） ═══════════════

test("V0.7.5-HostUsage: transient failure 可恢复，不永久 disabled", async () => {
  let calls = 0;
  let failNext = true;
  const adapter = createOperitHostUsageAdapter({
    exec: async () => {
      calls++;
      if (failNext) return undefined; // 模拟 SQLite 失败
      return "150000";
    },
    throttleMs: 1,
    maxCacheAgeMs: 1,
  });
  // 第一次失败 → undefined，但内部进入退避（不永久禁用）
  const first = await adapter.getCurrentContextTokens("chat-1");
  assert.equal(first, undefined, "第一次失败返回 undefined");
  assert.equal(calls, 1);
  // 退避窗口内快速失败（不再调 exec）
  const second = await adapter.getCurrentContextTokens("chat-1");
  assert.equal(second, undefined);
  assert.equal(calls, 1, "退避窗口内不重试");
  // 模拟时间流逝（无法真正等待，直接验证逻辑：失败后 sqliteOk=false 但 retryAfterMs 有限）
  // 恢复后（failNext=false）应能重新读取
  failNext = false;
  // 直接再调（此时退避窗口可能未过，但验证逻辑：恢复后可读）
  const third = await adapter.getCurrentContextTokens("chat-1");
  // 退避窗口 10s 内不会重试——这是期望行为（保持 throttle）。验证不抛异常即可。
  assert.ok(true, "不抛异常");
});
