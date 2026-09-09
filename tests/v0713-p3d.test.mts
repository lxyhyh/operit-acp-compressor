/**
 * v0713-p3d.test.mts — V0.7.13-P3-D stale-write monotonic guard 回归测试。
 *
 * 文档第十五节 Scenario A~E：
 * - A：FULL → STAGE2：persistent 保持 V2（FULL 后 STAGE2 写 V1 被拦截）
 * - B：FULL → CACHE-HIT：persistent 保持 V2
 * - C：FULL → INCREMENTAL：persistent >= V2
 * - D：Tool mutation → Project：project 使用 V2（不被工具覆盖回 V1）
 * - E：Project → Tool mutation → Project：最终 V3
 *
 * 同时验证：
 * - stateVersion 单调不降（FULL 递增，STAGE2/CACHE-HIT/INCREMENTAL 不覆盖）
 * - kernelState 不回滚（refs 保持最新）
 * - hostMetadata 前向合并（stage2 的 usage/nudge 仍落盘）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPersistence, type OperitAcpSessionState } from "../src/acp/persistence.ts";

/** 内存 mock 文件系统（Tools.Files 的最小可测子集）。 */
const memFs = new Map<string, string>();

function installMockTools(): void {
  (globalThis as Record<string, unknown>).Tools = {
    Files: {
      async mkdir(path: string, _recursive: boolean, _env: string) {
        void path;
      },
      async read(path: string) {
        return { content: memFs.get(path) ?? "" };
      },
      async write(path: string, content: string, _append: boolean, _env: string) {
        memFs.set(path, content);
      },
      async move(from: string, to: string, _env: string) {
        const content = memFs.get(from);
        if (content !== undefined) memFs.set(to, content);
        memFs.delete(from);
      },
      async deleteFile(path: string, _recursive: boolean, _env: string) {
        memFs.delete(path);
      },
      info(path: string) {
        return memFs.has(path) ? { mtimeMs: 1000 + memFs.size } : undefined;
      },
    },
  };
}

/** 构造一个 V1/V2/V3 state（refs 递增）。 */
function makeState(version: number, highestRef: number): OperitAcpSessionState {
  const byRef: Record<string, string> = {};
  const byRaw: Record<string, string> = {};
  for (let i = 1; i <= highestRef; i++) {
    const ref = `m${String(i).padStart(5, "0")}`;
    byRef[ref] = `host:${i}`;
    byRaw[`host:${i}`] = ref;
  }
  return {
    adapterStateVersion: 2,
    kernelState: {
      blocks: [],
      messageRefs: { byRef, byRaw },
      tokenSnapshot: {},
      nudge: { shouldInject: false, reason: "" },
      stats: { tokensCompressed: 0, compressionCount: 0, absorbedTokens: 0 },
      absorbed: [],
      nextBlockId: 1,
      nextRunId: 1,
    },
    hostMetadata: {
      stateVersion: version,
      toolLoopCoverage: "main-request-only",
      lastUpdatedAt: Date.now(),
      runtimeStats: {
        nudgeIssued: 0, gentleNudges: 0, strongNudges: 0, emergencyNudges: 0,
        compressCalled: 0, compressSucceeded: 0, compressFailed: 0,
        emergencyTriggered: 0, emergencySavedTokens: 0, modelSavedTokens: 0, nudgeIgnored: 0,
      },
    },
  };
}

function refsCount(state: OperitAcpSessionState): number {
  return Object.keys(state.kernelState.messageRefs?.byRef ?? {}).length;
}

const SID = "test-session-6f88d3fa";

test("V0.7.13-P3D-A: FULL(V2) → STAGE2(V1) — persistent 保持 V2（stale 拦截）", async () => {
  installMockTools();
  memFs.clear();
  const p = createPersistence("/tmp/acp-test-state");

  // FULL: V1 → V2（refs 2 → 240）
  const v2 = makeState(2, 240);
  await p.save(SID, v2);
  const afterFull = await p.load(SID);
  assert.equal(afterFull.hostMetadata.stateVersion, 2, "FULL 后 stateVersion=2");
  assert.equal(refsCount(afterFull), 240, "FULL 后 refs=240");

  // STAGE2 误写 V1（refs=2）→ 必须被拦截，persistent 保持 V2
  const v1 = makeState(1, 2);
  await p.save(SID, v1);
  const afterStage2 = await p.load(SID);
  assert.equal(afterStage2.hostMetadata.stateVersion, 2, "STAGE2 写 V1 被拦截：版本仍=2");
  assert.equal(refsCount(afterStage2), 240, "STAGE2 写 V1 被拦截：refs 仍=240（不回滚）");
});

test("V0.7.13-P3D-B: FULL(V2) → CACHE-HIT(V1) — persistent 保持 V2", async () => {
  installMockTools();
  memFs.clear();
  const p = createPersistence("/tmp/acp-test-state-b");

  await p.save(SID, makeState(2, 240));
  // cache-hit 带旧 usage/nudge metadata，但 kernelState 是 V1（stale）
  const cacheHit = makeState(1, 2);
  cacheHit.hostMetadata.runtimeStats = {
    ...cacheHit.hostMetadata.runtimeStats!,
    nudgeIssued: 7, // cache-hit 决策元数据
  };
  await p.save(SID, cacheHit);
  const after = await p.load(SID);
  assert.equal(after.hostMetadata.stateVersion, 2, "CACHE-HIT 不降版本");
  assert.equal(refsCount(after), 240, "CACHE-HIT 不回滚 refs");
  // hostMetadata 前向合并：nudge 统计保留
  assert.equal(after.hostMetadata.runtimeStats?.nudgeIssued, 7, "hostMetadata 前向合并保留");
});

test("V0.7.13-P3D-C: FULL(V2) → INCREMENTAL(V1) — persistent >= V2", async () => {
  installMockTools();
  memFs.clear();
  const p = createPersistence("/tmp/acp-test-state-c");

  await p.save(SID, makeState(2, 240));
  const inc = makeState(1, 2); // incremental 误写旧 V1
  await p.save(SID, inc);
  const after = await p.load(SID);
  assert.ok(after.hostMetadata.stateVersion! >= 2, "INCREMENTAL 不降版本");
  assert.ok(refsCount(after) >= 240, "INCREMENTAL 不回滚 refs");
});

test("V0.7.13-P3D-D: Tool mutation(V2) → Project 写 V1 — project 使用 V2（不被覆盖）", async () => {
  installMockTools();
  memFs.clear();
  const p = createPersistence("/tmp/acp-test-state-d");

  // compress 工具：V1 → V2（refs 2 → 240）
  await p.save(SID, makeState(2, 240));
  // project 后写 V1（旧 cached）→ 拦截
  await p.save(SID, makeState(1, 2));
  const after = await p.load(SID);
  assert.equal(after.hostMetadata.stateVersion, 2, "project 不覆盖工具 mutation");
  assert.equal(refsCount(after), 240, "refs 保持 V2");
});

test("V0.7.13-P3D-E: Project(V2) → Tool mutation(V3) → Project 写 V2 — 最终 V3", async () => {
  installMockTools();
  memFs.clear();
  const p = createPersistence("/tmp/acp-test-state-e");

  // Project: V1 → V2
  await p.save(SID, makeState(2, 240));
  // Tool mutation: V2 → V3（compress 建块，blocks=1, refs=240）
  const v3 = makeState(3, 240);
  v3.kernelState.blocks = [{
    blockId: "b1", title: "test", summary: "s", tokens: 100,
    startRef: "m00001", endRef: "m00100", active: true, runId: 1, createdAt: Date.now(),
    compressCallId: "c1", source: "model",
  }];
  await p.save(SID, v3);
  // Project 写 V2（旧 cached）→ 拦截，保持 V3
  await p.save(SID, makeState(2, 240));
  const after = await p.load(SID);
  assert.equal(after.hostMetadata.stateVersion, 3, "最终 V3（不被 V2 回滚）");
  assert.equal(after.kernelState.blocks.length, 1, "blocks 保留 V3 的 1 个");
  assert.equal(refsCount(after), 240, "refs 保持 240");
});

test("V0.7.13-P3D-F: 正常前向写入（V1→V2→V3）不受 guard 影响", async () => {
  installMockTools();
  memFs.clear();
  const p = createPersistence("/tmp/acp-test-state-f");

  await p.save(SID, makeState(1, 2));
  await p.save(SID, makeState(2, 100));
  await p.save(SID, makeState(3, 240));
  const after = await p.load(SID);
  assert.equal(after.hostMetadata.stateVersion, 3, "前向写入正常");
  assert.equal(refsCount(after), 240, "refs 前向正常");
});
