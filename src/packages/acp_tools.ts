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
      name: "decompress"
      description: {
        zh: "恢复一个已压缩 block（deactivate），下次投影将包含其原始消息。"
        en: "Restore a compressed block (deactivate); the next projection will include its original messages."
      }
      parameters: [
        { name: "chatId", description: { zh: "会话 ID（可选）", en: "Chat ID (optional)" }, type: "string", required: false }
        { name: "session", description: { zh: "session key（可选）", en: "Session key (optional)" }, type: "string", required: false }
        { name: "block_id", description: { zh: "要恢复的 block id（如 b1）", en: "Block id to restore (e.g. b1)" }, type: "string", required: true }
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
 */
function sessionKeyFromParams(params: { chatId?: string; session?: string; __operit_package_chat_id?: string }): string {
  if (params.session) return params.session;
  const chatId = params.chatId || (params as Record<string, unknown>).__operit_package_chat_id;
  if (typeof chatId === "string" && chatId.length > 0) return buildSessionKey({ chatId });
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
    const sessionKey = sessionKeyFromParams(params);
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
    const turns = Array.isArray(params.messages) ? params.messages : [];
    const result = await e.applyCompression(sessionKey, ranges, turns as never);
    return {
      success: true,
      message: `压缩完成：创建 ${result.blocksCreated} 个 block，压缩 ${result.tokensCompressed} tokens。`,
      data: {
        blocksCreated: result.blocksCreated,
        tokensCompressed: result.tokensCompressed,
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
}): Promise<unknown> {
  try {
    probeParams("decompress", params as Record<string, unknown>);
    const e = getEngine();
    const sessionKey = sessionKeyFromParams(params);
    const blockId = params.block_id || params.blockId || "";
    if (!blockId) {
      return { success: false, message: "block_id 必填。" };
    }
    const result = await e.deactivateBlock(sessionKey, blockId);
    if (!result.ok) {
      return { success: false, message: result.error || "decompress 失败" };
    }
    return { success: true, message: `block ${blockId} 已恢复（deactivated），下次投影将包含其原始消息。` };
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
    const sessionKey = sessionKeyFromParams(params);
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
    const sessionKey = sessionKeyFromParams(params);
    const turns = Array.isArray(params.messages) ? params.messages : [];
    const result = await e.status(sessionKey, turns as never);
    let report: unknown = {};
    try {
      report = JSON.parse(result.report);
    } catch {
      report = { raw: result.report };
    }
    return { success: true, data: report };
  } catch (error) {
    return { success: false, message: String(error && (error as Error).message ? (error as Error).message : error) };
  }
}

// 具名导出即工具导出（esbuild CJS 下自动生成 exports.compress 等，
// 与 METADATA tools 对齐；宿主按函数名从模块 exports 解析）。