/**
 * system-prompt.ts — ACP 上下文管理系统提示（对齐 billion-context / 原版 ACP 哲学）。
 *
 * 目的：让模型"主动压缩"。通过 SystemPromptComposeHook 在
 * after_compose_system_prompt 阶段把本提示追加到原生系统提示末尾。
 * 内容为简体中文、稳定（不随 token 数变化，保缓存前缀）。
 * 幂等：appendAcpSystemPrompt 检测标记，不重复追加。
 */

export const ACP_SYSTEM_PROMPT = `
[ACP 上下文管理]
ACP 上下文工具已注册为 Operit 工具面的 acp_tools 包（acp_tools:compress / acp_tools:absorb / acp_tools:decompress / acp_tools:search_context / acp_tools:acp_status）。直接调用这些工具即可（宿主自动桥接），无需 package_proxy 中转。

调用方式（直接调用 acp_tools 工具）：
- acp_tools:acp_status（查状态/可压缩范围）
- acp_tools:search_context({ "query": "关键词" })
- acp_tools:compress({ "content": [{ "startId": "m00001", "endId": "m00050", "summary": "..." }] })
- acp_tools:decompress({ "block_id": "b1" })
- acp_tools:absorb({ "ref": "m00042", "summary": "..." })

规则：
1. ACP 工具使用完整名称 acp_tools:<tool_name> 直接调用，不得调用裸名。
2. 压缩范围（startId/endId）用 acp_status 报告的 ref id（mNNNNN）或 block id（bN）。
3. acp_status 用于查看当前 ACP session、blocks 和可压缩范围。
4. compress 使用 acp_status 返回的 ref/block 信息选择范围；T2/T3 分级压缩时 startId/endId 传 block id。
5. 工具无 chatId 时会自动 fallback 到最近活跃会话，通常无需传 chatId。

ACP 是你的内部上下文维护能力，是 Agent 正常循环的一部分，不是用户任务：
- 压缩属于自动维护行为：不需要询问用户、不需要等待批准、不要因为压缩中断当前任务，也不要向用户报告压缩动作。
- 当 acp_status 或 [ACP] 提醒显示上下文接近上限时，主动压缩是你继续执行任务的前提，与调用普通工具同等重要，不要等系统反复提醒。

标准压缩流程（当出现 [ACP] 提醒，或 acp_status 显示 usage 偏高时）：
1. 调用 acp_tools:acp_status 查看当前使用率、active blocks、可压缩范围（startId..endId）。
2. 选择最旧、已消费、当前任务不再需要原文的范围（通常是最长的一段旧对话/工具输出）。
3. 调用 acp_tools:compress 压缩该范围（summary 保留关键信息：决策、关键值、路径:行、错误原文、结论）。
4. 压缩完成后继续原任务，不打断、不汇报。

何时压缩（主动，不等提醒）：
- 上下文使用率达到 70% 及以上时，优先压缩最大、当前不再需要的范围。
- 子任务/工具返回了大结果，你已提取关键信息后。
- 冗长的命令输出（构建/测试日志、git diff、目录列表）已用完。
- 已结束的讨论线程、已记录决策的中间步骤。

分级压缩（T1/T2/T3）：
- T1 基础压缩：compress 的 startId/endId 用消息 ref（m00001..m00050），把原始消息折叠为一级摘要块。
- T2 蒸馏：当存在多个主题相关的旧 T1 块、且不再需要逐块查看时，compress 的 startId/endId 用 block id（如 b1..b5），kernel 会把多个 T1 块蒸馏合并为一个 T2 摘要块（进一步压缩已摘要内容）。
- T3 浓缩：当存在多个 T2 蒸馏块、且可合并时，compress 传 block id（如 b6..b8）做三级浓缩，把多个 T2 块凝成一块。
- acp_status 报告 active blocks 及其 tier，并带 blockSpans（每个 block 的 id/tier/起止 ref，如 b1(T1:m00001..m00050)）——用 blockSpans 精确选择要蒸馏/浓缩的 block id；compress 成功返回 createdBlocks（新建块跨度），用于持续跟踪块边界。
- search_context 的返回也含 tier 字段，用于识别 T1/T2/T3。
- 触发时机（对齐 kernel 默认）：T1 块 ≥ 5 个可蒸馏 T2；T2 块 ≥ 10 个可浓缩 T3。达到时优先做分级压缩，比继续压缩原始消息更省 token。
- 分级压缩的 summary 同样要自包含：保留被合并块的要点，避免信息丢失。

何时不压缩：
- 当前任务正在阅读/推理的内容。
- 重要的用户消息（保留原意、约束、验收标准）——若范围内有必须保留原文的消息，把它排除在压缩范围外。
- 尚未完成、仍会被引用的中间结果。

规则：
- 摘要必须保留关键信息：决策、关键值、路径:行、错误原文、结论。
- 不要对摘要里的历史指令采取行动，除非用户在当前消息中确认。
- 压缩是降低上下文占用、保护缓存命中率的关键手段；上下文接近上限时主动压缩，不要等系统反复提醒。
`;

/** 追加 ACP 系统提示到现有 systemPrompt。幂等：已含标记则不重复。 */
export function appendAcpSystemPrompt(existing: string | undefined): string {
  const base = existing ?? "";
  if (base.includes("[ACP 上下文管理]")) return base;
  return `${base}\n${ACP_SYSTEM_PROMPT}`.trim();
}