/**
 * acp/pressure.ts — V0.7 Continuous Per-Hop Pressure Controller。
 *
 * 设计对齐文档（billion-context continuous per-Hop pressure control）：
 * - 取消 kernelShouldInject 作为"硬总门"，只作为辅助 signal
 * - effective pressure：usage 缺失/为0 时不视为 0 压力（用 estimate 兜底）
 * - cooldown 只防 gentle 刷屏；strong/emergency 必须能 bypass cooldown
 * - usage credit 只抑制 gentle；strong/emergency bypass credit
 * - pressure epoch 支持无限连续（压缩成功关 epoch，再增长开新 epoch）
 * - compression baseline 记录，判断"tokens since compression"
 * - 压力档位单调升级（仅一个 epoch 内）
 * - hostEscalationFloor：约 0.70 允许 Adapter 自接管沉默区（配合增长条件防 spam）
 * - 每个决策都产出明确 decisionReason（供 trace/日志直接回答"为何不 nudge"）
 */

export type NudgeLevel = "gentle" | "strong" | "emergency" | "none";

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

export interface EffectivePressure {
  effectiveTokens: number;
  usagePct: number;
  /** measured | estimated | hybrid——usage 数据来源。 */
  source: "measured" | "estimated" | "hybrid";
}

/**
 * computeEffectivePressure：综合 actual usage / estimate / baseline。
 * 解决文档指出的"lastInputTokens==0 → usage=0 → nudge 永不触发"。
 * - 若 actualUsage 缺失/为0，用 estimate 兜底（绝不视为 0 压力）
 * - effectiveTokens 取 max(estimate, actualUsage*limit)
 */
export function computeEffectivePressure(input: {
  actualUsage?: number;
  tokenEstimate: number;
  modelContextLimit: number;
}): EffectivePressure {
  const { tokenEstimate, modelContextLimit } = input;
  const measured = typeof input.actualUsage === "number" && Number.isFinite(input.actualUsage) && input.actualUsage > 0
    ? input.actualUsage
    : 0;
  const estimated = modelContextLimit > 0 ? tokenEstimate / modelContextLimit : 0;
  const usagePct = Math.max(measured, estimated);
  const source: EffectivePressure["source"] =
    measured <= 0 ? "estimated"
    : estimated > 0 ? "hybrid"
    : "measured";
  return { effectiveTokens: Math.max(tokenEstimate, measured * modelContextLimit), usagePct, source };
}

/** 计算本轮回注档位：越线档 + epoch 内单调升级（只升不降）。 */
export function computePressureLevel(input: {
  usagePct: number;
  gentleThresholdPct: number;
  strongThresholdPct: number;
  emergencyThresholdPct: number;
  epoch?: PressureEpoch;
}): NudgeLevel {
  const base: NudgeLevel = input.usagePct >= input.emergencyThresholdPct ? "emergency"
    : input.usagePct >= input.strongThresholdPct ? "strong"
    : input.usagePct >= input.gentleThresholdPct ? "gentle"
    : "none";
  if (base === "none") return "none";
  if (!input.epoch || input.epoch.closed) return base;
  const order: Array<Exclude<NudgeLevel, "none">> = ["gentle", "strong", "emergency"];
  const curIdx = order.indexOf(input.epoch.maxLevel);
  const baseIdx = order.indexOf(base as Exclude<NudgeLevel, "none">);
  return order[Math.max(curIdx, baseIdx)] ?? base;
}

/** strong/emergency 必须升级（不受 cooldown/credit 抑制）。 */
export function shouldEscalate(usagePct: number, strongThresholdPct: number): boolean {
  return usagePct >= strongThresholdPct;
}

/**
 * evaluatePressure：Continuous Pressure Controller 主入口。
 * 返回是否注入 + 档位 + nextEpoch + decisionReason。
 */
export function evaluatePressure(input: {
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
  emergencyThresholdPct: number;
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
  const emergency = /EMERGENCY/i.test(input.kernelReason);
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
    emergencyThresholdPct: input.emergencyThresholdPct,
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

  // 4) 紧急：无条件注入（bypass 一切）。
  if (emergency || usage >= input.emergencyThresholdPct) {
    return {
      allowInject: true,
      level: "emergency",
      nextEpoch,
      nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: prev.nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
      decisionReason: "emergency-unconditional",
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
  const creditLeft = input.usageCreditTokens > 0 && typeof input.creditBaseToken === "number"
    ? input.creditBaseToken + input.usageCreditTokens - input.tokenEstimate
    : 0;
  if (creditLeft > 0) {
    return { allowInject: false, nextEpoch, nextNudgeState: prev, decisionReason: "gentle-suppressed-by-credit" };
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
