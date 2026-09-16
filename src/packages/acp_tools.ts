/* METADATA
{
  name: "acp_tools"
  display_name: {
    zh: "ACP 上下文压缩工具"
    en: "ACP Context Compression Tools"
  }
  description: {
    zh: "ACP 上下文压缩引擎的模型侧工具：compress / decompress / search_context / acp_status。基于 acp-kernel。"
    en: "ACP context compression engine model-side tools: compress / decompress / search_context / acp_status. Built on acp-kernel."
  }
  enabledByDefault: true
  category: "Context Management"
  tools: [
    {
      name: "compress"
      description: {
        zh: "压缩指定消息范围（startId..endId）为摘要 block。startId/endId 必须是 acp_status 报告中的 ref id（如 m00001）或 block id（如 b1）。summary 需保留关键信息。"
        en: "Compress a message range (startId..endId) into a summary block. startId/endId must be ref ids (e.g. m00001) or block ids (e.g. b1) reported by acp_status. The summary must retain key information."
      }
      parameters: [
        { name: "chatId", description: { zh: "会话 ID（可选）", en: "Chat ID (optional)" }, type: "string", required: false }
        { name: "session", description: { zh: "session key（可选，直接指定状态文件）", en: "Session key (optional, direct state file)" }, type: "string", required: false }
        { name: "content", description: { zh: "压缩范围数组：[{ startId, endId, summary, topic?, summaryMaxChars? }]", en: "Compression ranges array: [{ startId, endId, summary, topic?, summaryMaxChars? }]" }, type: "array", required: true }
        { name: "messages", description: { zh: "可选，当前消息数组（用于解析 refs）", en: "Optional, current message array (for ref resolution)" }, type: "array", required: false }
      ]
    }
    {
      name: "absorb"
      description: {
        zh: "吸收指定 ref 所指的已消费工具结果/大段文本为简短摘要（不可逆，谨慎用）。absorb 适合把巨大的工具输出（日志/文件内容）在确认不再需要原文后换成摘要，释放 token。需要给要吸收的消息 ref id（acp_status 可查）与一段简短说明。"
        en: "Absorb a consumed message (by ref id) into a short summary (irreversible, use with care). Good for huge tool outputs (logs/file dumps) you no longer need verbatim."
      }
      parameters: [
        { name: "chatId", description: { zh: "会话 ID（可选）", en: "Chat ID (optional)" }, type: "string", required: false }
        { name: "session", description: { zh: "session key（可选）", en: "Session key (optional)" }, type: "string", required: false }
        { name: "ref", description: { zh: "要吸收的消息 ref id（如 m00042；acp_status 可查）", en: "Ref id of the message to absorb (e.g. m00042; see acp_status)" }, type: "string", required: true }
        { name: "summary", description: { zh: "吸收后替换的简短摘要", en: "Short summary that replaces the absorbed message" }, type: "string", required: true }
      ]
    }
    {
      name: "decompress"
      description: {
        zh: "读取一个已压缩 block 的原文内容（无状态，不改压缩状态）。默认一层视图；full=true 递归全部原始消息；restore=true 才恢复激活（deactivate）。内容超 1 万字符写临时文件返回路径。",
        en: "Read a compressed block's original content (stateless). Default one-tier view; full=true recurses to all original messages; restore=true reactivates (deactivate). Content over 10k chars is written to a temp file."
      }
      parameters: [
        { name: "chatId", description: { zh: "会话 ID（可选）", en: "Chat ID (optional)" }, type: "string", required: false }
        { name: "session", description: { zh: "session key（可选）", en: "Session key (optional)" }, type: "string", required: false }
        { name: "block_id", description: { zh: "要读取的 block id（如 b1）", en: "Block id to read (e.g. b1)" }, type: "string", required: true }
        { name: "full", description: { zh: "true 时递归到全部原始消息", en: "Recurse to all original messages when true" }, type: "boolean", required: false }
        { name: "restore", description: { zh: "true 时才恢复激活（deactivate）", en: "Actually reactivate (deactivate) when true" }, type: "boolean", required: false }
      ]
    }
    {
      name: "search_context"
      description: {
        zh: "按关键词搜索已压缩 block，返回匹配 block 的 blockId/title/preview/tier/score。"
        en: "Search compressed blocks by keyword; returns matching blocks' blockId/title/preview/tier/score."
      }
      parameters: [
        { name: "chatId", description: { zh: "会话 ID（可选）", en: "Chat ID (optional)" }, type: "string", required: false }
        { name: "session", description: { zh: "session key（可选）", en: "Session key (optional)" }, type: "string", required: false }
        { name: "query", description: { zh: "搜索关键词", en: "Search query" }, type: "string", required: true }
      ]
    }
    {
      name: "acp_status"
      description: {
        zh: "查看当前 session 的 ACP 状态：context usage、active blocks、compressed tokens、当前可压缩范围。"
        en: "View ACP status for the current session: context usage, active blocks, compressed tokens, and currently compressible ranges."
      }
      parameters: [
        { name: "chatId", description: { zh: "会话 ID（可选）", en: "Chat ID (optional)" }, type: "string", required: false }
        { name: "session", description: { zh: "session key（可选）", en: "Session key (optional)" }, type: "string", required: false }
        { name: "messages", description: { zh: "可选，当前消息数组（用于 token 估算）", en: "Optional, current message array (for token estimation)" }, type: "array", required: false }
      ]
    }
  ]
}*/

/**
 * acp_tools.ts — subpackage 入口（模型侧工具）。
 *
 * 工具（宿主工具通道执行；返回结构化结果，message 为干净中文说明）：
 * - compress：按 range 压缩消息。
 * - decompress：恢复一个 block。
 * - search_context：搜索已压缩 block。
 * - acp_status：查看状态报告。
 *
 * 与 main 共享同一数据目录（/sdcard/Download/Operit/plugins/com.operit.acp_compressor/），
 * 状态经磁盘文件同步。acp-kernel 内核为无状态 core，本入口内联一份无副作用。
 */

import { createEngine } from "../acp/adapter";
import { buildSessionKey } from "../acp/session";
import { DATA_DIR } from "../acp/paths";
import { markCompressReceived, markTaskEndFoldApplied, getTaskEndFoldState } from "../acp/task-end-fold";
import type { AcpEngine } from "../acp/adapter";

// 共享 engine 实例（模块级，subpackage 只加载一次）。
let engine: AcpEngine | null = null;
function getEngine(): AcpEngine {
  if (!engine) {
    engine = createEngine();
  }
  return engine;
}

/**
 * 从工具 params 提取 session key。
 *
 * 宿主调用 subpackage 工具时会把当前会话注入到特殊前缀参数
 * `__operit_package_chat_id`（实测：d2572685-...），而非裸 `chatId`。
 * 优先级：session > chatId > __operit_package_chat_id > no-chat。
 *
 * V0.7.13 P3 修复：当宿主注入的 chatId 解析出的会话 state 为空
 * （无 refs/无 blocks——说明工具调用时的活跃会话 ≠ nudge 所属会话，
 * 实测 tool_params.log 出现过 f23f6048 但 nudge 来自 d2572685），
 * 自动 fallback 到"最近有有效 state 的会话"（从 state 目录扫描），
 * 避免 compress/absorb 对空会话执行而永远失败。
 */
function sessionKeyFromParams(params: { chatId?: string; session?: string; __operit_package_chat_id?: string }): string {
  if (params.session) return params.session;
  const chatId = params.chatId || (params as Record<string, unknown>).__operit_package_chat_id;
  if (typeof chatId === "string" && chatId.length > 0) return buildSessionKey({ chatId });
  return "no-chat";
}

/**
 * V0.7.13 P3：Session Continuity 修复 —— 受控 fallback。
 *
 * 取证结论（tool_params.log + state 目录）：
 * - 宿主注入 __operit_package_chat_id = 工具调用时活跃会话；
 * - 当该会话 ACP state 为空（0 blocks，说明 nudge 来自另一会话）时，
 *   工具若继续对空会话执行，compress 永远失败（"refs unknown"）。
 *
 * 安全规则：
 * - 仅当主会话 0 blocks 且扫描到【恰一个】有 blocks 的其它会话时，才 fallback；
 * - fallback 必须显式返回 chatId（让模型/日志知道作用于哪个会话）；
 * - 若有多个候选（歧义）→ 不 fallback，保持主会话并返回诊断。
 */
async function resolveEffectiveSession(
  params: { chatId?: string; session?: string; __operit_package_chat_id?: string },
  stateDir: string,
): Promise<{ sessionKey: string; chatId?: string; fallback: boolean }> {
  const primary = sessionKeyFromParams(params);
  const primaryChatId = params.chatId || (params as Record<string, unknown>).__operit_package_chat_id;
  // 快速路径：注入的 chatId 本身就有 state（最常见情况）→ 直接用，不扫描。
  if (typeof primaryChatId === "string" && primaryChatId.length > 0) {
    return { sessionKey: primary, chatId: primaryChatId, fallback: false };
  }
  // V0.9.3：无注入 chatId → 扫描 state 目录，按最近修改时间找"最近活跃"的会话（受控）。
  // 原实现要求"恰一个"候选才 fallback，但实际有 14+ 会话必然歧义 → fallback 永远不触发
  // → 无 chatId 时永远落 no-chat 空会话（acp_status 全 0 / compress refs unknown）。
  // 新策略：无注入时选最近活跃（lastModified 最新）的 state 文件所属会话；若一个都没有 → no-chat。
  try {
    const res = await Tools.Files.list(stateDir, "android");
    const entries = (res && Array.isArray(res.entries) ? res.entries : []) as Array<{
      name?: string;
      lastModified?: string;
    }>;
    let best: { chatId: string; mtime: number } | null = null;
    for (const f of entries) {
      const name = f.name || "";
      const m = /^state_([a-f0-9-]{36})_/.exec(name);
      if (!m) continue;
      const mtime = Date.parse(f.lastModified || "") || 0;
      if (!best || mtime > best.mtime) best = { chatId: m[1], mtime };
    }
    if (best) {
      return { sessionKey: buildSessionKey({ chatId: best.chatId }), chatId: best.chatId, fallback: true };
    }
  } catch { /* 扫描失败 → 保持主会话 */ }
  return { sessionKey: primary, chatId: typeof primaryChatId === "string" ? primaryChatId : undefined, fallback: false };
}

/** 工具统一入口：解析有效 session key（含无 chatId 时的受控 fallback）。 */
async function resolveSessionKey(params: { chatId?: string; session?: string; __operit_package_chat_id?: string }): Promise<string> {
  // 有显式 session / chatId → 直接用（不扫描，最快路径）。
  if (params.session) return params.session;
  const chatId = params.chatId || (params as Record<string, unknown>).__operit_package_chat_id;
  if (typeof chatId === "string" && chatId.length > 0) return buildSessionKey({ chatId });
  // 无注入 → 受控 fallback（最近活跃会话），而不是 no-chat。
  try {
    const stateDir = `${DATA_DIR}/acp-state`;
    const r = await resolveEffectiveSession(params, stateDir);
    if (r.fallback) return r.sessionKey;
  } catch { /* noop */ }
  return "no-chat";
}

/** 从宿主注入的完整参数里取当前会话 chatId（兼容各注入形态）。 */
function injectedChatId(params: Record<string, unknown>): string {
  const c = (params as Record<string, unknown>).__operit_package_chat_id;
  return typeof c === "string" ? c : "";
}

/** 探针：记录宿主实际传给工具的参数概要（验证 chatId/messages 注入）。 */
function probeParams(tool: string, params: Record<string, unknown>): void {
  try {
    const keys = Object.keys(params || {});
    const summary = keys.map((k) => {
      const v = (params as Record<string, unknown>)[k];
      if (Array.isArray(v)) return `${k}=arr[${v.length}]`;
      if (v && typeof v === "object") return `${k}=obj{${Object.keys(v as object).length}}`;
      return `${k}=${String(v).slice(0, 40)}`;
    }).join(", ");
    Tools.Files.write(
      "/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state/logs/tool_params.log",
      `${new Date().toISOString()} [${tool}] ${summary}\n`,
      true,
      "android",
    );
  } catch { /* 探针失败不影响 */ }
}

export async function compress(params: {
  chatId?: string;
  session?: string;
  content: { startId: string; endId: string; summary: string; topic?: string; summaryMaxChars?: number }[];
  messages?: unknown[];
}): Promise<unknown> {
  try {
    probeParams("compress", params as Record<string, unknown>);
    const e = getEngine();
    const sessionKey = await resolveSessionKey(params);
    const ranges = (params.content || []).map((r) => ({
      startRef: r.startId,
      endRef: r.endId,
      summary: r.summary,
      topic: r.topic,
      summaryMaxChars: r.summaryMaxChars,
    }));
    if (ranges.length === 0) {
      return { success: false, message: "content 为空：至少需要一个 { startId, endId, summary } 范围。" };
    }
    // —— V0.8-P7：模型主动 compress 捕获（task-end fold 证据链）。
    try {
      const sk0 = sessionKey;
      if (getTaskEndFoldState(sk0)?.phase === "delivered") markCompressReceived(sk0);
    } catch { /* 状态机失败不影响压缩 */ }
    const turns = Array.isArray(params.messages) ? params.messages : [];
    // V0.7.2：显式传递 chatId（禁止在 engine 内用 sessionKey.split 推导）。
    const chatId = injectedChatId(params as Record<string, unknown>) || params.chatId || "";
    const result = await e.applyCompression(sessionKey, ranges, turns as never, chatId || undefined);
    // —— V0.8-P7：落块成功 → task-end fold 终态（Test2 完成链最后一环）。
    if ((result?.blocksCreated ?? 0) > 0) {
      try { markTaskEndFoldApplied(sessionKey); } catch { /* noop */ }
    }
    const savedTokens = result.tokensCompressed || 0;
    const blocks = result.blocksCreated || 0;
    const createdBlocks = (result as { createdBlocks?: string }).createdBlocks || "";
    return {
      success: true,
      message: blocks > 0
        ? `压缩完成：创建 ${blocks} 个 block，压缩 ${savedTokens} tokens。${createdBlocks ? `\n新建块跨度：${createdBlocks}` : ""}`
        : `未创建 block：${(result.errors || []).join("；") || "范围内没有可压缩内容（可能已被压缩或受保护）"}`,
      data: {
        blocksCreated: blocks,
        tokensCompressed: savedTokens,
        // V0.9.1 block-map：新建块 ref 跨度（b3=m00044–m00097），模型据此精确蒸馏 T2/T3。
        ...(createdBlocks ? { createdBlocks } : {}),
        source: "model",
        errors: result.errors,
        warnings: result.warnings,
      },
    };
  } catch (error) {
    return { success: false, message: String(error && (error as Error).message ? (error as Error).message : error) };
  }
}

export async function decompress(params: {
  chatId?: string;
  session?: string;
  block_id?: string;
  blockId?: string;
  full?: boolean;
  restore?: boolean;
}): Promise<unknown> {
  try {
    probeParams("decompress", params as Record<string, unknown>);
    const e = getEngine();
    const sessionKey = await resolveSessionKey(params);
    const blockId = params.block_id || params.blockId || "";
    if (!blockId) {
      return { success: false, message: "block_id 必填。" };
    }
    // V0.9.2：默认无状态读原文（copy-paste，不改 state，原版 bc-upstream 同款）。
    // restore=true 时才 deactivate（恢复激活，下次投影含原始消息）。
    if (params.restore === true) {
      const r = await e.deactivateBlock(sessionKey, blockId);
      if (!r.ok) {
        return { success: false, message: r.error || "decompress 失败" };
      }
      return {
        success: true,
        message: `block ${blockId} 已恢复（deactivated），下次投影将包含其原始消息。`,
        data: { restored: true, blockId },
      };
    }
    const result = await e.decompressContent(sessionKey, blockId, params.full === true);
    if (!result.ok) {
      return { success: false, message: result.error || "decompress 失败" };
    }
    if (result.tempFile) {
      return {
        success: true,
        message: `block ${blockId} 内容（${result.count ?? 0} 条）已写入临时文件：${result.tempFile}\n请用文件读取工具读取该文件。`,
        count: result.count,
        tempFile: result.tempFile,
        // V0.10-B1-M 修复（M12）：成功统一挂 data（模型解析结构化结果用同一字段）。
        data: { tempFile: result.tempFile, count: result.count ?? 0 },
      };
    }
    return {
      success: true,
      message: `[Block ${blockId} content — ${result.count ?? 0} item(s)${params.full === true ? ", full" : ""}]\n${result.body}`,
      count: result.count,
      body: result.body,
      data: { body: result.body, count: result.count ?? 0, full: params.full === true },
    };
  } catch (error) {
    return { success: false, message: String(error && (error as Error).message ? (error as Error).message : error) };
  }
}

export async function absorb(params: {
  chatId?: string;
  session?: string;
  ref?: string;
  summary?: string;
}): Promise<unknown> {
  try {
    probeParams("absorb", params as Record<string, unknown>);
    const e = getEngine();
    const sessionKey = await resolveSessionKey(params);
    const ref = (params.ref || "").trim();
    const summary = (params.summary || "").trim();
    if (!ref) {
      return { success: false, message: "ref 必填（要吸收的消息 ref id，acp_status 可查）。" };
    }
    if (!summary) {
      return { success: false, message: "summary 必填（吸收后替换的简短摘要）。" };
    }
    const result = await e.absorb(sessionKey, ref, summary);
    if (!result.ok) {
      return { success: false, message: result.resultText || "absorb 失败" };
    }
    return {
      success: true,
      message: result.resultText || "absorb 完成",
      data: { absorbedTokens: result.absorbedTokens },
    };
  } catch (error) {
    return { success: false, message: String(error && (error as Error).message ? (error as Error).message : error) };
  }
}

export async function search_context(params: {
  chatId?: string;
  session?: string;
  query: string;
}): Promise<unknown> {
  try {
    probeParams("search_context", params as Record<string, unknown>);
    const e = getEngine();
    const sessionKey = await resolveSessionKey(params);
    const query = (params.query || "").trim();
    if (!query) {
      return { success: false, message: "query 必填。" };
    }
    const blocks = await e.search(sessionKey, query);
    return {
      success: true,
      message: `找到 ${blocks.length} 个相关 block。`,
      data: blocks.map((b) => {
        const bb = b as { ref?: string; blockId?: string; title?: string; preview?: string; tier?: number; score?: number; tokens?: number };
        return {
          blockId: bb.blockId || bb.ref || (bb as { id?: string }).id,
          title: bb.title,
          preview: bb.preview,
          tier: bb.tier,
          score: bb.score,
          tokens: bb.tokens,
        };
      }),
    };
  } catch (error) {
    return { success: false, message: String(error && (error as Error).message ? (error as Error).message : error) };
  }
}

export async function acp_status(params: {
  chatId?: string;
  session?: string;
  messages?: unknown[];
}): Promise<unknown> {
  try {
    probeParams("acp_status", params as Record<string, unknown>);
    const e = getEngine();
    const sessionKey = await resolveSessionKey(params);
    const turns = Array.isArray(params.messages) ? params.messages : [];
    const result = await e.status(sessionKey, turns as never);
    let report: unknown = {};
    try {
      report = JSON.parse(result.report);
    } catch {
      report = { raw: result.report };
    }
    return {
      success: true,
      // V0.10-B1-M 修复（M12）：成功路径补 message（与其他工具一致；
      // 结构化内容仍在 data）。
      message: `ACP 状态报告（${Object.keys((report as Record<string, unknown>) ?? {}).length > 0 ? "见 data" : "空"}）。`,
      data: report,
    };
  } catch (error) {
    return { success: false, message: String(error && (error as Error).message ? (error as Error).message : error) };
  }
}

// 具名导出即工具导出（esbuild CJS 下自动生成 exports.compress 等，
// 与 METADATA tools 对齐；宿主按函数名从模块 exports 解析）。