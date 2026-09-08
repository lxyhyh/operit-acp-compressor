/**
 * V0.7.13-P0 取证实验 B：复刻 adapter 真实链路（identity-bridge + processTurn）
 * 只读取证，不修改任何代码、不写任何状态文件。
 *
 * 目标（对齐文档一~十七节）：
 * 1. SESSION PROOF：显式 session d2572685 的状态事实
 * 2. STATE PROOF：blocks/stateVersion/byRef/byRaw/rawTurns
 * 3. REF PROOF：m05709 逐层解析（host/byRef/byRaw/identity/persistence）
 * 4. GROWTH PROOF：rawTurns vs refPool，第一个缺失位置，3298+ identity
 * 5. processTurn ref 分配实验：首次全量 + 后续增量，确认 ref 是否随 turns 增长
 * 6. 抽样 raw turn 的 stableKey/identityId/ACP ref/byRaw 对齐表
 */
import fs from "node:fs";
import { createCore } from "acp-kernel";
import { stableKeyForTurn, promptTurnsToCoreMessages } from "./src/acp/messages.ts";
import { identityForTurn, createIdentityBridgeState, loadIdentityBridgeState } from "./src/identity-bridge.ts";
import { defaultConfig } from "acp-kernel";

const D = "/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state";
const CHAT = "d2572685-4a46-4fa0-9cad-eb24e63ccbeb";
const F = `${D}/state_${CHAT}_b1a397618c66.json`;
const R = `${D}/state_${CHAT}_b1a397618c66.raw.json`;

const state = JSON.parse(fs.readFileSync(F, "utf8"));
const ks = state.kernelState;
const byRef = ks.messageRefs?.byRef ?? {};
const byRaw = ks.messageRefs?.byRaw ?? {};
const blocks = ks.blocks ?? [];
const raw = JSON.parse(fs.readFileSync(R, "utf8"));
const hm = state.hostMetadata ?? {};

// 构造 kernel config（与 adapter resolveKernelConfig 一致）
const config = defaultConfig(200_000);
config.preserveRecentMessages = 5;
config.preserveRecentTokens = 5000;
config.nudge = {
  ...config.nudge,
  minContextLimitPct: 0.72,
  maxContextLimitPct: 0.82,
  emergencyThresholdPct: 0.85,
  force: "soft",
  growthFloor: 10000,
  minGrowthFloor: 5000,
};
config.compress = { ...config.compress, minCompressRange: 5000 };

console.log("===== 1. SESSION PROOF =====");
console.log("nudge session (explicit):", CHAT);
console.log("hostMetadata.lastChatId:", hm.lastChatId ?? "?");
console.log("hostMetadata.stateVersion:", hm.stateVersion ?? "?");
console.log("hostMetadata.lastUpdatedAt:", new Date(hm.lastUpdatedAt ?? 0).toISOString());
console.log("runtimeStats:", JSON.stringify(hm.runtimeStats ?? {}));
console.log("EXPLICIT_SESSION == NUDGE_SESSION:", CHAT === hm.lastChatId ? "YES" : "NO (⚠)");

console.log("\n===== 2. STATE PROOF =====");
console.log("blocks:", blocks.length, "active:", blocks.filter((b: any) => b.active).length);
console.log("byRef:", Object.keys(byRef).length, "byRaw:", Object.keys(byRaw).length);
console.log("rawTurns:", raw.length);
console.log("maxRef:", Object.keys(byRef).sort().pop());
console.log("firstRef:", Object.keys(byRef).sort()[0]);
console.log("stateVersion:", hm.stateVersion ?? "?");
console.log("identityBridge persisted:", hm.identityBridge ? "YES" : "NO");

console.log("\n===== 3. REF PROOF: m05709 逐层解析 =====");
const requestedRef = "m05709";
const byRawKeys = new Set(Object.keys(byRaw));
// HOST lookup：raw 里是否有内容生成 m05709？——先找 raw 中引用 m05709 的 turn
const rawRefMentions = raw.filter((t: any) => typeof t.content === "string" && t.content.includes(requestedRef));
console.log("requestedRef:", requestedRef);
console.log("byRef[m05709]:", byRef[requestedRef] ?? "MISS");
// identity lookup：构造 identityForTurn 对 raw 全量生成 id，看是否有 id 落在 m05709 对应位置
const identityState = hm.identityBridge ? loadIdentityBridgeState(hm.identityBridge) : createIdentityBridgeState();
const rawWithId = raw.map((t: any, i: number) => {
  const r = identityForTurn(t, { hop: 1, toolState: identityState });
  return { idx: i, kind: t.kind, id: r.id, legacyKey: r.legacyKey, strategy: r.strategy };
});
const refOwner = byRef[requestedRef];
console.log("byRef[m05709] -> raw id:", refOwner ?? "MISS");
if (refOwner) {
  const owner = rawWithId.find((r) => r.id === refOwner || r.legacyKey === refOwner);
  console.log("raw 中匹配该 id 的 turn:", owner ? `idx=${owner.idx} kind=${owner.kind} strategy=${owner.strategy}` : "未找到（可能是已折叠消息）");
}
console.log("raw 中文本提到 m05709 的 turn 数:", rawRefMentions.length);
console.log("byRef 范围: m00001 .. m03297  (maxRef=m03297)");
console.log("=> m05709 超出 ACP byRef 范围:", !byRef[requestedRef] ? "YES (HOST namespace ≠ ACP namespace)" : "NO");

console.log("\n===== 4. GROWTH PROOF (rawTurns vs refPool) =====");
// raw turn → stableKey → ACP byRaw key 是否命中
let firstMissing = -1;
let missingCount = 0;
const rawKeys = raw.map((t: any) => stableKeyForTurn(t));
for (let i = 0; i < raw.length; i++) {
  if (!byRawKeys.has(rawKeys[i])) {
    if (firstMissing === -1) firstMissing = i;
    missingCount++;
  }
}
console.log("rawTurns:", raw.length, "byRaw:", byRawKeys.size);
console.log("第一个 raw turn 存在但 ACP 无 byRaw key 的索引:", firstMissing, "(0-based)");
console.log("缺失总数:", missingCount, `(${(missingCount / raw.length * 100).toFixed(1)}%)`);

// 抽样关键索引
const sampleIdx = [0, 9, 99, 999, 2999, 3199, 3289, 3296, 3297, 3299, 3399, 3599, 3999, 4210, 4262, 4318];
console.log("\n索引抽样（raw turn 是否有 byRaw ref + identity 状态）:");
for (const i of sampleIdx) {
  if (i >= raw.length) continue;
  const t = raw[i];
  const sk = stableKeyForTurn(t);
  const hit = byRawKeys.has(sk);
  const ref = byRaw[sk];
  const idr = rawWithId[i];
  console.log(`  idx=${i} kind=${t.kind} toolName=${t.toolName ?? ""} byRaw=${hit ? ref : "MISS"} identity=${idr.strategy}`);
}

// 3297+ 抽样：文档第六节——新增 turn 是有 identity 但没 ref？
console.log("\n===== 6. 3298+ turns 的 identity 检查 =====");
let withIdentityNoRef = 0;
let noIdentity = 0;
let withRef = 0;
for (let i = firstMissing >= 0 ? firstMissing : 3297; i < raw.length; i++) {
  const t = raw[i];
  const sk = stableKeyForTurn(t);
  const idr = rawWithId[i];
  const hit = byRawKeys.has(sk);
  if (hit) withRef++;
  else if (idr.id) withIdentityNoRef++;
  else noIdentity++;
}
console.log(`从 idx=${firstMissing >= 0 ? firstMissing : 3297} 到末尾 (共 ${raw.length - (firstMissing >= 0 ? firstMissing : 3297)} 条):`);
console.log("  有 identity 但无 ref:", withIdentityNoRef);
console.log("  连 identity 都没有:", noIdentity);
console.log("  有 ref:", withRef);

console.log("\n===== 5. processTurn ref 分配实验（复刻 adapter 全量路径） =====");
const core = createCore();
const mapping = promptTurnsToCoreMessages(raw, {
  identityForTurn: (turn) => {
    const r = identityForTurn(turn, { hop: 1, toolState: identityState });
    return { id: r.id };
  },
});
console.log("promptTurnsToCoreMessages messages:", mapping.messages.length);
console.log("mapping 中唯一 id 数:", new Set(mapping.messages.map((m) => m.id)).size);

// 全量 processTurn：用持久化 state 作为初始 state，模拟"真实下一轮"
const t1 = core.processTurn({
  messages: mapping.messages,
  state: ks,
  config,
  tokenCount: 2_600_000,
  renderTags: "none",
});
const byRef1 = t1.state.messageRefs?.byRef ?? {};
const byRaw1 = t1.state.messageRefs?.byRaw ?? {};
console.log("\n首次 processTurn（全量 4319 条）:");
console.log("  messages:", mapping.messages.length);
console.log("  byRef after:", Object.keys(byRef1).length, "(之前", Object.keys(byRef).length + ")");
console.log("  byRaw after:", Object.keys(byRaw1).length, "(之前", Object.keys(byRaw).length + ")");
console.log("  新增 ref:", Object.keys(byRef1).length - Object.keys(byRef).length);
console.log("  maxRef after:", Object.keys(byRef1).sort().pop());

// 关键：assignRefs 是否给 4319 条全部（或大部分）分配了 ref？
// 检查新 state 里 raw 尾部是否都有了 ref
const byRaw1Keys = new Set(Object.keys(byRaw1));
let tailCovered = 0;
for (let i = 3200; i < raw.length; i++) {
  const sk = stableKeyForTurn(raw[i]);
  if (byRaw1Keys.has(sk)) tailCovered++;
}
console.log(`  idx 3200+ 在 processTurn 后有 byRaw ref: ${tailCovered} / ${raw.length - 3200}`);

// 模拟下一轮新增（截取原始 turns 尾部 5 条作为"新增长的 turns"，模拟增量快速路径）
console.log("\n增量快速路径模拟（新增尾部 5 条，state 不变时）:");
const delta = raw.slice(-5);
const deltaMapping = promptTurnsToCoreMessages(delta, {
  identityForTurn: (turn) => {
    const r = identityForTurn(turn, { hop: 2, toolState: identityState });
    return { id: r.id };
  },
});
// 增量路径（adapter 只追加不 processTurn）
const mergedTurns = [...raw, ...delta];
const mergedMapping = promptTurnsToCoreMessages(mergedTurns, {
  identityForTurn: (turn) => {
    const r = identityForTurn(turn, { hop: 2, toolState: identityState });
    return { id: r.id };
  },
});
console.log("  delta messages:", deltaMapping.messages.length);
console.log("  merged messages:", mergedMapping.messages.length);
console.log("  merged 新 id 数（增量路径不分配 ref → 这 5 条新消息不会有 ref）:");

// 增量路径：adapter 直接 coreMessagesToPromptTurns 追加，不 processTurn → 不 assignRefs
// 验证：这 5 条新消息的 id 是否已存在于持久化 byRaw
const deltaIds = deltaMapping.messages.map((m) => m.id);
const deltaExisting = deltaIds.filter((id) => byRaw[id]);
console.log("  delta 中已存在于持久化 byRaw 的 id:", deltaExisting.length, "/", deltaIds.length);

console.log("\n===== 取证完成 =====");
