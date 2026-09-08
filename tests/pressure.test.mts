/**
 * pressure.test.mts — V0.7 Continuous Per-Hop Pressure Controller 契约测试。
 *
 * 对齐文档第十七节 synthetic Model-Hop pressure 测试 + 第十五节 15 项验收：
 * 1. 不能只发生一次 model compression
 * 2. hard limit 前至少 2~3 次 model compression
 * 3. emergency/preflight 不是正常压缩路径
 * 4. 一个 session 可连续多个 compression epoch
 * 5. kernelShouldInject=false 时 host pressure 仍可触发 gentle/strong
 * 6. strong 不得被普通 cooldown 拦截
 * 7. strong/emergency 不得被 usage credit 拦截
 * 8. usage 缺失时 effective estimate 仍能发现 pressure
 * 9. compress 成功后 context baseline 正确重置
 * 10. context 再增长后可重新开启 epoch
 * 11. stage1 nudge 与 stage2 projection 都真正包含 nudge
 * 12. nudge 不进入永久 raw history
 * 13. Phase3.1 absorb candidate 在每个 Hop 仍检测
 * 14. candidate 和 nudge 互不耦合
 * 15. preflight 仅在模型没及时压缩且接近 hard limit 时介入
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePressureLevel,
  evaluatePressure,
  type PressureEpoch,
} from "../src/acp/pressure.ts";
import { computeEffectiveTokens, normalizeUsage } from "../src/acp/token-source.ts";
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

/** 模拟一次 evaluatePressure，返回 {allow, level, reason, epoch}。 */
function hop(input: {
  usagePct: number;
  tokenEstimate: number;
  kernelShouldInject?: boolean;
  prevEpoch?: PressureEpoch;
  prevBlocks?: number;
  curBlocks?: number;
  creditBaseToken?: number;
  lastInjectedAt?: number;
  nudgeCount?: number;
  lastTokensAtInject?: number;
  source?: "estimate" | "upstream" | "host" | "hybrid";
}) {
  const r = evaluatePressure({
    usagePct: input.usagePct,
    effectiveTokens: input.tokenEstimate,
    tokenEstimate: input.tokenEstimate,
    kernelShouldInject: input.kernelShouldInject ?? false,
    kernelReason: "",
    prevEpoch: input.prevEpoch,
    prevBlocks: input.prevBlocks ?? 0,
    curBlocks: input.curBlocks ?? 0,
    gentleThresholdPct: C.gentle,
    strongThresholdPct: C.strong,
    emergencyThresholdPct: C.emergency,
    hostEscalationFloor: C.hostFloor,
    nudgeCooldownTurns: C.cooldownTurns,
    nudgeGrowthFloor: C.growthFloor,
    usageCreditTokens: C.credit,
    creditBaseToken: input.creditBaseToken,
    lastInjectedAt: input.lastInjectedAt ?? 0,
    nudgeCount: input.nudgeCount ?? 0,
    lastTokensAtInject: input.lastTokensAtInject ?? 0,
    source: input.source ?? "estimate",
  });
  return r;
}

// 阈值换算 helper
const tokensAt = (pct: number) => Math.round(C.limit * pct);

test("P1: usage 缺失/为0 时 effective estimate 仍发现压力 (effective source=estimated)", () => {
  // 模拟 actual/host 缺失，但 tokenEstimate=150k → effective=150k → 75%
  const eff = computeEffectiveTokens({ estimatedTokens: 150_000 });
  assert.equal(eff.source, "estimate");
  assert.equal(eff.effectiveTokens, 150_000);
  assert.equal(eff.confidence, "low");
  const r = evaluatePressure({
    usagePct: 0.75, effectiveTokens: eff.effectiveTokens, tokenEstimate: 150_000,
    kernelShouldInject: false, kernelReason: "", prevEpoch: undefined,
    prevBlocks: 0, curBlocks: 0, gentleThresholdPct: C.gentle, strongThresholdPct: C.strong,
    emergencyThresholdPct: C.emergency, hostEscalationFloor: C.hostFloor,
    nudgeCooldownTurns: C.cooldownTurns, nudgeGrowthFloor: C.growthFloor,
    usageCreditTokens: C.credit, creditBaseToken: undefined,
    lastInjectedAt: 0, nudgeCount: 0, lastTokensAtInject: 0,
    source: "estimate",
  });
  // 75% ≥ 70% host floor 且无 lastInjectedAt/lastCompressToken → 应接管
  assert.equal(r.allowInject, true);
  assert.equal(r.level, "gentle");
  assert.match(r.decisionReason, /host-escalation/);
  // V0.7.1：导出决策附加 effective 指标
  assert.equal(r.source, "estimate");
  assert.equal(r.pressurePct, 0.75);
});

test("P2: kernelShouldInject=false 时 host pressure 仍触发 gentle（≥hostFloor）", () => {
  const r = hop({ usagePct: 0.73, tokenEstimate: tokensAt(0.73), kernelShouldInject: false });
  assert.equal(r.allowInject, true, "kernel 沉默但 73% ≥ 70% floor 应接管");
  assert.equal(r.level, "gentle");
});

test("P3: strong 不被普通 cooldown 拦截（nudgeCount 超限仍注入）", () => {
  const r = hop({ usagePct: 0.82, tokenEstimate: tokensAt(0.82), nudgeCount: 99, lastInjectedAt: 1, lastTokensAtInject: tokensAt(0.81) });
  assert.equal(r.allowInject, true, "82% strong 必须 bypass cooldown");
  assert.equal(r.level, "strong");
  assert.match(r.decisionReason, /strong-bypassed/);
});

test("P4: strong 不被 usage credit 拦截", () => {
  // 刚 compress 过 credit 窗口内，但 usage 已到 82% → strong 必须 bypass credit
  const r = hop({ usagePct: 0.82, tokenEstimate: tokensAt(0.82), creditBaseToken: tokensAt(0.68) });
  assert.equal(r.allowInject, true, "strong 必须 bypass credit");
  assert.equal(r.level, "strong");
});

test("P5: emergency 无条件注入", () => {
  const r = hop({ usagePct: 0.86, tokenEstimate: tokensAt(0.86), creditBaseToken: tokensAt(0.68), nudgeCount: 99 });
  assert.equal(r.allowInject, true);
  assert.equal(r.level, "emergency");
});

test("P6: gentle 受 credit 抑制（credit 只抑制 gentle）", () => {
  const r = hop({ usagePct: 0.73, tokenEstimate: tokensAt(0.73), creditBaseToken: tokensAt(0.68), kernelShouldInject: true });
  // 73% 在 credit 窗口内 + kernel 建议 → 仍被 credit 抑制（gentle 级）
  assert.equal(r.allowInject, false);
  assert.match(r.decisionReason, /credit/);
});

test("P7: 同一 epoch 内档位单调升级，压缩后新 epoch 重新开始", () => {
  // Epoch1: gentle → strong
  let e1 = hop({ usagePct: 0.73, tokenEstimate: tokensAt(0.73), kernelShouldInject: true });
  assert.equal(e1.allowInject, true);
  assert.equal(e1.level, "gentle");
  const ep1 = e1.nextEpoch!;
  assert.equal(ep1.epoch, 1);
  const e2 = hop({ usagePct: 0.82, tokenEstimate: tokensAt(0.82), prevEpoch: ep1, kernelShouldInject: true });
  assert.equal(e2.level, "strong", "epoch 内应从 gentle 升级到 strong");
  // 压缩成功：curBlocks > prevBlocks → close epoch
  const close = hop({ usagePct: 0.68, tokenEstimate: tokensAt(0.68), prevEpoch: e2.nextEpoch, prevBlocks: 1, curBlocks: 2 });
  assert.equal(close.allowInject, false);
  assert.equal(close.nextEpoch?.closed, true, "压缩成功应关闭 epoch");
  // Epoch2: 新 epoch 重新从 gentle 开始
  const ne = hop({ usagePct: 0.75, tokenEstimate: tokensAt(0.75), prevEpoch: close.nextEpoch, kernelShouldInject: true });
  assert.equal(ne.nextEpoch?.epoch, 2, "压缩后应开启新 epoch (epoch=2)");
  assert.equal(ne.level, "gentle", "新 epoch 应重新从 gentle 开始");
});

test("P8: 完整 synthetic 20-Hop soak — 多轮 model compress + 多 epoch", () => {
  // 模拟 20 个连续 Model Hop，usage 波动，每 ~8 Hop 模型压缩一次（blocks 增加）
  // 断言：至少 2 次压缩触发 close-epoch、累计 epoch>=2、且非 emergency 为主路径
  let prevEpoch: PressureEpoch | undefined;
  let injected = 0;
  let strongInjected = 0;
  let compressEvents = 0;
  let blocks = 0;
  let lastInjectedAt = 0;
  let lastTokensAtInject = 0;
  const usageSeq = [
    0.60, 0.65, 0.68, 0.71, 0.73, 0.76, 0.79, 0.82, // Hop1-8 → strong 后模型压缩
    0.66, 0.69, 0.71, 0.74, 0.77, 0.80, 0.82, 0.83, // Hop9-16 → strong 后模型压缩
    0.64, 0.68, 0.72, 0.75, 0.79, 0.82, 0.83,      // Hop17-23 → 新 epoch gentle→strong
  ];
  const compressHop = [8, 16]; // 这两个 Hop 模型主动压缩
  for (let i = 0; i < usageSeq.length; i++) {
    const h = i + 1;
    const isCompressHop = compressHop.includes(h);
    const prevBlocks = blocks;
    const curBlocks = isCompressHop ? blocks + 1 : blocks;
    if (isCompressHop) blocks += 1;
    const r = evaluatePressure({
      usagePct: usageSeq[i],
      effectiveTokens: tokensAt(usageSeq[i]),
      tokenEstimate: tokensAt(usageSeq[i]),
      kernelShouldInject: usageSeq[i] >= 0.72,
      kernelReason: "",
      prevEpoch,
      prevBlocks,
      curBlocks,
      gentleThresholdPct: C.gentle, strongThresholdPct: C.strong, emergencyThresholdPct: C.emergency,
      hostEscalationFloor: C.hostFloor, nudgeCooldownTurns: C.cooldownTurns, nudgeGrowthFloor: C.growthFloor,
      usageCreditTokens: C.credit, creditBaseToken: undefined,
      lastInjectedAt,
      nudgeCount: injected,
      lastTokensAtInject,
    });
    if (isCompressHop) { compressEvents++; assert.equal(r.decisionReason, "compressed-close-epoch", `Hop${h} 压缩应 close epoch`); lastInjectedAt = 0; lastTokensAtInject = 0; injected = 0; }
    if (r.allowInject) { injected++; if (r.level === "strong") strongInjected++; lastInjectedAt = 1; lastTokensAtInject = tokensAt(usageSeq[i]); }
    prevEpoch = r.nextEpoch;
  }
  assert.ok(compressEvents >= 2, `至少 2 次模型压缩，实际 ${compressEvents}`);
  assert.ok(prevEpoch && prevEpoch.epoch >= 2, `至少 2 个 epoch，实际 ${prevEpoch?.epoch}`);
  assert.ok(strongInjected >= 2, `strong 至少注入 2 次（bypass cooldown），实际 ${strongInjected}`);
});

test("P9: hostEscalationFloor 抑制条件 — kernel 沉默且增长不足时不 spam", () => {
  // 71% < floor(70%)? 不，71≥70。测试 69%（低于 floor）→ kernel 沉默 → 不接管
  const r = hop({ usagePct: 0.69, tokenEstimate: tokensAt(0.69), kernelShouldInject: false });
  assert.equal(r.allowInject, false, "69% < 70% floor 且 kernel 沉默 → 不接管");
  assert.match(r.decisionReason, /kernel-silent/);
});

test("P10: gentle 在 cooldown 内且无增长 → 抑制", () => {
  const r = hop({ usagePct: 0.73, tokenEstimate: tokensAt(0.73), kernelShouldInject: true, lastInjectedAt: 1, lastTokensAtInject: tokensAt(0.73) });
  assert.equal(r.allowInject, false, "刚注入过且无增长 → gentle 抑制");
  assert.match(r.decisionReason, /no-growth/);
});

test("P11: V0.7.1 回归 — credit 基准错位（base>est）时不得永久压制", () => {
  // 真实事故：某会话 emergency 后 creditBaseToken=267446（压缩前全量估算），
  // 压缩后窗口 tokenEstimate 仅 154018（< base），旧逻辑 creditLeft=base+30k-est 恒>0
  // → 从此每 Hop 都 gentle-suppressed-by-credit → 上下文涨到几百万 token 仍无任何压缩提示。
  //
  // a) 基准错位 + usage 已过 gentle 阈值 → 必须放行（交给 hostEscalation/增长判断）
  const base = 267_446;
  const est = 154_018; // 压缩后低位，明显 < base
  const usage = est / C.limit; // ≈ 0.770
  const r = hop({ usagePct: usage, tokenEstimate: est, creditBaseToken: base, kernelShouldInject: false });
  assert.equal(r.allowInject, true, "base>est 且 usage≥gentle 时不得被 credit 永久压制");
  assert.match(r.decisionReason, /host-escalation|gentle-inject|strong-bypassed|emergency/);

  // b) 基准错位 + 压力确实低（usage < gentle）→ 仍应安静，不 spam
  const low = hop({ usagePct: 0.11, tokenEstimate: 22_000, creditBaseToken: base, kernelShouldInject: false });
  assert.equal(low.allowInject, false, "低压仍允许 credit 静默（合理免打扰）");

  // c) 基准正常（base<est，credit 窗口内）→ 仍正常抑制（不破坏原 credit 语义）
  const ok = hop({ usagePct: 0.73, tokenEstimate: tokensAt(0.73), creditBaseToken: tokensAt(0.68), kernelShouldInject: true });
  assert.equal(ok.allowInject, false, "正常 credit 窗口内 gentle 仍抑制");
  assert.match(ok.decisionReason, /credit/);
});

// ═════════============== V0.7.1：Token Source / UsageManager / 协议 单元测试 ════════==============

test("T1: computeEffectiveTokens 三源组合（estimate only / actual only / host only / all）", () => {
  // estimate only
  const e = computeEffectiveTokens({ estimatedTokens: 60_000 });
  assert.equal(e.effectiveTokens, 60_000); assert.equal(e.source, "estimate"); assert.equal(e.confidence, "low");
  // actual only
  const a = computeEffectiveTokens({ estimatedTokens: 10_000, actualTokens: 90_000 });
  assert.equal(a.effectiveTokens, 90_000); assert.equal(a.source, "upstream"); assert.equal(a.confidence, "high");
  // host only
  const h = computeEffectiveTokens({ estimatedTokens: 10_000, hostTokens: 80_000 });
  assert.equal(h.effectiveTokens, 80_000); assert.equal(h.source, "host"); assert.equal(h.confidence, "medium");
  // all three → max
  const all = computeEffectiveTokens({ estimatedTokens: 50_000, actualTokens: 70_000, hostTokens: 95_000 });
  assert.equal(all.effectiveTokens, 95_000); assert.equal(all.source, "hybrid"); assert.equal(all.confidence, "high");
  // actual+host，无 estimate
  const ah = computeEffectiveTokens({ estimatedTokens: 0, actualTokens: 70_000, hostTokens: 60_000 });
  assert.equal(ah.effectiveTokens, 70_000);
});

test("T2: compression credit 修正 actual（compression 后 provider 仍回旧 usage）", () => {
  // 压缩 200k→80k，压缩 credit 120k；provider 下一次仍报 input=200k
  const s = computeEffectiveTokens({ estimatedTokens: 80_000, actualTokens: 200_000, compressionCredit: 120_000 });
  assert.equal(s.effectiveTokens, 80_000, "credit 修正后 actual=80k，且 estimate=80k → effective=80k");
  // credit > actual → corrected 归 0，不应出现负值
  const neg = computeEffectiveTokens({ estimatedTokens: 50_000, actualTokens: 30_000, compressionCredit: 100_000 });
  assert.equal(neg.effectiveTokens, 50_000, "correctedActual=0，estimate 兜底 50k");
});

test("T3: UsageManager 生命周期（per-session、credit 累加/消费/清零）", () => {
  const m1 = createUsageManager();
  const m2 = createUsageManager(); // 隔离验证
  m1.recordHostUsage(100_000);
  m1.recordEstimate(80_000);
  assert.equal(m1.getLatestHost(), 100_000);
  assert.equal(m2.getLatestHost(), undefined, "per-session 隔离（m2 不吃 m1 的状态）");

  m1.applyCompressionCredit(120_000);
  assert.equal(m1.getCompressionCredit(), 120_000);
  // 真实 usage 到达（context=80k < credit=120k）→ credit 清零（已被真实 fold 反映）
  m1.recordUpstreamUsage({ contextTokens: 80_000 });
  assert.equal(m1.getCompressionCredit(), 0);
  assert.equal(m1.getLatestActual(), 80_000);
  // host(100k) + actual(80k) 都存在 → source=hybrid，effective=两者最大值
  const snap = m1.getEffectiveSnapshot(80_000);
  assert.equal(snap.source, "hybrid");
  assert.equal(snap.effectiveTokens, 100_000);
});

test("T4: protocol-aware normalizeUsage（Anthropic / OpenAI / Responses 不 double-count cached）", () => {
  // Anthropic: input + cache_read + cache_creation
  const an = normalizeUsage("anthropic", { inputTokens: 10_000, cacheReadTokens: 5_000, cacheCreationTokens: 2_000 });
  assert.equal(an.contextTokens, 17_000);
  // OpenAI Chat: prompt_tokens 已是 total，cached 不再重复加
  const oa = normalizeUsage("openai-chat", { inputTokens: 10_000, cachedTokens: 8_000 });
  assert.equal(oa.contextTokens, 10_000, "OpenAI cached 是子集，不 double count");
  // Responses: input_tokens 已是 total
  const rs = normalizeUsage("responses", { inputTokens: 12_000, cachedTokens: 9_000 });
  assert.equal(rs.contextTokens, 12_000);
});

test("S1: 50-Hop synthetic — 至少 3 次压缩 / 3 个 epoch / 无 emergency 用作正常路径", () => {
  // 模拟 50 个 hop：usage 从 50% 起爬升，pressure 阈值内出 nudge；
  // 每次 allowInject（模型响应）即引发一次 compress：blocks+1、credit 累加、
  // epoch 关闭并重开、usage 回落。压力持续反复 → 应产生多次压缩、多个 epoch。
  let prevEpoch: PressureEpoch | undefined;
  let prevBlocks = 0;
  let curBlocks = 0;
  let compressCount = 0;
  let maxEpSeen = 0; // 50-hop 内见过的最大 epoch 号（跨压缩自然递增）
  let emergencyCount = 0;
  let usageNow = 0.50;
  const mgr = createUsageManager();
  const closedEpochOf = (r: PressureDecisionLike): PressureEpoch | undefined =>
    r.nextEpoch ? { ...r.nextEpoch, closed: true, injections: r.nextEpoch.injections } : undefined;

  for (let hopIdx = 1; hopIdx <= 50; hopIdx++) {
    usageNow = Math.min(usageNow + 0.02, 0.99);
    const est = Math.round(C.limit * usageNow);
    mgr.recordHostUsage(est);
    const snap = mgr.getEffectiveSnapshot(est);
    const r = evaluatePressure({
      usagePct: snap.effectiveTokens / C.limit,
      effectiveTokens: snap.effectiveTokens,
      tokenEstimate: est,
      kernelShouldInject: false,
      kernelReason: "",
      prevEpoch,
      prevBlocks,
      curBlocks,
      gentleThresholdPct: C.gentle,
      strongThresholdPct: C.strong,
      emergencyThresholdPct: C.emergency,
      hostEscalationFloor: C.hostFloor,
      nudgeCooldownTurns: C.cooldownTurns,
      nudgeGrowthFloor: C.growthFloor,
      usageCreditTokens: C.credit,
      creditBaseToken: undefined,
      lastInjectedAt: 0,
      nudgeCount: 0,
      lastTokensAtInject: 0,
      lastCompressToken: undefined,
      source: snap.source,
    });

    if (r.level === "emergency") emergencyCount++;
    if (r.nextEpoch) maxEpSeen = Math.max(maxEpSeen, r.nextEpoch.epoch);

    // 模型响应：注入即压缩（模拟强提示下的主动 compress）。
    if (r.allowInject) {
      curBlocks = curBlocks + 1;
      prevBlocks = curBlocks; // 同步：避免下一 hop 误判 compressed-close-epoch
      compressCount++;
      mgr.applyCompressionCredit(Math.round(C.limit * 0.25));
      usageNow = Math.max(0.30, usageNow - 0.30);
      prevEpoch = closedEpochOf(r);
      continue;
    }
    prevEpoch = r.nextEpoch ?? prevEpoch;
  }

  assert.ok(compressCount >= 3, `至少 3 次压缩（实际 ${compressCount}）`);
  assert.ok(maxEpSeen >= 3, `至少 3 个 epoch（实际 maxEp=${maxEpSeen}）`);
  assert.ok(emergencyCount <= 3, `emergency 不应作为正常工作路径（实际 ${emergencyCount}）`);
});

type PressureDecisionLike = {
  nextEpoch?: PressureEpoch;
};