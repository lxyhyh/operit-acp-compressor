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
 * evaluatePressureInner：Continuous Pressure Controller 内部实现。
 * 返回是否注入 + 档位 + nextEpoch + decisionReason。
 * V0.7.1：effectiveTokens/pressurePct/source 由导出包装统一附加。
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

// ═══════════════ V0.7.4：Preflight Over-Hard 决策 ═══════════════

/**
 * 压缩动作分类（V0.7.4 语义，明确区分）：
 * - pressure-gentle / pressure-strong：正常持续上下文管理（nudge，模型主动 compress）
 * - preflight-over-hard：新一轮发送前发现 effective 已超 hard limit → 主动自愈压缩
 * - safety-emergency：preflight 压缩失败 / 压缩后仍严重超窗 / 本周期已压仍超 → 最终兜底
 * 注意：preflight 不通过本类型返回——它由 evaluatePreflight 判定后由 Adapter 执行折叠；
 *       pressure-gentle/strong 仍由 evaluatePressure 产出（NudgeLevel）。
 */
export type CompressionAction =
  | { kind: "none" }
  | { kind: "preflight-over-hard"; hardLimitTokens: number; effectiveTokens: number }
  | { kind: "safety-emergency"; hardLimitTokens: number; effectiveTokens: number };

/**
 * V0.7.4：evaluatePreflight —— 新一轮发送前的安全自愈触发条件。
 *
 * 语义（用户需求 4/5/6/12）：
 * - Hard Limit = 新一轮发送前的安全自愈触发条件，不是普通 Hop 的即时强制折叠阈值。
 * - effectiveTokens <= hardLimitTokens：不触发（正常 gentle/strong pressure 管理）。
 * - effectiveTokens >  hardLimitTokens 且本 send 周期未 preflight → preflight-over-hard
 *   （主动压缩一次，压缩后重新评估）。
 * - effectiveTokens >  hardLimitTokens 且本 send 周期已 preflight（压缩后仍超）→
 *   safety-emergency（最终兜底，不再无限循环压缩）。
 *
 * 纯函数：可单测；不触碰 UsageManager / HostUsageAdapter（由调用方采样后传入）。
 */
export function evaluatePreflight(input: {
  effectiveTokens: number;
  modelContextLimit: number;
  hardLimitPct: number;
  /** 本 send 周期是否已执行过一次 preflight compression（防同轮内无限压缩）。 */
  preflightDoneForCycle?: boolean;
}): { action: CompressionAction; hardLimitTokens: number } {
  const hardLimitTokens = Math.round(input.modelContextLimit * input.hardLimitPct);
  if (input.effectiveTokens > hardLimitTokens) {
    if (input.preflightDoneForCycle) {
      return {
        action: { kind: "safety-emergency", hardLimitTokens, effectiveTokens: input.effectiveTokens },
        hardLimitTokens,
      };
    }
    return {
      action: { kind: "preflight-over-hard", hardLimitTokens, effectiveTokens: input.effectiveTokens },
      hardLimitTokens,
    };
  }
  return { action: { kind: "none" }, hardLimitTokens };
}
