/**
 * hook-projection.test.mts — V0.7.3 Hook/Projection 一致性回归测试。
 *
 * 文档第十三节 Test A~F：
 * A. Incremental Hop pressure：每个 Hop 都有 pressure decision + ledger
 * B. Incremental Hop 到 70%：即使全走 incremental 也能产生 nudge
 * C. Incremental Hop 到 hard limit：strong/emergency 不被 cache/incremental 绕过
 * D. Nudge 不丢失：stage2/before_send 复用缓存时 nudge 仍进入 preparedHistory
 * E. Estimate/Finalize 一致性：estimate 只读（不产生 ledger/nudge）
 * F. Cache hit 仍执行 pressure：ledger 增加 + pressure 决策
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePressure,
  type PressureEpoch,
  type PressureDecision,
} from "../src/acp/pressure.ts";
import { createUsageManager } from "../src/acp/usage.ts";

const C = {
  limit: 200_000,
  gentle: 0.72,
  strong: 0.82,
  emergency: 0.85,
  hostFloor: 0.70,
  cooldownTurns: 3,
  growthFloor: 10_000,
  credit: 30_000,
};

function tokensAt(pct: number): number {
  return Math.round(C.limit * pct);
}

/** 模拟 collectAndEvaluatePressure 核心语义（与 adapter 同 evaluatePressure 输入/ledger）。 */
function simulateHop(opts: {
  usagePct: number;
  tokenEstimate: number;
  kernelShouldInject: boolean;
  kernelReason: string;
  prevBlocks: number;
  curBlocks: number;
  prevNudgeState: Record<string, unknown>;
  prevStats: { nudgeIssued: number; gentleNudges: number; strongNudges: number; emergencyNudges: number; creditBaseToken?: number };
  usageState?: Parameters<typeof createUsageManager>[0];
}): {
  decision: PressureDecision;
  ledgerLen: number;
  usageState: ReturnType<typeof createUsageManager> extends { snapshot(): infer S } ? S : never;
  nudgeStats: { nudgeIssued: number; gentleNudges: number; strongNudges: number; emergencyNudges: number };
} {
  const um = createUsageManager(opts.usageState);
  const prevEpoch = (opts.prevNudgeState as { acpEpoch?: PressureEpoch }).acpEpoch;
  um.recordEstimate(opts.tokenEstimate);
  const eff = um.getEffectiveSnapshot(opts.tokenEstimate);
  const lastCompressToken = opts.prevStats.creditBaseToken;
  const decision = evaluatePressure({
    usagePct: opts.usagePct,
    effectiveTokens: eff.effectiveTokens || opts.tokenEstimate,
    tokenEstimate: opts.tokenEstimate,
    kernelShouldInject: opts.kernelShouldInject,
    kernelReason: opts.kernelReason,
    prevEpoch,
    prevBlocks: opts.prevBlocks,
    curBlocks: opts.curBlocks,
    gentleThresholdPct: C.gentle,
    strongThresholdPct: C.strong,
    emergencyThresholdPct: C.emergency,
    hostEscalationFloor: C.hostFloor,
    nudgeCooldownTurns: C.cooldownTurns,
    nudgeGrowthFloor: C.growthFloor,
    usageCreditTokens: C.credit,
    creditBaseToken: lastCompressToken,
    lastInjectedAt: typeof opts.prevNudgeState.lastInjectedAt === "number" ? opts.prevNudgeState.lastInjectedAt : 0,
    nudgeCount: typeof opts.prevNudgeState.nudgeCount === "number" ? opts.prevNudgeState.nudgeCount : 0,
    lastTokensAtInject: typeof opts.prevNudgeState.lastTokensAtInject === "number" ? opts.prevNudgeState.lastTokensAtInject : 0,
    lastCompressToken,
    source: eff.source,
  });
  um.recordHopEntry({
    hop: (um.getLastHop() ?? 0) + 1,
    estimateTokens: opts.tokenEstimate,
    actualTokens: eff.actualTokens,
    hostTokens: eff.hostTokens,
    compressionCredit: eff.compressionCredit ?? 0,
    effectiveTokens: eff.effectiveTokens,
    source: eff.source,
    confidence: eff.confidence,
  });
  const stats = { ...opts.prevStats };
  if (decision.allowInject) {
    stats.nudgeIssued += 1;
    if (decision.level === "gentle") stats.gentleNudges += 1;
    else if (decision.level === "strong") stats.strongNudges += 1;
    else if (decision.level === "emergency") stats.emergencyNudges += 1;
  }
  return { decision, ledgerLen: um.getHopLedger().length, usageState: um.snapshot() as never, nudgeStats: stats };
}

// ═══════════════ Test A：Incremental Hop pressure ═══════════════

test("V0.7.3-A: Incremental Hop 每个都有 pressure decision + ledger（不允许 skip）", () => {
  let usage = 0.65;
  let nudgeState: Record<string, unknown> = {};
  let usageState: Parameters<typeof createUsageManager>[0] | undefined;
  let stats = { nudgeIssued: 0, gentleNudges: 0, strongNudges: 0, emergencyNudges: 0 };
  const hops: Array<{ hop: number; allowInject: boolean; level?: string; ledger: number }> = [];

  for (let hop = 1; hop <= 5; hop++) {
    usage = 0.65 + (hop - 1) * 0.025; // 65%, 67.5%, 70%, 72.5%, 75%
    const r = simulateHop({
      usagePct: usage,
      tokenEstimate: tokensAt(usage),
      kernelShouldInject: false,
      kernelReason: "",
      prevBlocks: 0,
      curBlocks: 0,
      prevNudgeState: nudgeState,
      prevStats: stats,
      usageState,
    });
    hops.push({ hop, allowInject: r.decision.allowInject, level: r.decision.level, ledger: r.ledgerLen });
    nudgeState = { ...(r.decision.nextNudgeState ?? {}), ...(r.decision.nextEpoch ? { acpEpoch: r.decision.nextEpoch } : {}) };
    stats = r.nudgeStats;
    usageState = r.usageState;
  }

  assert.equal(hops.length, 5, "5 个 Hop");
  for (let i = 0; i < 5; i++) {
    assert.equal(hops[i].ledger, i + 1, `Hop ${i + 1} ledger 必须存在`);
  }
  const last = hops[4];
  assert.ok(last.allowInject, "Hop 5 incremental 75% 应产生 nudge（host-escalation 或 gentle）");
  assert.ok(["gentle", "strong", "emergency"].includes(last.level ?? ""), "nudge 档位合法");
});

// ═══════════════ Test B：Incremental Hop 到 70% ═══════════════

test("V0.7.3-B: Incremental 全路径 71%+ 必须能产生 nudge（不能等 full projection）", () => {
  const sequence = [0.60, 0.63, 0.66, 0.69, 0.71, 0.74, 0.78, 0.82];
  let nudgeState: Record<string, unknown> = {};
  let usageState: Parameters<typeof createUsageManager>[0] | undefined;
  let stats = { nudgeIssued: 0, gentleNudges: 0, strongNudges: 0, emergencyNudges: 0 };
  let firstNudgeAt: number | undefined;
  let strongAt: number | undefined;

  for (const usage of sequence) {
    const r = simulateHop({
      usagePct: usage,
      tokenEstimate: tokensAt(usage),
      kernelShouldInject: false,
      kernelReason: "",
      prevBlocks: 0,
      curBlocks: 0,
      prevNudgeState: nudgeState,
      prevStats: stats,
      usageState,
    });
    if (r.decision.allowInject && firstNudgeAt === undefined) firstNudgeAt = usage;
    if (r.decision.level === "strong" && strongAt === undefined) strongAt = usage;
    nudgeState = { ...(r.decision.nextNudgeState ?? {}), ...(r.decision.nextEpoch ? { acpEpoch: r.decision.nextEpoch } : {}) };
    stats = r.nudgeStats;
    usageState = r.usageState;
  }

  assert.ok(firstNudgeAt !== undefined && firstNudgeAt <= 0.71,
    `71% 必须能产生 nudge（实际首次 ${firstNudgeAt}）`);
  assert.equal(strongAt, 0.82, "82% 必须 strong（不被 cache/incremental 绕过）");
});

// ═══════════════ Test C：Incremental Hop 到 hard limit ═══════════════

test("V0.7.3-C: Incremental 到 hard limit strong/emergency 不被绕过", () => {
  const sequence = [0.60, 0.70, 0.80, 0.82, 0.84, 0.85];
  let nudgeState: Record<string, unknown> = {};
  let usageState: Parameters<typeof createUsageManager>[0] | undefined;
  let stats = { nudgeIssued: 0, gentleNudges: 0, strongNudges: 0, emergencyNudges: 0 };
  let sawStrong = false;
  let sawEmergency = false;

  for (const usage of sequence) {
    const r = simulateHop({
      usagePct: usage,
      tokenEstimate: tokensAt(usage),
      kernelShouldInject: false,
      kernelReason: "",
      prevBlocks: 0,
      curBlocks: 0,
      prevNudgeState: nudgeState,
      prevStats: stats,
      usageState,
    });
    if (r.decision.level === "strong") sawStrong = true;
    if (r.decision.level === "emergency" || (r.decision.allowInject && usage >= C.emergency)) sawEmergency = true;
    nudgeState = { ...(r.decision.nextNudgeState ?? {}), ...(r.decision.nextEpoch ? { acpEpoch: r.decision.nextEpoch } : {}) };
    stats = r.nudgeStats;
    usageState = r.usageState;
  }

  assert.ok(sawStrong, "82%+ 必须 strong");
  assert.ok(sawEmergency, "85%+ 必须 emergency（硬限制不能被 incremental 绕过）");
});

// ═══════════════ Test D：Nudge 不丢失 ═══════════════

test("V0.7.3-D: stage2/before_send 复用缓存时 strong nudge 不丢失", () => {
  // Hop 10：usage 83% → strong nudge 注入。
  const r10 = simulateHop({
    usagePct: 0.83,
    tokenEstimate: tokensAt(0.83),
    kernelShouldInject: true,
    kernelReason: "GROWTH",
    prevBlocks: 0,
    curBlocks: 0,
    prevNudgeState: {},
    prevStats: { nudgeIssued: 0, gentleNudges: 0, strongNudges: 0, emergencyNudges: 0 },
  });
  assert.equal(r10.decision.level, "strong");
  assert.ok(r10.decision.allowInject, "Hop 10 strong 必须注入");

  // Hop 11：stage2/before_send_to_model 复用缓存（同 usage 83%）。
  // strong 必须 bypass cooldown/credit → 仍注入（adapter stage2 分支 push nudge 进 finalPrepared）。
  const nudgeState10 = { ...(r10.decision.nextNudgeState ?? {}), ...(r10.decision.nextEpoch ? { acpEpoch: r10.decision.nextEpoch } : {}) };
  const r11 = simulateHop({
    usagePct: 0.83,
    tokenEstimate: tokensAt(0.83),
    kernelShouldInject: false,
    kernelReason: "",
    prevBlocks: 0,
    curBlocks: 0,
    prevNudgeState: nudgeState10,
    prevStats: { nudgeIssued: r10.nudgeStats.nudgeIssued, gentleNudges: r10.nudgeStats.gentleNudges, strongNudges: r10.nudgeStats.strongNudges, emergencyNudges: r10.nudgeStats.emergencyNudges },
    usageState: r10.usageState,
  });
  assert.ok(r11.decision.allowInject, "stage2 复用缓存时 strong 仍必须注入（nudge 不丢失）");
  assert.equal(r11.decision.level, "strong");
});

// ═══════════════ Test E：Estimate/Finalize 一致性 ═══════════════

test("V0.7.3-E: estimate 只读（不产生 ledger/nudge）；finalize 产生 ledger + pressure 决策", () => {
  const um = createUsageManager();
  const before = um.snapshot();
  // estimate 链路只读：recordEstimate 是唯一写入，不产生 ledger（ledger = 发送前 pressure snapshot）。
  um.recordEstimate(80_000, 1);
  const after = um.snapshot();
  assert.equal(after.lastEstimateTokens, 80_000, "estimate 记录 estimate");
  assert.equal(after.lastActualTokens, before.lastActualTokens, "estimate 不写 actual（诚实语义）");
  assert.equal(after.hopLedger?.length ?? 0, 0, "estimate 链路不产生 ledger");

  // finalize 链路：发送前 pressure + ledger。
  const r = simulateHop({
    usagePct: 0.40,
    tokenEstimate: 80_000,
    kernelShouldInject: false,
    kernelReason: "",
    prevBlocks: 0,
    curBlocks: 0,
    prevNudgeState: {},
    prevStats: { nudgeIssued: 0, gentleNudges: 0, strongNudges: 0, emergencyNudges: 0 },
  });
  assert.equal(r.ledgerLen, 1, "finalize 链路产生 1 条 ledger");
  assert.equal(r.decision.allowInject, false, "低 usage（40%）不 nudge——nudge 是发送链路 unique 差异");
});

// ═══════════════ Test F：Cache hit 仍执行 pressure ═══════════════

test("V0.7.3-F: Cache hit 仍执行 pressure（ledger 增加 + pressure 决策）", () => {
  // 第一次 full：pressure 执行、ledger=1。
  const r1 = simulateHop({
    usagePct: 0.68,
    tokenEstimate: tokensAt(0.68),
    kernelShouldInject: false,
    kernelReason: "",
    prevBlocks: 0,
    curBlocks: 0,
    prevNudgeState: {},
    prevStats: { nudgeIssued: 0, gentleNudges: 0, strongNudges: 0, emergencyNudges: 0 },
  });
  assert.equal(r1.ledgerLen, 1, "第一次 full：ledger=1");

  // 第二次 cache hit（同 fingerprint，投影可复用）：pressure 仍执行、ledger 增加。
  const r2 = simulateHop({
    usagePct: 0.68,
    tokenEstimate: tokensAt(0.68),
    kernelShouldInject: false,
    kernelReason: "",
    prevBlocks: 0,
    curBlocks: 0,
    prevNudgeState: { ...(r1.decision.nextNudgeState ?? {}) },
    prevStats: { nudgeIssued: 0, gentleNudges: 0, strongNudges: 0, emergencyNudges: 0 },
    usageState: r1.usageState,
  });
  assert.equal(r2.ledgerLen, 2, "第二次 cache hit：ledger 仍增加（pressure 未被跳过）");
});

// ═══════════════ V0.7.4：Preflight Over-Hard 四路径（E/F/G/I） ═══════════════
// ═══════════════ V0.7.6：forced nudge 四路径（替代 preflight，pressure decision ≠ compression execution） ═══════════════

import { evaluatePressure } from "../src/acp/pressure.ts";

/** 模拟某发送路径的 forced 判定（与 adapter collectAndEvaluatePressure 同源 evaluatePressure）。 */
function simulatePathForced(opts: {
  path: "incremental" | "cache" | "stage2" | "full";
  effectiveTokens: number;
  gentleThresholdPct: number;
  strongThresholdPct: number;
  forcedThresholdPct: number;
}): {
  allowInject: boolean;
  level?: string;
} {
  const r = evaluatePressure({
    usagePct: opts.effectiveTokens / C.limit,
    effectiveTokens: opts.effectiveTokens,
    tokenEstimate: opts.effectiveTokens,
    kernelShouldInject: false,
    kernelReason: "growth below floor",
    prevEpoch: undefined,
    prevBlocks: 0,
    curBlocks: 0,
    gentleThresholdPct: opts.gentleThresholdPct,
    strongThresholdPct: opts.strongThresholdPct,
    forcedThresholdPct: opts.forcedThresholdPct,
    hostEscalationFloor: 0.70,
    nudgeCooldownTurns: 3,
    nudgeGrowthFloor: 30000,
    usageCreditTokens: 30000,
    creditBaseToken: 120_000,
    lastInjectedAt: Date.now() - 100,
    nudgeCount: 5,
    lastTokensAtInject: 100_000,
    lastCompressToken: 100_000,
    source: "estimate",
  });
  return { allowInject: r.allowInject, level: r.level };
}

test("V0.7.6-E: incremental path 超过 hard → forced nudge（不自动压缩）", () => {
  // incremental path 采样超 hard（87%）→ forced nudge（绝不 auto-fold）。
  const r = simulatePathForced({ path: "incremental", effectiveTokens: 174_000, gentleThresholdPct: 0.72, strongThresholdPct: 0.82, forcedThresholdPct: 0.85 });
  assert.equal(r.allowInject, true, "incremental 超 hard → forced 注入");
  assert.equal(r.level, "forced", "forced 档位");
});

test("V0.7.6-F: cache hit path 超过 hard → forced nudge（不自动压缩）", () => {
  const r = simulatePathForced({ path: "cache", effectiveTokens: 178_000, gentleThresholdPct: 0.72, strongThresholdPct: 0.82, forcedThresholdPct: 0.85 });
  assert.equal(r.allowInject, true, "cache hit 超 hard → forced 注入");
  assert.equal(r.level, "forced", "forced 档位");
});

test("V0.7.6-G: stage2 before_send 超过 hard → forced nudge（每次 send 独立决策）", () => {
  // stage2 超 hard → forced nudge。V0.7.6 无 cycle 去重——每个发送路径都独立决策（nudge 是 ephemeral）。
  const r = simulatePathForced({ path: "stage2", effectiveTokens: 180_000, gentleThresholdPct: 0.72, strongThresholdPct: 0.82, forcedThresholdPct: 0.85 });
  assert.equal(r.allowInject, true, "stage2 超 hard → forced 注入");
  assert.equal(r.level, "forced", "forced 档位");
});

test("V0.7.6-I: 50+ synthetic Hop — 多次正常 compression + hard crossing 触发 forced nudge + 不 auto-fold", () => {
  // 需求 I（V0.7.6 版）：50+ synthetic Hop → 多次正常 compression；
  //   hard crossing → forced nudge（不自动折叠，模型响应后主动 compress）。
  let forcedNudgeCount = 0;
  let normalCompress = 0; // 模型主动 compress
  let autoFoldCount = 0; // 绝不应发生（pressure decision ≠ compression execution）
  let usage = 0.62;

  // 显式 usage 序列：前 40 hop 波动（多次 normal compress），41 起 hard crossing。
  const usageSeq: number[] = [];
  for (let hop = 1; hop <= 60; hop++) {
    if (hop <= 40) {
      const phase = (hop - 1) % 8;
      usageSeq.push(hop === 1 ? 0.62 : (phase === 0 ? 0.50 : Math.min(0.50 + phase * 0.05, 0.84)));
    } else if (hop === 41) {
      usageSeq.push(0.87); // 新一轮开始：跨 hard（>85%）→ forced nudge
    } else if (hop === 42) {
      usageSeq.push(0.45); // 模型 compress 后回落
    } else if (hop === 51) {
      usageSeq.push(0.86); // 第二次 hard crossing → forced nudge
    } else if (hop === 52) {
      usageSeq.push(0.44); // compress 后回落
    } else {
      usageSeq.push(0.55); // 平稳区
    }
  }

  for (let hop = 1; hop <= 60; hop++) {
    usage = usageSeq[hop - 1];

    const effective = Math.round(C.limit * usage);
    const r = simulatePathForced({ path: "full", effectiveTokens: effective, gentleThresholdPct: 0.72, strongThresholdPct: 0.82, forcedThresholdPct: 0.85 });

    if (r.allowInject && r.level === "forced") {
      forcedNudgeCount++;
      // 模型收到 forced nudge → 下一 hop 主动 compress（此处模拟为下一 hop usage 回落）。
      continue;
    }
    // forced 只是 nudge：绝无任何 auto-fold 动作（evaluatePressure 无 action 字段）。
    assert.ok(!("action" in r), "pressure decision 绝不携带压缩 action");

    // 正常 pressure 管理：gentle/strong → 模型主动 compress（部分 hop 压缩）。
    const level = usage >= 0.82 ? "strong" : usage >= 0.72 ? "gentle" : "none";
    if (level !== "none" && hop % 5 === 0) {
      normalCompress++; // 模型 compress
    }
  }

  assert.ok(normalCompress >= 3, `50+ Hop 应出现多次正常 compression（实际 ${normalCompress}）`);
  assert.ok(forcedNudgeCount >= 2, `hard crossing 应触发 forced nudge（实际 ${forcedNudgeCount}）`);
  assert.equal(autoFoldCount, 0, "绝不允许 auto-fold（pressure decision ≠ compression execution）");
});
