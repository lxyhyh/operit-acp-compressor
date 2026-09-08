/**
 * acp/pressure.ts — V0.7.6 Pressure Controller（对齐 billion-context 原版 kernel）。
 *
 * V0.7.6 语义（用户需求文档：pressure decision ≠ compression execution）：
 * - 四档决策：NONE / GENTLE_NUDGE / STRONG_NUDGE / FORCED_NUDGE。
 *   FORCED_NUDGE = 达到 maxContextLimit（原 maxContextLimitPct 阈值）后触发，
 *   绕过 growth/cadence/credit 的静默机制 —— 但只改变 nudge 强度，不改变 executor。
 * - 所有压缩只由模型主动调用 compress 工具执行（applyCompression）；
 *   插件绝不因 usage 超限自动折叠整个历史。
 * - emergency 语义只保留给巨型 TOOL_RESULT（absorb 建议 / truncate），
 *   不再表示"历史压缩档位"。
 * - pressure epoch 支持无限连续（压缩成功关 epoch，再增长开新 epoch）。
 * - 每个决策都产出明确 decisionReason（供 trace/日志直接回答"为何不 nudge"）。
 */

export type NudgeLevel = "gentle" | "strong" | "forced" | "none";

/** 超过 maxContextLimitPct 后使用 forced 档（对齐 kernel overLimit 分支）。 */
export const FORCED_LEVEL: Exclude<NudgeLevel, "none"> = "forced";

/** pressure epoch（存 hostMetadata.acpNudge.acpEpoch，跨 Hop/跨 VM 恢复）。 */
export interface PressureEpoch {
  epoch: number;
  /** 纪元开启时的 usage（0~1）。 */
  openedAtUsage: number;
  /** 纪元内已注入 nudge 次数。 */
  injections: number;
  /** 本纪元已用最高档位（只升不降）。 */
  maxLevel: Exclude<NudgeLevel, "none">;
  /** 纪元是否已因压缩成功关闭。 */
  closed: boolean;
}

/** 计算本轮回注档位：越线档 + epoch 内单调升级（只升不降）。 */
export function computePressureLevel(input: {
  usagePct: number;
  gentleThresholdPct: number;
  strongThresholdPct: number;
  forcedThresholdPct: number;
  epoch?: PressureEpoch;
}): NudgeLevel {
  const base: NudgeLevel = input.usagePct >= input.forcedThresholdPct ? "forced"
    : input.usagePct >= input.strongThresholdPct ? "strong"
    : input.usagePct >= input.gentleThresholdPct ? "gentle"
    : "none";
  if (base === "none") return "none";
  if (!input.epoch || input.epoch.closed) return base;
  const order: Array<Exclude<NudgeLevel, "none">> = ["gentle", "strong", "forced"];
  const curIdx = order.indexOf(input.epoch.maxLevel);
  const baseIdx = order.indexOf(base as Exclude<NudgeLevel, "none">);
  return order[Math.max(curIdx, baseIdx)] ?? base;
}

/** strong/forced 必须升级（不受 cooldown/credit 抑制）。 */
export function shouldEscalate(usagePct: number, strongThresholdPct: number): boolean {
  return usagePct >= strongThresholdPct;
}

/** forced：达到 maxContextLimit 后无条件注入（绕过 growth/cadence/credit）。 */
export function isForced(usagePct: number, forcedThresholdPct: number): boolean {
  return usagePct >= forcedThresholdPct;
}

/**
 * evaluatePressureInner：Continuous Pressure Controller 内部实现。
 * 返回是否注入 + 档位 + nextEpoch + decisionReason。
 * V0.7.1：effectiveTokens/pressurePct/source 由导出包装统一附加。
 * V0.7.6：档位改 gentle/strong/forced；forced 绕过 growth/cadence/credit。
 */
function evaluatePressureInner(input: {
  usagePct: number;
  effectiveTokens: number;
  tokenEstimate: number;
  kernelShouldInject: boolean;
  kernelReason: string;
  prevEpoch?: PressureEpoch;
  prevBlocks: number;
  curBlocks: number;
  // 阈值
  gentleThresholdPct: number;
  strongThresholdPct: number;
  forcedThresholdPct: number;
  hostEscalationFloor: number;
  // 冷却（只防 gentle）
  nudgeCooldownTurns: number;
  nudgeGrowthFloor: number;
  // credit（只抑制 gentle）
  usageCreditTokens: number;
  creditBaseToken?: number;
  // 状态
  lastInjectedAt: number;
  nudgeCount: number;
  lastTokensAtInject: number;
  lastCompressToken?: number;
  // V0.7.1：effective token 数据源（estimate/upstream/host/hybrid）
  source: "estimate" | "upstream" | "host" | "hybrid";
}): {
  allowInject: boolean;
  level?: Exclude<NudgeLevel, "none">;
  nextEpoch?: PressureEpoch;
  nextNudgeState: Record<string, unknown>;
  decisionReason: string;
} {
  const prev = {
    lastInjectedAt: input.lastInjectedAt,
    nudgeCount: input.nudgeCount,
    lastTokensAtInject: input.lastTokensAtInject,
  };
  const prevEpoch = input.prevEpoch;
  const usage = input.usagePct;

  // 1) 压缩成功：关闭纪元 + 重置状态机（epoch 可无限重开）。
  if (input.curBlocks > input.prevBlocks) {
    const closedEpoch: PressureEpoch | undefined = prevEpoch
      ? { ...prevEpoch, closed: true, injections: prevEpoch.injections }
      : undefined;
    return {
      allowInject: false,
      nextNudgeState: { lastInjectedAt: 0, nudgeCount: 0, lastTokensAtInject: 0 },
      nextEpoch: closedEpoch,
      decisionReason: "compressed-close-epoch",
    };
  }

  // 2) 上下文明显回落（无压缩也降）：视为压力解除，重置注入状态，
  //    但保留 epoch 计数（文档：epoch 以压缩成功为边界，而非 usage 回落）。
  if (prev.lastInjectedAt > 0 && input.tokenEstimate < prev.lastTokensAtInject * 0.9) {
    return {
      allowInject: false,
      nextNudgeState: { lastInjectedAt: 0, nudgeCount: 0, lastTokensAtInject: 0 },
      nextEpoch: prevEpoch,
      decisionReason: "context-dropped-reset",
    };
  }

  // 3) 计算本回档位（epoch 内单调升级）。
  const levelRaw = computePressureLevel({
    usagePct: usage,
    gentleThresholdPct: input.gentleThresholdPct,
    strongThresholdPct: input.strongThresholdPct,
    forcedThresholdPct: input.forcedThresholdPct,
    epoch: prevEpoch && !prevEpoch.closed ? prevEpoch : undefined,
  });

  const epochActive = prevEpoch && !prevEpoch.closed;
  const nextEpoch: PressureEpoch = {
    epoch: (prevEpoch?.epoch ?? 0) + (epochActive ? 0 : 1),
    openedAtUsage: epochActive ? (prevEpoch?.openedAtUsage ?? usage) : usage,
    injections: (epochActive ? prevEpoch?.injections ?? 0 : 0) + 1,
    maxLevel: (levelRaw === "none" ? "gentle" : levelRaw) as Exclude<NudgeLevel, "none">,
    closed: false,
  };

  const escalate = shouldEscalate(usage, input.strongThresholdPct);
  const forced = isForced(usage, input.forcedThresholdPct);

  // 4) forced：达到 maxContextLimit/hard 后无条件注入（绕过 growth/cadence/credit）。
  //    —— 只改变 nudge 强度，不改变 executor（对齐 kernel overLimit 分支）。
  if (forced) {
    return {
      allowInject: true,
      level: "forced",
      nextEpoch,
      nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: prev.nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
      decisionReason: "forced-bypassed-growth-cadence-credit",
    };
  }

  // 5) strong：bypass cooldown + credit（文档第七/六节）。
  if (escalate) {
    return {
      allowInject: true,
      level: (levelRaw === "none" ? "strong" : levelRaw) as Exclude<NudgeLevel, "none">,
      nextEpoch,
      nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: prev.nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
      decisionReason: "strong-bypassed-cooldown-and-credit",
    };
  }

  // 6) gentle（levelRaw === "gentle"）：
  const level = (levelRaw === "none" ? "gentle" : levelRaw) as Exclude<NudgeLevel, "none">;

  // credit 只抑制 gentle：压缩后 credit 窗口内不 gentle（文档第七节）。
  // V0.7.1 修复：credit 基准绝不允许无限压制——
  //   a) 防御 creditBaseToken 异常（基准 > 当前 usage 且 usage 已过 gentle 阈值）：
  //      说明压缩后窗口严重低于基准（基准可能记录了压缩前/错误的大值），
  //      此时若仍按 credit 静默将导致上下文永久无人管理（另一会话实测 6.2 亿 token 无压缩）。
  //      故：这种"基准错位"场景直接跳过 credit，交给后续增长判断/hostEscalation 决定。
  //   b) usage 已 ≥ strong 阈值时由上方 escalate 分支硬放行（本就 bypass credit）。
  const creditEnabled = input.usageCreditTokens > 0 && typeof input.creditBaseToken === "number";
  const creditBroken = creditEnabled
    && input.tokenEstimate < (input.creditBaseToken as number)
    && input.usagePct >= input.gentleThresholdPct;
  const creditLeft = !creditEnabled || creditBroken
    ? 0
    : (input.creditBaseToken as number) + input.usageCreditTokens - input.tokenEstimate;
  if (creditLeft > 0) {
    return { allowInject: false, nextEpoch, nextNudgeState: prev, decisionReason: creditBroken ? "credit-broken-baseline-force-release" : "gentle-suppressed-by-credit" };
  }

  // 增长判断：gentle 需"自上次注入以来有实质增长"或"自压缩以来跨越 baseline 增长"
  const deltaSinceNudge = input.lastTokensAtInject > 0 ? input.tokenEstimate - input.lastTokensAtInject : 0;
  const deltaSinceCompression = typeof input.lastCompressToken === "number"
    ? input.tokenEstimate - input.lastCompressToken
    : 0;
  const grewSinceNudge = prev.lastInjectedAt === 0 || deltaSinceNudge >= input.nudgeGrowthFloor;
  const grewSinceCompression = typeof input.lastCompressToken !== "number" || deltaSinceCompression >= input.nudgeGrowthFloor;

  // 7) hostEscalationFloor：kernel 沉默但 usage ≥ floor 且增长明显 → Adapter 自接管（防沉默区危险增长）。
  if (!input.kernelShouldInject) {
    if (usage >= input.hostEscalationFloor && grewSinceCompression && grewSinceNudge) {
      return {
        allowInject: true,
        level,
        nextEpoch,
        nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: prev.nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
        decisionReason: "host-escalation-floor-crossed-with-growth",
      };
    }
    return { allowInject: false, nextEpoch, nextNudgeState: prev, decisionReason: "kernel-silent-host-below-growth-floor" };
  }

  // 8) kernel 建议 + gentle：受 cooldown/增长抑制。
  if (prev.lastInjectedAt > 0 && !grewSinceNudge) {
    return { allowInject: false, nextEpoch, nextNudgeState: prev, decisionReason: "gentle-no-growth-since-last-inject" };
  }
  if (prev.nudgeCount >= input.nudgeCooldownTurns) {
    return { allowInject: false, nextEpoch, nextNudgeState: prev, decisionReason: "gentle-cooldown" };
  }

  return {
    allowInject: true,
    level,
    nextEpoch,
    nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: prev.nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
    decisionReason: "gentle-inject",
  };
}

export type EffectiveSource = "estimate" | "upstream" | "host" | "hybrid";

export interface PressureDecision {
  allowInject: boolean;
  level?: Exclude<NudgeLevel, "none">;
  nextEpoch?: PressureEpoch;
  nextNudgeState: Record<string, unknown>;
  decisionReason: string;
  pressurePct: number;
  effectiveTokens: number;
  source: EffectiveSource;
}

export type PressureInput = Parameters<typeof evaluatePressureInner>[0];

/**
 * evaluatePressure：导出包装——在 Inner 决策上统一附加 V0.7.1 effective 指标。
 * pressurePct = effectiveTokens / modelContextLimit（调用方传 usagePct 时已算好，
 * 这里直接用输入值，保证 trace 与判定一致）。
 */
export function evaluatePressure(input: PressureInput): PressureDecision {
  const r = evaluatePressureInner(input);
  return {
    ...r,
    pressurePct: input.usagePct,
    effectiveTokens: input.effectiveTokens,
    source: input.source,
  };
}
