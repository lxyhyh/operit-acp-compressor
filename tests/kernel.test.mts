/**
 * acp-kernel 封装测试：processTurn / applyCompression 在 Node 环境验证。
 * 注：.mts 强制 ESM —— acp-kernel 是纯 ESM 包，tsx 需 ESM 加载。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState } from "acp-kernel";

function mkConfig(overrides: Record<string, unknown> = {}) {
    return {
        tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
        promotionThreshold: 2,
        truncate: { threshold: 0.8 },
        compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 10 },
        protectedTools: [],
        preserveRecentMessages: 1,
        preserveRecentTokens: 1000,
        modelContextLimit: 200_000,
        nudge: {
            maxContextLimitPct: 0.5, minContextLimitPct: 0.2, frequency: 1, iterationThreshold: 1,
            force: "soft", growthRatio: 0.05, growthFloor: 5000, growthCap: 50000,
            minGrowthFloor: 5000, minGrowthRatio: 0.45, emergencyThresholdPct: 0.98,
            tier2GrowthMultiplier: 1.5, minPressureBenefitTokens: 5000,
        },
        ...overrides,
    } as never;
}

function mkMessages() {
    const m: Array<{ id: string; role: "user" | "assistant" | "system"; contentType: "text"; text: string }> = [];
    m.push({ id: "m_sys", role: "system", contentType: "text", text: "sys" });
    for (let i = 0; i < 30; i++) {
        m.push({ id: `m_u${i}`, role: "user", contentType: "text", text: `用户问题 ${i}：` + "A".repeat(300) });
        m.push({ id: `m_a${i}`, role: "assistant", contentType: "text", text: `助手回答 ${i}：` + "B".repeat(300) });
    }
    return m;
}

test("processTurn 返回折叠消息与状态", () => {
    const core = createCore();
    const state = createInitialState();
    const messages = mkMessages();
    const r = core.processTurn({
        messages,
        state,
        config: mkConfig(),
        tokenCount: 100_000,
        renderTags: "all",
    });
    assert.ok(r.messages.length > 0);
    assert.ok(r.state);
    assert.ok(Object.keys(r.state.messageRefs.byRaw).length >= 60, "应分配全部消息 ref");
});

test("applyCompression 按 ref 范围压缩并创建块", () => {
    const core = createCore();
    let state = createInitialState();
    const messages = mkMessages();
    const first = core.processTurn({ messages, state, config: mkConfig(), tokenCount: 100_000, renderTags: "all" });
    state = first.state;
    const byRaw = state.messageRefs.byRaw as Record<string, string>;
    const startRef = byRaw["m_u0"];
    const endRef = byRaw["m_a2"];
    assert.ok(startRef && endRef, "m_u0/m_a2 应分配 ref");
    const r = core.applyCompression({
        ranges: [{ startRef, endRef, summary: "早期问答摘要内容内容", topic: "早期问答" }],
        messages,
        state,
        config: mkConfig(),
    });
    assert.ok(r.state.blocks.length >= 1, "应创建至少一个压缩块");
    assert.equal(r.result.blocksCreated, 1);
});

test("压缩后消息视图包含 acp_summary 占位", () => {
    const core = createCore();
    let state = createInitialState();
    const messages = mkMessages();
    const first = core.processTurn({ messages, state, config: mkConfig(), tokenCount: 100_000, renderTags: "all" });
    state = first.state;
    const byRaw = state.messageRefs.byRaw as Record<string, string>;
    const applied = core.applyCompression({
        ranges: [{ startRef: byRaw["m_u0"], endRef: byRaw["m_a4"], summary: "压缩摘要内容详细说明", topic: "前几轮" }],
        messages,
        state,
        config: mkConfig(),
    });
    state = applied.state;
    const after = core.processTurn({ messages, state, config: mkConfig(), tokenCount: 80_000, renderTags: "all" });
    const hasSummary = after.messages.some((m) => m.id && m.id.startsWith("acp_summary_"));
    assert.ok(hasSummary, "processTurn 后应渲染 acp_summary 占位");
});

// —— 文档 Test B：同一 Session 内连续多次压缩，blocks 持续累积（非重建）
test("Test B：同 Session 连续 3 次压缩 → blocks >= 3（多 Hop 复用状态）", () => {
    const core = createCore();
    let state = createInitialState();
    const messages = mkMessages();
    // 首次 processTurn 建立 refs
    let t = core.processTurn({ messages, state, config: mkConfig(), tokenCount: 100_000, renderTags: "all" });
    state = t.state;

    // 模拟 Hop1..Hop3：每次压缩一个递增区间（复用同一 state，不重建）。
    // 每轮重新 processTurn 获取最新 refs（真实多 Hop 中 refs 随压缩演进）。
    let totalBlocks = 0;
    const startIdx = [0, 8, 16];
    for (let hop = 0; hop < 3; hop++) {
        const tt = core.processTurn({ messages, state, config: mkConfig(), tokenCount: 100_000, renderTags: "all" });
        const byRaw = (tt.state.messageRefs.byRaw as Record<string, string>) ?? {};
        const s = byRaw[`m_u${startIdx[hop]}`] ?? "";
        const e = byRaw[`m_a${startIdx[hop] + 2}`] ?? "";
        if (!s || !e) { assert.fail(`Hop${hop + 1} 缺 ref (m_u${startIdx[hop]} / m_a${startIdx[hop] + 2})`); }
        const applied = core.applyCompression({
            ranges: [{ startRef: s, endRef: e, summary: `Hop${hop + 1} 压缩摘要（用户问题与助手回答的早期对话关键信息摘要）`, topic: `hop-${hop + 1}` }],
            messages,
            state,
            config: mkConfig(),
        });
        state = applied.state; // 复用同一 Session 状态，不重建
        totalBlocks += applied.result.blocksCreated;
        if (applied.result.blocksCreated === 0) {
            // eslint-disable-next-line no-console
            console.log(`[TestB] hop${hop + 1} startRef=${s} endRef=${e} errors=${JSON.stringify(applied.result.errors)} byRawKeys=${Object.keys(tt.state.messageRefs.byRaw).slice(0, 8).join(",")}`);
        }
    }
    assert.ok(totalBlocks >= 3, `同 Session 连续压缩应累积 blocks>=3，实际 ${totalBlocks}`);
});

// —— 文档 Test A 辅助：多 Hop 不重置状态（同一 state 对象持续演进）
test("Test A：同一 Session 跨 Hop 状态持续（blocks 只增不减）", () => {
    const core = createCore();
    let state = createInitialState();
    const messages = mkMessages();
    let t = core.processTurn({ messages, state, config: mkConfig(), tokenCount: 100_000, renderTags: "all" });
    state = t.state;
    const byRaw = state.messageRefs.byRaw as Record<string, string>;
    const n0 = state.blocks.length;
    const applied = core.applyCompression({
        ranges: [{ startRef: byRaw["m_u0"], endRef: byRaw["m_a4"], summary: "一次压缩", topic: "t1" }],
        messages, state, config: mkConfig(),
    });
    state = applied.state;
    assert.ok(state.blocks.length >= n0, "压缩后 blocks 应 ≥ 之前");
    // 再 processTurn（模拟下一 Hop）不重建状态，blocks 保持
    const t2 = core.processTurn({ messages, state, config: mkConfig(), tokenCount: 80_000, renderTags: "all" });
    assert.ok(t2.state.blocks.length >= state.blocks.length, "后续 Hop processTurn 不应减少 blocks");
});