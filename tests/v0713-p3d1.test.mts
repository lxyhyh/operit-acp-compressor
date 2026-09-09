/**
 * v0713-p3d1.test.mts — V0.7.13-P3-D.1 save→load cache 一致性回归测试。
 *
 * 背景：P3-D.1 发现 compress 建块后同一 engine 实例内 acp_status 仍报 0 blocks，
 * 根因是 save() 成功后未同步内存 load cache（mtime 未变 → load 命中旧缓存）。
 *
 * 验证：
 * - A: save(V1) → load = V1
 * - B: save(V2, blocks=1) → load = V2（blocks=1）——修复前会命中旧缓存返回 V1
 * - C: 新实例 load = V2（跨实例 global cache 一致）
 */
import { test } from "node:test";
import assert from "node:assert";
import { createPersistence, type OperitAcpSessionState } from "../src/acp/persistence";
import { createInitialState } from "acp-kernel";

// —— mock Tools.Files（node 测试环境无宿主注入；内存实现模拟真实文件系统）——
const memFS = new Map<string, { content: string; mtime: number }>();
let fakeClock = 1000;
(globalThis as Record<string, unknown>).Tools = {
  Files: {
    mkdir: async () => {},
    read: async (p: string) => {
      const f = memFS.get(p);
      return f ? { content: f.content } : { content: "" };
    },
    write: async (p: string, content: string) => {
      memFS.set(p, { content, mtime: ++fakeClock });
    },
    move: async (from: string, to: string) => {
      const f = memFS.get(from);
      if (f) { memFS.set(to, { ...f, mtime: ++fakeClock }); memFS.delete(from); }
    },
    info: (p: string) => {
      const f = memFS.get(p);
      return f ? { mtimeMs: f.mtime } : undefined;
    },
    deleteFile: async (p: string) => { memFS.delete(p); },
    list: async () => [],
  },
};

const SID = "test-session-6f88d3fa";

function makeState(version: number, blocks: number): OperitAcpSessionState {
  const ks = createInitialState();
  if (blocks > 0) {
    (ks as { blocks: unknown[] }).blocks = [
      { blockId: "b1", active: true, refs: ["m00125", "m00240"], summary: "test", tokens: 100, title: "t", createdAt: Date.now() },
    ];
  }
  return {
    adapterStateVersion: 2,
    kernelState: ks,
    hostMetadata: { toolLoopCoverage: "unknown", lastUpdatedAt: Date.now(), stateVersion: version },
  };
}

test("P3-D1-A: save(V1) → load = V1", async () => {
  const p = createPersistence("/data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/.p3d1test");
  await p.save(SID, makeState(1, 0));
  const s = await p.load(SID);
  assert.equal(s.hostMetadata.stateVersion, 1);
  assert.equal(s.kernelState.blocks.length, 0);
});

test("P3-D1-B: save(V2, blocks=1) → load = V2 含 b1（修复点：save 后同步 cache）", async () => {
  const p = createPersistence("/data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/.p3d1test");
  await p.save(SID, makeState(2, 1));
  const s = await p.load(SID);
  assert.equal(s.hostMetadata.stateVersion, 2, "stateVersion=2");
  assert.equal(s.kernelState.blocks.length, 1, "blocks=1（b1 可见）");
  assert.equal((s.kernelState.blocks[0] as { blockId: string }).blockId, "b1");
});

test("P3-D1-C: 新实例 load = V2（跨实例一致）", async () => {
  const p2 = createPersistence("/data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/.p3d1test");
  const s = await p2.load(SID);
  assert.equal(s.hostMetadata.stateVersion, 2);
  assert.equal(s.kernelState.blocks.length, 1);
});
