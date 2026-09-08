/**
 * V0.7.13-P0 取证实验：显式 session + ref pool 增长 + 逐层 ref 解析
 * 只读取证，不修改任何代码。
 */
import fs from "node:fs";
import { createCore } from "acp-kernel";
import { stableKeyForTurn, promptTurnsToCoreMessages } from "./src/acp/messages.ts";
import { loadAdapterSettings, resolveKernelConfig } from "./src/acp/config.ts";

const D = "/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state";
const CHAT = "d2572685-4a46-4fa0-9cad-eb24e63ccbeb";
const F = `${D}/state_${CHAT}_b1a397618c66.json`;
const R = `${D}/state_${CHAT}_b1a397618c66.raw.json`;

// ============ 1. STATE PROOF ============
const state = JSON.parse(fs.readFileSync(F, "utf8"));
const ks = state.kernelState;
const byRef = ks.messageRefs?.byRef ?? {};
const byRaw = ks.messageRefs?.byRaw ?? {};
const blocks = ks.blocks ?? [];
const raw = JSON.parse(fs.readFileSync(R, "utf8"));

console.log("===== 1. STATE PROOF =====");
console.log("chatId:", CHAT);
console.log("sessionKey(显式):", CHAT);
console.log("stateVersion:", state.hostMetadata?.stateVersion ?? "?");
console.log("blocks:", blocks.length, "active:", blocks.filter((b: any) => b.active).length);
console.log("byRef:", Object.keys(byRef).length, "byRaw:", Object.keys(byRaw).length);
console.log("rawTurns:", raw.length);

// ============ 2. REF 对齐：找第一个 raw turn 存在但 ACP 无 ref 的位置 ============
console.log("\n===== 2. GROWTH PROOF (rawTurns vs refPool) =====");
// raw turn → stableKey → ACP byRaw key 是否命中
let firstMissing = -1;
let missingCount = 0;
const rawKeys = raw.map((t: any) => stableKeyForTurn(t));
const byRawKeys = new Set(Object.keys(byRaw));
for (let i = 0; i < raw.length; i++) {
  if (!byRawKeys.has(rawKeys[i])) {
    if (firstMissing === -1) firstMissing = i;
    missingCount++;
  }
}
console.log("rawTurns:", raw.length, "byRaw:", byRawKeys.size);
console.log("第一个 raw turn 存在但 ACP 无对应 byRaw key 的索引:", firstMissing, "(0-based)");
console.log("缺失总数:", missingCount, `(${(missingCount / raw.length * 100).toFixed(1)}%)`);

// 抽样关键索引
const sampleIdx = [0, 9, 99, 999, 2999, 3199, 3289, 3296, 3297, 3299, 3399, 3599, 3999, 4210, 4262];
console.log("\n索引抽样（raw turn 是否有 byRaw ref）:");
for (const i of sampleIdx) {
  if (i >= raw.length) continue;
  const t = raw[i];
  const sk = stableKeyForTurn(t);
  const hit = byRawKeys.has(sk);
  const ref = byRaw[sk];
  console.log(`  idx=${i} kind=${t.kind} toolName=${t.toolName ?? ""} byRaw=${hit ? ref : "MISS"}`);
}

// ============ 3. 逐层 REF 解析（m05709） ============
console.log("\n===== 3. REF PROOF: m05709 逐层解析 =====");
const requestedRef = "m05709";
console.log("requestedRef:", requestedRef);
console.log("byRef[m05709]:", byRef[requestedRef] ?? "MISS");
console.log("byRef 范围: m00001 ..", Object.keys(byRef).sort().pop());
console.log("host 是否有 m05709: 宿主视图（需 host 侧查）");

// ============ 4. processTurn 增长实验（第三实验前奏） ============
console.log("\n===== 4. processTurn ref 分配实验 =====");
const core = createCore();
const settings = loadAdapterSettings();
const config = resolveKernelConfig(settings);
const mapping = promptTurnsToCoreMessages(raw);

// 第一次 processTurn（全部 4263 条）
const t1 = core.processTurn({ messages: mapping.messages, state: ks, config, tokenCount: 2_600_000, renderTags: "none" });
const byRef1 = t1.state.messageRefs?.byRef ?? {};
const byRaw1 = t1.state.messageRefs?.byRaw ?? {};
console.log("首次 processTurn: messages=", mapping.messages.length, "byRef=", Object.keys(byRef1).length, "byRaw=", Object.keys(byRaw1).length);

// 模拟下一轮新增（截取原始 turns 前 100 条作为"新增长的 turns"）
const subMapping = promptTurnsToCoreMessages(raw.slice(0, 100));
const t2 = core.processTurn({ messages: subMapping.messages, state: t1.state, config, tokenCount: 100_000, renderTags: "none" });
const byRef2 = t2.state.messageRefs?.byRef ?? {};
console.log("第二轮 processTurn（新增 100 条）: byRef=", Object.keys(byRef2).length, "byRaw=", Object.keys(t2.state.messageRefs?.byRaw ?? {}).length);
console.log("byRef 增长:", Object.keys(byRef2).length - Object.keys(byRef1).length);

console.log("\n===== 取证完成 =====");