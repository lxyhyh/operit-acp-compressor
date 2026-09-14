/**
 * tools-meta.ts — ACP 工具元数据单一事实来源。
 *
 * 定义 5 个核心工具的唯一声明（名称/描述/参数 schema），
 * METADATA（packages/acp_tools.ts）、系统提示（system-prompt.ts）、
 * nudge 文本（adapter.ts）统一引用，杜绝名称/参数契约漂移。
 * 纯数据 + 零依赖（不 import Tools/环境），便于测试与跨 runtime 复用。
 *
 * V0.7.13-P2：不再注入 availableTools（无 ToolPromptComposeHook 注册）。
 * V0.9.4：模型侧直接调用工具面注册的 acp_tools:* 工具（宿主自动桥接，无需 package_proxy 中转），
 * 本文件仅作为元数据源保留（测试/审计用）。
 */

export interface AcpToolMeta {
  /** 工具名（模型调用名，对应工具面 acp_tools:<name>）。 */
  name: string;
  /** 注入时的 categoryName（Operit 工具分组）。 */
  categoryName: string;
  /** 中文描述（系统提示与注入共用）。 */
  descriptionZh: string;
  /** 英文描述（注入 schema 用）。 */
  descriptionEn: string;
  /** JSON Schema（parameters 字符串化的对象）。 */
  parameters: Record<string, unknown>;
}

/** 5 个核心工具（compress/absorb/decompress/search_context/acp_status，供系统提示与工具面注册对齐）。 */
export const ACP_CORE_TOOLS: readonly AcpToolMeta[] = [
  {
    name: "compress",
    categoryName: "acp_compressor",
    descriptionZh: "压缩指定消息范围（startId..endId）为摘要 block。startId/endId 必须是 acp_status 报告中的 ref id（如 m00001）或 block id（如 b1）。传消息 ref 生成 T1 块；传 block id（b1..bN）会把已压缩块蒸馏为 T2（二级）、T2 块浓缩为 T3（三级）。summary 需保留关键信息。",
    descriptionEn: "Compress a message range (startId..endId) into a summary block. startId/endId must be ref ids (e.g. m00001) or block ids (e.g. b1) reported by acp_status. The summary must retain key information.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "array",
          description: "压缩范围数组：[{ startId, endId, summary, topic?, summaryMaxChars? }]",
          items: {
            type: "object",
            properties: {
              startId: { type: "string", description: "起始消息 ref（如 m00001）或 block id（如 b1）" },
              endId: { type: "string", description: "结束消息 ref（如 m02259）或 block id（如 b1）" },
              summary: { type: "string", description: "范围摘要内容（保留关键决策/数值/结论）" },
            },
            required: ["startId", "endId", "summary"],
          },
        },
        messages: { type: "array", description: "可选，当前消息数组（用于解析 refs）" },
      },
      required: ["content"],
    },
  },
  {
    name: "absorb",
    categoryName: "acp_compressor",
    descriptionZh: "吸收指定 ref 所指的已消费工具结果/大段文本为简短摘要（不可逆，谨慎用）。absorb 适合把巨大的工具输出（日志/文件内容）在确认不再需要原文后换成摘要，释放 token。需要给要吸收的消息 ref id（acp_status 可查）与一段简短说明。",
    descriptionEn: "Absorb a consumed message (by ref id) into a short summary (irreversible, use with care). Good for huge tool outputs (logs/file dumps) you no longer need verbatim.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "要吸收的消息 ref id（如 m00042；acp_status 可查）" },
        summary: { type: "string", description: "吸收后替换的简短摘要" },
      },
      required: ["ref", "summary"],
    },
  },
  {
    name: "decompress",
    categoryName: "acp_compressor",
    descriptionZh: "读取一个已压缩 block 的原文内容（无状态 copy-paste，不改压缩状态）。默认返回一层视图（直接消息+嵌套摘要）；full=true 递归到全部原始消息。restore=true 时才真正恢复激活（deactivate，下次投影含原始消息）。内容超 1 万字符时写入临时文件并返回路径。",
    descriptionEn: "Read a compressed block's original content (stateless copy-paste; does not change compression state). Default returns one-tier view (direct messages + nested summaries); full=true recurses to all original messages. restore=true actually reactivates (deactivate; next projection includes original messages). Content over 10k chars is written to a temp file and its path returned.",
    parameters: {
      type: "object",
      properties: {
        block_id: { type: "string", description: "要读取的 block id（如 b1）" },
        full: { type: "boolean", description: "true 时递归到全部原始消息（默认 false：一层视图）" },
        restore: { type: "boolean", description: "true 时才 deactivate 恢复激活（默认 false：只读原文）" },
      },
      required: ["block_id"],
    },
  },
  {
    name: "search_context",
    categoryName: "acp_compressor",
    descriptionZh: "按关键词搜索已压缩 block，返回匹配 block 的 blockId/title/preview/tier/score。",
    descriptionEn: "Search compressed blocks by keyword; returns matching blockId/title/preview/tier/score.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    },
  },
  {
    name: "acp_status",
    categoryName: "acp_compressor",
    descriptionZh: "查看当前 session 的 ACP 状态：context usage、active blocks（含 blockSpans：每个 block 的 id/tier/ref 跨度）、compressed tokens、当前可压缩范围。blockSpans 用于精确定位可蒸馏（T2）或浓缩（T3）的 block id。",
    descriptionEn: "View ACP status for the current session: context usage, active blocks (blockSpans: each block id/tier/ref span), compressed tokens, compressible ranges. blockSpans helps locate block ids for T2 distill / T3 condense.",
    parameters: { type: "object", properties: {} },
  },
];

/** 注入用的 ToolPromptItem 列表（lifecycle.ts 的 ACP_TOOLS 来源）。 */
export function buildAcpToolPromptItems(): ToolPkgToolPromptItem[] {
  return ACP_CORE_TOOLS.map((t) => ({
    categoryName: t.categoryName,
    name: t.name,
    description: t.descriptionEn,
    parameters: JSON.stringify(t.parameters),
  }));
}

/** 工具名集合（测试/契约校验用）。 */
export function acpCoreToolNames(): string[] {
  return ACP_CORE_TOOLS.map((t) => t.name);
}

/** 工具名 → 中文描述映射（系统提示/nudge 文本引用，避免提示与 schema 漂移）。 */
export function acpToolDescription(name: string): string {
  const t = ACP_CORE_TOOLS.find((x) => x.name === name);
  return t ? t.descriptionZh : "";
}

// 类型引用：避免强依赖类型路径（此处用结构类型，兼容 ToolPkg）。
export type ToolPkgToolPromptItem = {
  categoryName: string;
  name: string;
  description: string;
  parameters: string;
};