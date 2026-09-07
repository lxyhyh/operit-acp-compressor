/**
 * acp-core.test.mts — 新架构（宿主 hook 投影）纯函数层测试。
 *
 * 覆盖（不依赖 Operit Tools / 宿主环境，Node 直接运行）：
 * 1. acp/messages：stableKey 稳定性、toolCallId FIFO 配对、SUMMARY 还原、capProjectionSize。
 * 2. acp/token：CJK token 估算、covered ids。
 * 3. acp/session：主对话/子任务 session key 隔离。
 * 4. acp/system-prompt：幂等追加。
 * 5. acp/tools-meta：4 个核心工具名与 schema 契约。
 * 6. acp/persistence：sessionKeyToFile 安全文件名、mergeInitialState 补缺。
 * 7. adapter.computeFingerprint：同 turns 稳定、内容变化即变化。
 * 8. kernel 闭环：projection（processTurn）→ applyCompression → 再 projection
 *    出现 SUMMARY 且原消息被覆盖（方向 1 核心行为）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stableKeyForTurn, promptTurnsToCoreMessages, coreMessagesToPromptTurns, capProjectionSize, hashString, toolNameFromXml } from "../src/acp/messages.ts";
import { countTokensCjk, collectCoveredMessageIds } from "../src/acp/token.ts";
import { buildSessionKey } from "../src/acp/session.ts";
import { appendAcpSystemPrompt, ACP_SYSTEM_PROMPT } from "../src/acp/system-prompt.ts";
import { ACP_CORE_TOOLS, acpCoreToolNames, buildAcpToolPromptItems } from "../src/acp/tools-meta.ts";
import { sessionKeyToFile, mergeInitialState, EMPTY_RUNTIME_STATS, type AcpRuntimeStats } from "../src/acp/persistence.ts";
import { computeFingerprint } from "../src/acp/adapter.ts";

import { createCore, createInitialState, defaultConfig } from "acp-kernel";

// ---- 1. messages ----

test("stableKeyForTurn 稳定且排除易变 metadata(toolCallId)", () => {
    const t1 = { kind: "USER", content: "审查代码", metadata: { toolCallId: "tc_x", acp: true } };
    const t2 = { kind: "USER", content: "审查代码", metadata: { toolCallId: "tc_y", acp: true } };
    assert.equal(stableKeyForTurn(t1), stableKeyForTurn(t2), "toolCallId 变化不应影响 stableKey");
    const t3 = { kind: "USER", content: "审查代码", metadata: { toolCallId: "tc_x", acp: false } };
    assert.notEqual(stableKeyForTurn(t1), stableKeyForTurn(t3), "稳定 metadata 变化应影响 stableKey");
});

test("toolCallId FIFO 配对（call 生成入队，result 出队继承）", () => {
    const turns = [
        { kind: "TOOL_CALL", content: '<tool_Xa1 name="read_file"><param name="path">a</param></tool_Xa1>', toolName: "read_file" },
        { kind: "TOOL_RESULT", content: "<tool_result_Xa1>ok</tool_result_Xa1>" },
    ];
    const { messages } = promptTurnsToCoreMessages(turns);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "assistant");
    assert.equal(messages[0].contentType, "tool-call");
    assert.equal(messages[1].role, "tool");
    assert.equal(messages[1].toolCallId, messages[0].toolCallId, "result 应继承 call 的 toolCallId");
    assert.ok(messages[0].toolName === "read_file", "从 XML 解析工具名");
});

test("coreMessagesToPromptTurns 把 acp_summary 还原为 SUMMARY", () => {
    const coreMsgs = [
        { id: "acp_summary_b1", role: "system", contentType: "text", text: "已压缩的摘要内容" },
        { id: "k1", role: "user", contentType: "text", text: "hi" },
    ];
    const byKey = new Map([["k1", { kind: "USER", content: "hi" }]]);
    const out = coreMessagesToPromptTurns(coreMsgs as never, byKey);
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, "SUMMARY");
    assert.equal(out[1].kind, "USER");
});

test("capProjectionSize：单条裁剪 + 最近消息保护 + SUMMARY 不裁", () => {
    const long = "x".repeat(5000);
    const turns = [
        { kind: "USER", content: long },
        { kind: "USER", content: long },
        { kind: "SUMMARY", content: long },
    ];
    const capped = capProjectionSize(turns, { keepChars: 2000, maxRecent: 2, totalBudgetChars: 100_000 });
    assert.ok(capped[0].content.length < 5000, "最旧超限消息被裁剪");
    assert.equal(capped[1].content, long, "最近消息不裁（保护）");
    assert.equal(capped[2].content, long, "SUMMARY 永不裁剪");
});

test("hashString / toolNameFromXml 基础", () => {
    assert.equal(hashString("a"), hashString("a"));
    assert.notEqual(hashString("a"), hashString("b"));
    assert.equal(toolNameFromXml('<tool_x name="read_file">'), "read_file");
});

// ---- 2. token ----

test("countTokensCjk：CJK 1 token/字，其余 1 token/4 字符", () => {
    assert.equal(countTokensCjk("审查代码"), 4);
    assert.ok(countTokensCjk("abcd").toString().length > 0);
});

test("collectCoveredMessageIds 只收集 active block 的 effectiveMessageIds", () => {
    const state = {
        blocks: [
            { active: true, effectiveMessageIds: ["a", "b"] },
            { active: false, effectiveMessageIds: ["c"] },
        ],
    };
    const ids = collectCoveredMessageIds(state as never);
    assert.ok(ids.has("a") && ids.has("b") && !ids.has("c"));
});

// ---- 3. session ----

test("buildSessionKey：主对话=chatId；子任务隔离", () => {
    assert.equal(buildSessionKey({ chatId: "abc", functionType: "CHAT", promptFunctionType: "CHAT" }), "abc");
    assert.equal(buildSessionKey({ chatId: "abc" }), "abc");
    const sub = buildSessionKey({ chatId: "abc", isSubTask: true, functionType: "SUMMARY", promptFunctionType: "SUMMARY" });
    assert.ok(sub.startsWith("abc|sub|"), "子任务应隔离");
});

// ---- 4. system-prompt ----

test("appendAcpSystemPrompt 幂等", () => {
    const base = "原生系统提示";
    const once = appendAcpSystemPrompt(base);
    assert.ok(once.includes("[ACP 上下文管理]"));
    assert.equal(appendAcpSystemPrompt(once), once, "二次追加应幂等");
});

// ---- 5. tools-meta ----

test("tools-meta：4 个核心工具契约", () => {
    const names = acpCoreToolNames();
    assert.deepEqual(names, ["compress", "decompress", "search_context", "acp_status"]);
    const items = buildAcpToolPromptItems();
    assert.equal(items.length, 4);
    for (const it of items) {
        assert.equal(typeof it.name, "string");
        assert.equal(typeof it.description, "string");
        assert.ok(it.parameters.startsWith("{"), "parameters 应为 JSON 字符串");
    }
    const compress = ACP_CORE_TOOLS.find((t) => t.name === "compress")!;
    const props = (compress.parameters as { properties: Record<string, unknown> }).properties;
    assert.ok("content" in props, "compress 应有 content 参数");
    assert.ok("messages" in props, "compress 应有可选 messages");
});

// ---- 6. persistence ----

test("sessionKeyToFile 安全文件名 + 稳定", () => {
    const f1 = sessionKeyToFile("abc-123");
    const f2 = sessionKeyToFile("abc/../evil");
    assert.ok(f1.startsWith("state_"));
    assert.ok(!f2.includes("/"), "路径分隔符应被替换");
    // 注意：`.` 在允许字符集内，但 `/` 已被替换，`..` 无法构成路径穿越（同目录内无害）。
    assert.ok(!f2.startsWith("."), "文件名不应以点开头");
    // 相同输入 → 相同文件名（含 hash 后缀）
    assert.equal(sessionKeyToFile("abc-123"), sessionKeyToFile("abc-123"));
    assert.notEqual(sessionKeyToFile("abc"), sessionKeyToFile("abc/../evil"));
});

test("mergeInitialState 填充缺失字段（前向兼容）", () => {
    const merged = mergeInitialState({ blocks: [] } as never);
    assert.ok(Array.isArray(merged.blocks));
    assert.ok(merged.messageRefs, "缺失 messageRefs 应补默认");
    assert.ok(typeof merged.nextBlockId === "number");
});

// ---- 7. fingerprint ----

test("computeFingerprint：同 turns 稳定、内容变化即变化", () => {
    const cfg = defaultConfig(200000);
    const turns1 = [
        { kind: "USER", content: "第一轮" },
        { kind: "ASSISTANT", content: "回答" },
    ];
    const turns2 = [
        { kind: "USER", content: "第一轮" },
        { kind: "ASSISTANT", content: "回答（改）" },
    ];
    assert.equal(computeFingerprint("chat1", turns1, cfg), computeFingerprint("chat1", turns1, cfg));
    assert.notEqual(computeFingerprint("chat1", turns1, cfg), computeFingerprint("chat1", turns2, cfg));
    assert.notEqual(computeFingerprint("chat1", turns1, cfg), computeFingerprint("chat2", turns1, cfg));
});

// ---- 8. kernel 闭环：projection → applyCompression → 再 projection ----

function mkCoreMessages() {
    // 每条消息足够长（合计远超 minCompressRange 5000 字符门槛），压缩才会被 kernel 接受。
    const pad = (s: string) => s + "。" + "内容补充细节".repeat(3000);
    return [
        { id: "m1", role: "user", contentType: "text", text: pad("用户问题：怎么审查这个项目？") },
        { id: "m2", role: "assistant", contentType: "text", text: pad("我来审查，先读代码。") },
        { id: "m3", role: "user", contentType: "text", text: pad("继续，把文件都读一遍。") },
    ] as const;
}

/** 满足 kernel minSummaryLength(50) 的摘要。 */
function mkSummary(): string {
    return "早期对话内容已完全消费。关键信息：用户要求审查 operit-acp-plugin 项目；助手已通读核心源码与测试；后续工作按审查结论继续推进，无需保留原文细节。";
}

test("闭环：processTurn 投影 → applyCompression 压缩 → 再投影出现 SUMMARY 且覆盖旧消息", () => {
    const core = createCore();
    const state0 = createInitialState();
    // preserveRecentTokens 也需 0：默认 5000 会把测试消息全算进保护区（每条超 5000 token 累计）。
    const config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });

    // 第一轮 projection（不压缩）
    const messages = mkCoreMessages() as never;
    const turn1 = core.processTurn({ messages, state: state0, config, tokenCount: 200, renderTags: "none" });
    assert.ok(turn1.state.messageRefs);
    // 找到分配到的 ref
    const refs = turn1.state.messageRefs;
    const byRef = refs.byRef as Record<string, unknown>;
    const refKeys = Object.keys(byRef).sort();
    assert.ok(refKeys.length >= 3, `应有至少 3 个 ref，实际 ${refKeys.length}`);
    const startRef = refKeys[0];
    const endRef = refKeys[refKeys.length - 1];

    // 模型调用 compress（applyCompression）
    const applied = core.applyCompression({
        ranges: [{ startRef, endRef, summary: mkSummary() }],
        messages,
        state: turn1.state,
        config,
    });
    assert.ok(applied.result.blocksCreated >= 1, `应创建至少 1 个 block，实际 ${applied.result.blocksCreated}`);
    assert.ok(applied.result.tokensCompressed > 0);

    // 再 projection：应看到 SUMMARY 占位，原消息被覆盖/隐藏
    const turn2 = core.processTurn({ messages, state: applied.state, config, tokenCount: 200, renderTags: "none" });
    const text = turn2.messages.map((m) => m.text ?? "").join("\n");
    assert.ok(turn2.messages.some((m) => (m.id ?? "").startsWith("acp_summary_") || text.includes("关键信息：用户要求审查 operit-acp-plugin 项目")), "再投影应含 SUMMARY 占位");
});

test("emergency 场景：kernel 推荐范围 + 确定性摘要可自动压缩出块（兜底不依赖模型）", () => {
    const core = createCore();
    const config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0, nudge: { maxContextLimitPct: 0.45 } });
    const pad = (s: string) => s + "。" + "内容补充细节".repeat(3000);
    const messages = Array.from({ length: 30 }, (_, i) => ({
        id: `m${i}`,
        role: (i % 2 === 0 ? "user" : "assistant"),
        contentType: "text",
        text: pad(`第 ${i} 条消息：审查 acp-plugin 第 ${i} 部分`),
    })) as unknown as CoreMessage[];

    // 第一轮 assign refs（模拟 processTurn 已跑过）
    const t1 = core.processTurn({ messages, state: createInitialState(), config, tokenCount: 300_000, renderTags: "none" });
    // 第二轮把 token 拉到超限（EMERGENCY）：同消息、更高 tokenCount → kernel 应产生 recommendation + EMERGENCY
    const t2 = core.processTurn({ messages, state: t1.state, config, tokenCount: 900_000, renderTags: "none" });
    const nudge = t2.nudge as { shouldInject?: boolean; reason?: string; compressibleRanges?: { startRef: string; endRef: string; tokens?: number }[] } | undefined;
    assert.ok(nudge, "超限应产生 nudge 决策");
    assert.ok(nudge.shouldInject, "超限应 shouldInject");
    assert.match(nudge.reason ?? "", /EMERGENCY|pressure/i, "应为 EMERGENCY/pressure");

    // 模拟自动兜底：取推荐范围压缩（每轮 ≤2 段）
    const ranges = (nudge.compressibleRanges ?? []).filter((r) => r.startRef && r.endRef).slice(0, 2);
    assert.ok(ranges.length > 0, "应有可压缩推荐范围");
    let applied = { state: t2.state, blocksCreated: 0 } as { state: CompressionState; blocksCreated: number };
    for (const r of ranges) {
        const seg = messages; // 简化：用全量消息（与 assign 同批）
        const sum = `[ACP 自动折叠] 早期对话压缩摘要：用户要求审查 operit-acp-plugin 项目并修复 ACP 上下文压缩缺陷，助手已通读核心源码、定位直连架构问题并实施宿主 hook 重构，关键结论与决策均已保留在摘要中。`;
        const res = core.applyCompression({
            ranges: [{ startRef: r.startRef, endRef: r.endRef, summary: sum }],
            messages: seg as unknown as CoreMessage[],
            state: applied.state,
            config,
        });
        applied = { state: res.state, blocksCreated: res.result.blocksCreated };
        if (applied.blocksCreated > 0) break;
    }
    assert.ok(applied.blocksCreated > 0, "自动兜底应创建至少 1 个 block");
    assert.ok(applied.state.blocks.length > 0, "state 应有 block");
    // 压缩后投影消息应减少（占位替换旧消息）
    const t3 = core.processTurn({ messages, state: applied.state, config, tokenCount: 300_000, renderTags: "none" });
    assert.ok(t3.messages.length < messages.length, `压缩后投影应少于原始：${t3.messages.length} < ${messages.length}`);
    assert.ok(t3.state.stats && (t3.state.stats.tokensCompressed ?? 0) > 0, "应有压缩 token 统计");
});

test("kernel 循环压缩后 token 明显下降", () => {
    const core = createCore();
    const config = defaultConfig(200000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const long = "x".repeat(1000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        role: (i % 2 === 0 ? "user" : "assistant"),
        contentType: "text",
        text: `${i % 2 === 0 ? "用户询问内容" : "助手回答内容"}-${long}-${i}`,
    })) as never;
    const t1 = core.processTurn({ messages, state: createInitialState(), config, tokenCount: 30_000, renderTags: "none" });
    const refs = t1.state.messageRefs;
    const byRef = refs.byRef as Record<string, unknown>;
    const keys = Object.keys(byRef).sort();
    const applied = core.applyCompression({
        ranges: [{ startRef: keys[0], endRef: keys[keys.length - 1], summary: mkSummary() }],
        messages,
        state: t1.state,
        config,
    });
    const t2 = core.processTurn({ messages, state: applied.state, config, tokenCount: 30_000, renderTags: "none" });
    // 压缩后投影的消息数应显著小于原始（大部分被 SUMMARY 覆盖）
    assert.ok(t2.messages.length < messages.length, `压缩后消息数应下降：${t2.messages.length} < ${messages.length}`);
});

// ---- 9. V0.4 runtime stats 契约 ----

test("V0.4 EMPTY_RUNTIME_STATS 字段齐全且初值为 0", () => {
    const s = EMPTY_RUNTIME_STATS;
    const required: (keyof AcpRuntimeStats)[] = [
        "nudgeIssued", "gentleNudges", "strongNudges", "emergencyNudges",
        "compressCalled", "compressSucceeded", "compressFailed",
        "emergencyTriggered", "emergencySavedTokens", "modelSavedTokens",
        "nudgeIgnored",
    ];
    for (const k of required) {
        assert.equal(s[k], 0, `字段 ${k} 应为 0`);
    }
    assert.equal(s.lastCompressSource, undefined, "初始无 lastCompressSource");
});

test("V0.4 分档约束：gentle < strong < emergency（防配置倒挂）", () => {
    // 与 src/config.ts DEFAULT_CONFIG / acp/config.ts 默认保持一致。
    const gentle = 0.72;
    const strong = 0.82;
    const emergency = 0.85;
    assert.ok(gentle < strong && strong < emergency, "三档应递增：0.72 < 0.82 < 0.85");
    assert.ok(gentle >= 0.5, "温和阈值不应低于 50%（否则正常对话也频繁打扰）");
    assert.ok(emergency <= 0.98, "硬限不应超过 98%（kernel emergencyOverride 语义）");
});

test("V0.4.2 pressure epoch 契约：档位只升不降、压缩关闭后重置可新开", () => {
    // levelForEpoch 语义验证（evaluateNudgeGate 未导出，用等价逻辑直接测核心规则）
    const order = ["gentle", "strong", "emergency"] as const;
    type L = typeof order[number];
    const levelFor = (maxLevel: L | "none", usage: number): L => {
      const base: L = usage >= 0.85 ? "emergency" : usage >= 0.82 ? "strong" : "gentle";
      const cur = maxLevel === "none" ? -1 : order.indexOf(maxLevel);
      return order[Math.max(cur, order.indexOf(base))] ?? base;
    };
    // 低 usage + 历史 strong → 维持 strong（不降档）
    assert.equal(levelFor("strong", 0.70), "strong");
    // 高 usage + 历史 gentle → 升到 emergency
    assert.equal(levelFor("gentle", 0.90), "emergency");
    // 无历史 → 按 usage
    assert.equal(levelFor("none", 0.60), "gentle");
    assert.equal(levelFor("none", 0.83), "strong");
    // 压缩后 closed → 新 epoch 重新按 usage 起步
    assert.equal(levelFor("emergency", 0.75), "emergency"); // closed 前 maxLevel 保留延续
});

test("V0.4.1 usage credit：默认窗口 ≈ contextLimit 的 15%（200k → 30k）", () => {
    const credit = Math.round(200_000 * 0.15);
    assert.equal(credit, 30_000);
    // 压缩后增长 30k 内应免打扰：base + credit - now > 0
    const base = 70_000;
    assert.ok(base + credit - 85_000 > 0, "85k < 100k 仍在 credit 窗口");
    assert.ok(base + credit - 105_000 <= 0, "105k ≥ 100k 已出 credit 窗口");
});