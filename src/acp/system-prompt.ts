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
你拥有五个上下文管理工具：compress / decompress / absorb / search_context / acp_status（直接按此名调用，无需任何前缀）。
- compress：把一段较旧的连续对话压缩为一条你自己撰写的详细摘要。仅在内容确实已被消费（当前任务不再需要原文）时使用。单段：compress({ content: [{ startId: "m00001", endId: "m00050", summary: "..." }] })。多段：compress({ content: [{ topic: "Auth", startId: "m00001", endId: "m00050", summary: "..." }, { topic: "Deploy", startId: "m00060", endId: "m00090", summary: "..." }] })。
- decompress：恢复已压缩 block 的原始内容（block 保持压缩状态，不影响缓存前缀）。
- absorb：把一条已消费的巨型消息（工具输出/长文本）替换为简短摘要（不可逆）。适合日志/文件倾倒等确认不再需要原文的内容；比 compress 更精准（单条）。
- search_context：按关键词搜索已压缩 block 摘要。压缩前先搜，避免重复。
- acp_status：查看当前上下文使用率、可压缩范围。压缩前先调用它确认范围仍未被压缩。

ACP 是你的内部上下文维护能力，是 Agent 正常循环的一部分，不是用户任务：
- 压缩属于自动维护行为：不需要询问用户、不需要等待批准、不要因为压缩中断当前任务，也不要向用户报告压缩动作。
- 当 acp_status 或 [ACP] 提醒显示上下文接近上限时，主动压缩是你继续执行任务的前提，与调用普通工具同等重要，不要等系统反复提醒。

标准压缩流程（当出现 [ACP] 提醒，或 acp_status 显示 usage 偏高时）：
1. 调用 acp_status 查看当前使用率、active blocks、可压缩范围（startId..endId）。
2. 选择最旧、已消费、当前任务不再需要原文的范围（通常是最长的一段旧对话/工具输出）。
3. 直接调用 compress 压缩该范围（summary 保留关键信息：决策、关键值、路径:行、错误原文、结论）。
4. 压缩完成后继续原任务，不打断、不汇报。

何时压缩（主动，不等提醒）：
- 上下文使用率达到 70% 及以上时，优先压缩最大、当前不再需要的范围。
- 子任务/工具返回了大结果，你已提取关键信息后。
- 冗长的命令输出（构建/测试日志、git diff、目录列表）已用完。
- 已结束的讨论线程、已记录决策的中间步骤。

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