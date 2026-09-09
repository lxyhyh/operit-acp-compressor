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
var __g = (typeof globalThis !== "undefined") ? globalThis : this;
if (typeof __g.process === "undefined") { __g.process = { env: { ACP_REASONING_KEEP: "0" } }; }
var process = __g.process;
if (typeof __g.Intl === "undefined") { __g.Intl = {}; }
if (typeof __g.Intl.Segmenter === "undefined") {
  var SegmenterShimImpl = function(_locale, options) { this.g = (options && options.granularity) || "grapheme"; };
  SegmenterShimImpl.prototype.segment = function(input) {
    var text = String(input == null ? "" : input);
    var out = [];
    if (this.g === "word") {
      var re = /[A-Za-z0-9_']+/g; var m; var last = 0;
      while ((m = re.exec(text)) !== null) {
        for (var i = last; i < m.index; i++) out.push({ segment: text[i], index: i, input: text, isWordLike: false });
        out.push({ segment: m[0], index: m.index, input: text, isWordLike: true });
        last = m.index + m[0].length;
      }
      for (var j = last; j < text.length; j++) out.push({ segment: text[j], index: j, input: text, isWordLike: false });
    } else {
      for (var k = 0; k < text.length; k++) out.push({ segment: text[k], index: k, input: text, isWordLike: false });
    }
    return out[Symbol.iterator]();
  };
  __g.Intl.Segmenter = SegmenterShimImpl;
}

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/packages/acp_tools.ts
var acp_tools_exports = {};
__export(acp_tools_exports, {
  absorb: () => absorb,
  acp_status: () => acp_status,
  compress: () => compress,
  decompress: () => decompress,
  search_context: () => search_context
});
module.exports = __toCommonJS(acp_tools_exports);

// src/shims/module-shim.ts
function createRequire() {
  return function requireStub(id) {
    throw new Error(`[acp] module.createRequire \u4E0D\u53EF\u7528\uFF08QuickJS\uFF09\uFF1A\u65E0\u6CD5\u52A0\u8F7D ${id}`);
  };
}

// node_modules/acp-kernel/dist/chunk-MWXUJVMN.js
var import_meta = {};
var require2 = createRequire(import_meta.url);
function defaultCountTokens(text) {
  if (!text) return 0;
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjk?.length ?? 0;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}
var COMPRESS_PHILOSOPHY = `Compression Philosophy:
- All compression serves the primary task, but be frugal.
- Context capacity is precious. Save context by compressing consumed outputs, not by avoiding tools.
- Compress by need, not by percentage.
- Work from summaries, not raw tool outputs. All listed ranges (user prompts, tool outputs, code, logs, exploration, intermediate steps) should be compressed to summary format \u2014 the ONLY exceptions are protected content, content the current step is actively using, or critical content you cannot reconstruct.`;
var HOW_TO_COMPRESS_RULES = `HOW TO COMPRESS

When you call \`compress\`, the summary you write becomes the only record of the replaced conversation. Make it self-contained and complete: every user request, experiment purpose, and work task in the range must be accurately captured. A later reader (or you, after decompressing) should be able to continue the task WITHOUT needing the original.

KEEP VERBATIM \u2014 never paraphrase or abbreviate these:
- Full file paths with line numbers, directory prefix on every mention (\`lib/hooks.ts:347\`, \`src/index.ts:12-18\`, \`gatenet_v3/model.py:45\`). Never abbreviate to a bare filename (\`hooks.ts\`, \`model.py\`) \u2014 they are ambiguous and cannot be grepped or decompressed-to later.
- Function, class, and type signatures (exact names, params, return types) AND critical code lines that encode logic \u2014 the line that IS the finding, not just the function name (e.g. \`kv_keys += define_gate * a_key[i](emb)\` is more useful than "see model_kvnet.py").
- Error messages and stack traces (exact text \u2014 you need the literal string to grep for it later).
- Key details from reports and analyses \u2014 not just the conclusion. Keep the comparison numbers and the mechanism, not "X is worse" alone (write "1.76\xD7 PPL gap because KV store is static", not "KVNet underperforms").
- Decisions and their rationale ("chose X over Y because Z" \u2014 the "because" is load-bearing; without it the decision looks arbitrary).
- Constraints discovered ("must support Node 22", "no new dependencies", "AGENTS.md forbids \`as any\`").
- Exact values: versions, config keys, thresholds, magic numbers.
- User intent \u2014 quote short user messages verbatim. When the message is too long to quote, preserve intent with extra care: do not change scope, constraints, priorities, acceptance criteria, or requested outcomes. Mark them clearly as past quotes (e.g., "User said: ..."), not as current directives. Losing these changes the task itself.
- The user's overall goal and any changes to it \u2014 the big-picture objective plus how it evolved during the compressed range. Each summary must reflect the goal as it stood at the end of the range, including pivots (e.g., "initially: fix bug X \u2192 pivoted to: refactor module Y after discovering root cause"). Losing the goal or its evolution makes all subsequent work appear unmotivated.
- Purpose behind each significant action \u2014 preserve not just what was done but why: the hypothesis behind each experiment, the question behind each exploration, the task goal behind each work action. Without purpose, the summary reads as disconnected technical steps with no through-line.
- Open questions and unresolved TODOs \u2014 losing these changes what work appears to remain.
- Message refs of key anchors (\`m00420\`, \`m00510\u2013m00520\`) \u2014 they let you or a later reader jump back via decompress to the exact original.

DROP \u2014 extract the signal, discard the vessel:
- Verbose logs (build/test/\`npm\` output) once you have captured the error line or the result.
- Duplicate file reads once the needed content is recorded.
- Consumed exploration \u2014 search hits, agent return values, successful tool outputs \u2014 once you have extracted the facts you need (same rule as dead-ends, but nothing went wrong; the content is simply spent).
- Dead-end exploration \u2014 but PRESERVE the lesson in one line: "tried X, failed because Y".
- Back-and-forth discussion and self-corrections once the final position is captured (keep the outcome, drop the journey to it).
- Repeated status checks (\`git status\`, \`ls\`) once state is known.

For each significant item you DROP (scripts, reports, large analyses, long tool outputs), add a one-line CONTENT description of what it covers \u2014 not where it lives. Bad: "probe script at /path/probe_kvnet.py". Good: "probe_kvnet.py: tests n-gram baseline, generation quality, long-range dependency, position sensitivity, op pipeline, QUERY attention." This lets a later decompress target the right block by relevance, not by guessing locations.

PRIORITY \u2014 when the summary must be compact, preserve in this order:
1. User's overall goal, goal evolution, intent, and hard constraints (losing these changes the task).
2. Decisions and rationale.
3. Exact technical artifacts: paths, signatures, errors, values.
4. Conclusions and key findings.
5. Lessons learned: what failed and why.

Write dense, scannable bullets \u2014 not narrative prose. If the range spans distinct concerns (request \u2192 findings \u2192 decision), group bullets under short thematic headers so a reader can scan to the part they need. Every line must earn its place. Do not mimic the style of existing summaries in context; follow these rules.`;
var TIER2_DISTILL_RULES = `TIER 2 COMPRESSION \u2014 DISTILLATION

You are compressing historical summaries (not raw conversation). These summaries have already captured the details. Your job is to DISTILL them: extract only what matters for future work, discard the process.

KEEP \u2014 these are the only things that survive distillation:
- Decisions and their rationale ("chose X over Y because Z" \u2014 the "because" is load-bearing).
- Final outcomes: version numbers shipped, PR numbers merged/closed, bugs fixed or deferred.
- Key lessons: what failed and why ("tried X, failed because Y"). These prevent repeating mistakes.
- Critical constraints discovered ("must support Node 22", "AGENTS.md forbids as any").
- Design decisions with architectural impact ("chose compress-as-anchor over synthetic messages because prefix cache").
- Whether content is OBSOLETE or SUPERSEDED \u2014 mark with one line: "[SUPERSEDED by PR #NNN]" or "[OBSOLETE: deleted in vX.Y.Z]". Do NOT keep the obsolete content's details \u2014 just the marker and reason.
- Function/class/type names and module paths that are the SUBJECT of the work \u2014 e.g., "fixed filterCompressedRanges in prune.ts", "added SessionStateRegistry in state.ts". Not exact line numbers or full signatures \u2014 just enough to LOCATE the code without searching.
- Exploration findings: if a block was exploratory with no decision, keep the CONCLUSION in one line ("explored X, not viable because Y"). Do not keep the exploration process.

DROP \u2014 these were useful during the work but are no longer needed:
- Exact line numbers, diffs, verbose function signatures, full code listings.
- Build/deploy process details, test execution steps.
- Review process details (who reviewed, what rounds, test counts).
- Verbose logs, command output, intermediate debugging steps.

FORMAT:
- Start each distilled block with a source header line:
  \`Source: bN+bM+... (XK\u2192YK tok, Zx). [original topic]\`
  Example: \`Source: b5+b7 (56K+44K\u2192268 tok, 375x). [Tool-result recap + publish]\`
- 3-5 bullet points per source block, each a self-contained fact.
- Dense, scannable \u2014 no narrative prose.
- Start with the outcome, not the process: "v1.13.0 shipped (7 PRs bundled)" not "implemented 7 PRs then reviewed then merged".
- Cross-block synthesis: if multiple source blocks cover the same topic (same PR, same feature, same bug), MERGE them into a single group of bullets. Do not repeat the same fact from different blocks \u2014 keep it once under the most relevant source header.

SIZE TARGET: 50-150 tokens per source block (excluding the header). If you can't fit it in 150 tokens, you're keeping too much process. If a block has nothing worth keeping (pure noise), output just the header followed by "[no actionable content]."`;
var TIER3_CONDENSE_RULES = `TIER 3 COMPRESSION \u2014 ULTRA-CONDENSATION

You are compressing distilled summaries (Tier 2) into ultra-condensed facts (Tier 3). The distilled summaries already contain only decisions and outcomes. Your job is to reduce them to bare factual references.

PRIORITY \u2014 when a source block has more facts than the size target allows, keep in this order:
1. Shipped outcomes (versions released, PRs merged) \u2014 these are permanent record.
2. Open work (PRs/issues still pending) \u2014 these may need follow-up.
3. Key decisions with architectural impact ("chose X over Y because Z").
4. Critical constraints ("must support Node 22").
Drop everything else. Tier 3 is a lookup index, not a knowledge base.

FORMAT:
- Start with a source header line:
  \`Source: bN+bM+... (XK\u2192YK tok, Zx). [original topic]\`
- Output 1-3 facts per source block. Each fact is a single line: subject + outcome.
- No explanations, no rationale, no process \u2014 just the fact.
- Format: "[PR/Issue/Version] \u2014 [outcome in \u22648 words]"
- Merge related facts from different source blocks if they concern the same topic.

EXAMPLES:
- "v1.13.0 shipped \u2014 quality gate + GC fix (7 PRs)"
- "PR #196 merged \u2014 preserve-first-user (supersedes #169)"
- "Bug 1214 fixed \u2014 compress consumed all user messages"
- "Chose compress-as-anchor \u2014 prefix cache benefit over synthetic injection"
- "Constraint: AGENTS.md forbids as any \u2014 never suppress types"

DROP:
- Multi-sentence context. If a fact needs >1 sentence, it's too detailed for Tier 3.
- Lessons learned ("tried X, failed because Y") \u2014 drop UNLESS the failure is likely to recur and the block is <30 days old.
- Design rationale details \u2014 keep the decision, drop the "because" unless it's a critical constraint.
- Anything marked [OBSOLETE] or [SUPERSEDED] \u2014 drop entirely, note "[N blocks obsolete]" in the summary.

SIZE TARGET: 30-60 tokens per source block (including header). For a batch of N source blocks, total output \u2248 N \xD7 40 tokens. If a source block has only one trivial fact, output just the header + one line.`;
var defaultPrompts = Object.freeze({
  compressPhilosophy: COMPRESS_PHILOSOPHY,
  howToCompressRules: HOW_TO_COMPRESS_RULES,
  tier2DistillRules: TIER2_DISTILL_RULES,
  tier3CondenseRules: TIER3_CONDENSE_RULES
});

// node_modules/acp-kernel/dist/chunk-UX4LINT7.js
function createInitialState() {
  return {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    tokenSnapshot: {},
    nudge: {
      lastPerMessageNudgeTokens: 0,
      lastNudgeShownTokens: 0,
      baselineTokens: 0,
      anchors: {},
      lastShownByTier: {}
    },
    stats: { tokensCompressed: 0, compressionCount: 0, absorbedTokens: 0 },
    absorbed: [],
    nextBlockId: 1,
    nextRunId: 1
  };
}
function allocateBlockId(state) {
  const id = state.nextBlockId;
  state.nextBlockId = Math.max(1, id) + 1;
  return `b${id}`;
}
function allocateRunId(state) {
  const id = state.nextRunId;
  state.nextRunId = Math.max(1, id) + 1;
  return `r${id}`;
}
function blockById(state, blockId) {
  return state.blocks.find((block) => block.blockId === blockId);
}
function activeBlocks(state) {
  return state.blocks.filter((block) => block.active);
}
function coveredMessageIds(state) {
  const covered = /* @__PURE__ */ new Set();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  return covered;
}
function advanceSurvival(state, promotionThreshold) {
  for (const block of state.blocks) {
    if (!block.active) continue;
    block.survivedCount += 1;
    if (block.survivedCount >= promotionThreshold) {
      block.generation = "old";
    }
  }
}

// node_modules/acp-kernel/dist/index.js
var REF_WIDTH = 5;
var MIN_INDEX = 1;
var MAX_INDEX = 99999;
var REF_PATTERN = /^m0*(\d{1,5})$/;
var BLOCKED_REF = "BLOCKED";
function indexToRef(index) {
  if (!Number.isInteger(index) || index < MIN_INDEX || index > MAX_INDEX) {
    throw new RangeError(
      `ref index out of bounds: ${index} (allowed ${MIN_INDEX}-${MAX_INDEX})`
    );
  }
  return `m${String(index).padStart(REF_WIDTH, "0")}`;
}
function refToIndex(ref) {
  const match = REF_PATTERN.exec(ref.trim().toLowerCase());
  if (!match) return null;
  const index = Number(match[1]);
  if (index < MIN_INDEX || index > MAX_INDEX) return null;
  return index;
}
function refForRaw(map, rawId) {
  return map.byRaw[rawId] ?? null;
}
function rawForRef(map, ref) {
  return map.byRef[ref] ?? null;
}
function assignRefs(messages, options) {
  const map = {
    byRaw: { ...options.existing.byRaw },
    byRef: { ...options.existing.byRef }
  };
  let cursor = Number.isInteger(options.nextIndex) && options.nextIndex >= MIN_INDEX ? options.nextIndex : MIN_INDEX;
  let newlyAssigned = 0;
  for (const message of messages) {
    if (!message.id || options.shouldSkip?.(message)) continue;
    if (map.byRaw[message.id]) continue;
    if (options.isProtected?.(message)) {
      map.byRaw[message.id] = BLOCKED_REF;
      continue;
    }
    const ref = allocateFreeRef(map, cursor);
    cursor = ref.index + 1;
    map.byRaw[message.id] = ref.text;
    map.byRef[ref.text] = message.id;
    newlyAssigned++;
  }
  return { map, nextIndex: cursor, newlyAssigned };
}
function allocateFreeRef(map, start) {
  let candidate = Math.max(start, MIN_INDEX);
  while (candidate <= MAX_INDEX) {
    const text = indexToRef(candidate);
    if (!map.byRef[text]) {
      return { text, index: candidate };
    }
    candidate++;
  }
  throw new Error(
    `ref capacity exhausted: cannot allocate beyond ${indexToRef(MAX_INDEX)}`
  );
}
function highestUsedIndex(map) {
  let highest = 0;
  for (const ref of Object.values(map.byRaw)) {
    const index = ref === BLOCKED_REF ? null : refToIndex(ref);
    if (index !== null && index > highest) highest = index;
  }
  return highest;
}
var SUMMARY_HEADER = "[Compressed conversation section]";
var SUMMARY_ID_PREFIX = "acp_summary_";
function summaryMessageId(blockId) {
  return `${SUMMARY_ID_PREFIX}${blockId}`;
}
function isSummaryMessageId(id) {
  return id.startsWith(SUMMARY_ID_PREFIX);
}
function isRenderedSummaryMessage(message) {
  return isSummaryMessageId(message.id) && message.role === "system" && message.contentType === "text";
}
function prune(messages, state, options = {}) {
  const covered = coveredMessageIds(state);
  if (covered.size === 0) return [...messages];
  const inject = options.injectSummaries ?? true;
  const firstUserIndex = messages.findIndex(
    (message) => message.role === "user"
  );
  const indexById = /* @__PURE__ */ new Map();
  const summaryIndexById = /* @__PURE__ */ new Map();
  messages.forEach((message, index) => {
    indexById.set(message.id, index);
    if (isRenderedSummaryMessage(message))
      summaryIndexById.set(message.id, index);
  });
  const anchors = inject ? collectSummaryAnchors(state, indexById, summaryIndexById) : [];
  return stripOrphanedReasoning(
    stripOrphanedToolResults(
      stripOrphanedToolCalls(
        rebuildMessages(messages, covered, firstUserIndex, anchors)
      )
    )
  );
}
function collectSummaryAnchors(state, indexById, summaryIndexById) {
  const anchors = [];
  for (const block of activeBlocks(state)) {
    const existingIndex = summaryIndexById.get(summaryMessageId(block.blockId));
    if (existingIndex !== void 0) {
      anchors.push({
        blockId: block.blockId,
        summary: block.summary,
        topic: block.topic,
        insertAt: existingIndex
      });
      continue;
    }
    let earliest = null;
    for (const id of block.effectiveMessageIds) {
      const index = indexById.get(id);
      if (index !== void 0 && (earliest === null || index < earliest)) {
        earliest = index;
      }
    }
    anchors.push({
      blockId: block.blockId,
      summary: block.summary,
      topic: block.topic,
      insertAt: earliest ?? 0
    });
  }
  anchors.sort((left, right) => left.insertAt - right.insertAt);
  return anchors;
}
function rebuildMessages(messages, covered, firstUserIndex, anchors) {
  const result = [];
  const pending2 = [...anchors];
  const anchoredSummaryIds = new Set(
    anchors.map((anchor) => summaryMessageId(anchor.blockId))
  );
  for (let index = 0; index < messages.length; index++) {
    while (pending2.length > 0 && pending2[0].insertAt === index) {
      result.push(renderSummary(pending2.shift()));
    }
    if (index === firstUserIndex && firstUserIndex >= 0) {
      result.push(messages[index]);
      continue;
    }
    if (covered.has(messages[index].id)) continue;
    if (isRenderedSummaryMessage(messages[index]) && anchoredSummaryIds.has(messages[index].id))
      continue;
    result.push(messages[index]);
  }
  while (pending2.length > 0) {
    result.push(renderSummary(pending2.shift()));
  }
  return result;
}
function renderSummary(anchor) {
  const body = anchor.summary.trim();
  const topicLine = anchor.topic ? `${SUMMARY_HEADER} \u2014 ${anchor.topic}` : SUMMARY_HEADER;
  const text = body.length === 0 ? topicLine : `${topicLine}
${body}`;
  return {
    id: summaryMessageId(anchor.blockId),
    role: "system",
    contentType: "text",
    text
  };
}
function stripOrphanedToolResults(messages) {
  const knownCallIds = /* @__PURE__ */ new Set();
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId) {
      knownCallIds.add(m.toolCallId);
    }
  }
  return messages.filter(
    (m) => m.contentType !== "tool-result" || !m.toolCallId || knownCallIds.has(m.toolCallId)
  );
}
function stripOrphanedToolCalls(messages) {
  const knownResultIds = /* @__PURE__ */ new Set();
  for (const m of messages) {
    if (m.contentType === "tool-result" && m.toolCallId) {
      knownResultIds.add(m.toolCallId);
    }
  }
  return messages.filter(
    (m) => m.contentType !== "tool-call" || !m.toolCallId || m.toolName === "compress" || knownResultIds.has(m.toolCallId)
  );
}
function stripOrphanedReasoning(messages) {
  const drop = /* @__PURE__ */ new Set();
  for (let i = 0; i < messages.length; i++) {
    if (drop.has(i)) continue;
    if (messages[i].contentType !== "reasoning") continue;
    let j = i;
    while (j + 1 < messages.length && messages[j + 1].contentType === "reasoning") {
      j++;
    }
    const companion = messages[j + 1];
    const hasCompanion = companion !== void 0 && companion.role === "assistant" && (companion.contentType === "text" || companion.contentType === "tool-call");
    if (!hasCompanion) {
      for (let k = i; k <= j; k++) drop.add(k);
    }
  }
  if (drop.size === 0) return messages;
  return messages.filter((_, i) => !drop.has(i));
}
function syncBlocks(messages, state) {
  const presentIds = new Set(messages.map((message) => message.id));
  const deactivated = [];
  const result = {
    blocks: state.blocks.map((block) => ({
      ...block,
      directMessageIds: [...block.directMessageIds],
      effectiveMessageIds: [...block.effectiveMessageIds],
      directBlockIds: [...block.directBlockIds]
    })),
    messageRefs: {
      byRaw: { ...state.messageRefs.byRaw },
      byRef: { ...state.messageRefs.byRef }
    },
    // Snapshot is keyed by ref with primitive values — shallow copy suffices.
    tokenSnapshot: { ...state.tokenSnapshot ?? {} },
    nudge: { ...state.nudge, anchors: { ...state.nudge.anchors } },
    stats: { ...state.stats },
    absorbed: (state.absorbed ?? []).map((record) => ({ ...record })),
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId
  };
  const liveRefs = new Set(
    messages.map((m) => result.messageRefs.byRaw[m.id]).filter((r) => typeof r === "string")
  );
  if (Object.keys(result.tokenSnapshot).length !== liveRefs.size) {
    const pruned = {};
    for (const [ref, n] of Object.entries(result.tokenSnapshot)) {
      if (liveRefs.has(ref)) pruned[ref] = n;
    }
    result.tokenSnapshot = pruned;
  }
  const consumedBlockIds = /* @__PURE__ */ new Set();
  for (const block of result.blocks) {
    for (const consumedId of block.directBlockIds) {
      consumedBlockIds.add(consumedId);
    }
  }
  for (const block of result.blocks) {
    if (consumedBlockIds.has(block.blockId)) {
      block.active = false;
      continue;
    }
    block.active = true;
    const stillPresent = block.effectiveMessageIds.some((id) => presentIds.has(id)) || presentIds.has(summaryMessageId(block.blockId));
    if (!stillPresent) {
      block.active = false;
      deactivated.push(block.blockId);
    }
  }
  return { state: result, deactivated };
}
function defaultConfig(modelContextLimit, overrides = {}) {
  const base = {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.75,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 5e4,
      growthCap: 5e4,
      minGrowthFloor: 2e4,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.95,
      tier2GrowthMultiplier: 1.5
    },
    promotionThreshold: 5,
    truncate: { threshold: 0.95 },
    compress: {
      minCompressRange: 5e3,
      maxSummaryLength: 2e4,
      minSummaryLength: 50
    },
    protectedTools: [],
    preserveRecentMessages: 5,
    preserveRecentTokens: 5e3,
    modelContextLimit,
    absorb: {
      enabled: false,
      toolName: "absorb",
      minToolTokens: 1e3,
      contextThresholdPct: 0,
      excludeTools: []
    }
  };
  return {
    ...base,
    ...overrides,
    tiers: { ...base.tiers, ...overrides.tiers },
    nudge: { ...base.nudge, ...overrides.nudge },
    truncate: { ...base.truncate, ...overrides.truncate },
    compress: { ...base.compress, ...overrides.compress },
    absorb: overrides.absorb ? { ...base.absorb, ...overrides.absorb } : base.absorb
  };
}
function validateConfig(config) {
  const errors = [];
  if (!Number.isFinite(config.modelContextLimit) || config.modelContextLimit <= 0) {
    errors.push("modelContextLimit must be a positive number");
  }
  if (config.nudge.minContextLimitPct > config.nudge.maxContextLimitPct) {
    errors.push(
      "nudge.minContextLimitPct must not exceed nudge.maxContextLimitPct"
    );
  }
  if (config.nudge.maxContextLimitPct > config.nudge.emergencyThresholdPct) {
    errors.push(
      "nudge.maxContextLimitPct must not exceed nudge.emergencyThresholdPct"
    );
  }
  if (config.nudge.minPressureBenefitTokens !== void 0 && (!Number.isFinite(config.nudge.minPressureBenefitTokens) || config.nudge.minPressureBenefitTokens < 0)) {
    errors.push("nudge.minPressureBenefitTokens must be finite and >= 0");
  }
  if (config.promotionThreshold < 1) {
    errors.push("promotionThreshold must be >= 1");
  }
  if (config.truncate.threshold <= 0 || config.truncate.threshold > 1) {
    errors.push("truncate.threshold must be in (0, 1]");
  }
  for (const tier of [config.tiers.tier2Trigger, config.tiers.tier3Trigger]) {
    if (tier < 1) errors.push("tier triggers must be >= 1");
  }
  if (config.tiers.tier3Trigger <= config.tiers.tier2Trigger) {
    errors.push("tiers.tier3Trigger must be greater than tiers.tier2Trigger");
  }
  if (config.absorb) {
    if (config.absorb.enabled && !config.absorb.toolName) {
      errors.push("absorb.toolName must be a non-empty string when enabled");
    }
    if (!Number.isFinite(config.absorb.minToolTokens) || config.absorb.minToolTokens < 0) {
      errors.push("absorb.minToolTokens must be >= 0");
    }
    if (config.absorb.contextThresholdPct < 0 || config.absorb.contextThresholdPct > 1) {
      errors.push("absorb.contextThresholdPct must be in [0, 1]");
    }
  }
  return errors;
}
var MESSAGE_REF_PATTERN = /^m0*(\d{1,5})$/;
var BLOCK_REF_PATTERN = /^b(\d{1,9})$/;
function parseBoundary(ref) {
  const normalized = ref.trim().toLowerCase();
  const messageMatch = MESSAGE_REF_PATTERN.exec(normalized);
  if (messageMatch) {
    const numericId = Number(messageMatch[1]);
    if (numericId >= 1 && numericId <= 99999) {
      return { kind: "message", numericId, raw: normalized };
    }
  }
  const blockMatch = BLOCK_REF_PATTERN.exec(normalized);
  if (blockMatch) {
    const numericId = Number(blockMatch[1]);
    if (numericId >= 1) return { kind: "block", numericId, raw: normalized };
  }
  return null;
}
var BoundaryNotFoundError = class extends Error {
  constructor(kind, endpoint, message) {
    super(message);
    __publicField(this, "code", "BOUNDARY_NOT_FOUND");
    __publicField(this, "kind");
    __publicField(this, "endpoint");
    this.name = "BoundaryNotFoundError";
    this.code = "BOUNDARY_NOT_FOUND";
    this.kind = kind;
    this.endpoint = endpoint;
  }
};
function resolveBoundaries(input) {
  const start = parseBoundary(input.startRef);
  const end = parseBoundary(input.endRef);
  if (!start || !end) {
    throw new Error(
      `Invalid boundary ref(s): startId="${input.startRef}", endId="${input.endRef}". Use mNNNNN or bN.`
    );
  }
  const indexByMessageId = /* @__PURE__ */ new Map();
  input.messages.forEach(
    (message, index) => indexByMessageId.set(message.id, index)
  );
  let snappedBoundaries = [];
  const startAnchor = resolveAnchorIndex(
    start,
    input.state,
    indexByMessageId,
    "start"
  );
  if (startAnchor.snapped) snappedBoundaries.push(startAnchor.snapped);
  const endAnchor = resolveAnchorIndex(
    end,
    input.state,
    indexByMessageId,
    "end"
  );
  if (endAnchor.snapped) snappedBoundaries.push(endAnchor.snapped);
  let startIndex = startAnchor.index;
  let endIndex = endAnchor.index;
  if (startIndex > endIndex) {
    [startIndex, endIndex] = [endIndex, startIndex];
  }
  const messageIds = [];
  for (let index = startIndex; index <= endIndex; index++) {
    const message = input.messages[index];
    if (message && !isRenderedSummaryMessage(message))
      messageIds.push(message.id);
  }
  const boundaryKind = start.kind === "block" || end.kind === "block" ? "block" : "message";
  const nestedBlockIds = [];
  const nestedSeen = /* @__PURE__ */ new Set();
  for (const block of activeBlocks(input.state)) {
    if (blockVisibleInRange(block, indexByMessageId, startIndex, endIndex)) {
      if (!nestedSeen.has(block.blockId)) {
        nestedSeen.add(block.blockId);
        nestedBlockIds.push(block.blockId);
      }
    }
  }
  const protectedGaps = [];
  return {
    startIndex,
    endIndex,
    messageIds,
    nestedBlockIds,
    boundaryKind,
    protectedGaps,
    snappedBoundaries
  };
}
function resolveAnchorIndex(boundary, state, indexByMessageId, endpoint) {
  const label = endpoint === "start" ? "startId" : "endId";
  if (boundary.kind === "message") {
    const rawId = state.messageRefs.byRef[boundary.raw] ?? state.messageRefs.byRef[formatPaddedRef(boundary.numericId)];
    if (!rawId) {
      throw new BoundaryNotFoundError(
        "unknown",
        endpoint,
        `${label}="${boundary.raw}" does not exist in this session (typo or wrong session) \u2014 run acp_status for current refs.`
      );
    }
    const index = indexByMessageId.get(rawId);
    if (index !== void 0) {
      return { index, snapped: null };
    }
    const owner2 = activeOwnerAnchor(state, [rawId], indexByMessageId);
    if (owner2 !== null) {
      return {
        index: owner2,
        snapped: `${label}="${boundary.raw}" refers to a message already compressed into an active block \u2014 anchored to the active block covering it instead.`
      };
    }
    throw new BoundaryNotFoundError(
      "consumed",
      endpoint,
      `${label}="${boundary.raw}" not found in visible context (likely consumed by an existing block).`
    );
  }
  const block = blockById(state, `b${boundary.numericId}`);
  if (!block) {
    throw new BoundaryNotFoundError(
      "unknown",
      endpoint,
      `${label}="b${boundary.numericId}" does not exist in this session (typo or wrong session) \u2014 run acp_status for current refs.`
    );
  }
  if (block.active) {
    const anchor = visibleBlockAnchor(block, indexByMessageId);
    if (anchor !== null) {
      return { index: anchor, snapped: null };
    }
  }
  const owner = activeOwnerAnchor(
    state,
    block.effectiveMessageIds,
    indexByMessageId
  );
  if (owner !== null) {
    return {
      index: owner,
      snapped: `${label}="b${boundary.numericId}" was consumed by a higher-tier block \u2014 anchored to the active block covering its content instead.`
    };
  }
  if (!block.active) {
    throw new BoundaryNotFoundError(
      "consumed",
      endpoint,
      `${label}="b${boundary.numericId}" not found in visible context (block distilled/consumed by a higher-tier block).`
    );
  }
  throw new BoundaryNotFoundError(
    "consumed",
    endpoint,
    `${label}="b${boundary.numericId}" is an active block but none of its content (raw messages or rendered summary) is visible in the current context \u2014 run acp_status to verify.`
  );
}
function activeOwnerAnchor(state, ownedIds, indexByMessageId) {
  if (ownedIds.length === 0) return null;
  const owned = new Set(ownedIds);
  let best = null;
  for (const block of state.blocks) {
    if (!block.active) continue;
    const inherited = inheritedContentIds(state, block);
    let ownsInherited = false;
    for (const id of owned) {
      if (inherited.has(id)) {
        ownsInherited = true;
        break;
      }
    }
    if (!ownsInherited) continue;
    const anchor = visibleBlockAnchor(block, indexByMessageId);
    if (anchor === null) continue;
    if (best === null || anchor < best) {
      best = anchor;
    }
  }
  return best;
}
function inheritedContentIds(state, block) {
  const ids = /* @__PURE__ */ new Set();
  for (const childId of block.directBlockIds) {
    const child = blockById(state, childId);
    if (!child) continue;
    for (const id of child.effectiveMessageIds) ids.add(id);
  }
  return ids;
}
function formatPaddedRef(index) {
  return `m${String(index).padStart(5, "0")}`;
}
function visibleBlockAnchor(block, indexByMessageId) {
  const summaryIndex = indexByMessageId.get(summaryMessageId(block.blockId));
  if (summaryIndex !== void 0) return summaryIndex;
  return earliestIndexOfIds(block.effectiveMessageIds, indexByMessageId);
}
function blockVisibleInRange(block, indexByMessageId, startIndex, endIndex) {
  const summaryIndex = indexByMessageId.get(summaryMessageId(block.blockId));
  if (summaryIndex !== void 0 && summaryIndex >= startIndex && summaryIndex <= endIndex) {
    return true;
  }
  const rawIndex = earliestIndexOfIds(
    block.effectiveMessageIds,
    indexByMessageId
  );
  return rawIndex !== null && rawIndex >= startIndex && rawIndex <= endIndex;
}
function earliestIndexOfIds(ids, indexByMessageId) {
  let earliest = null;
  for (const id of ids) {
    const index = indexByMessageId.get(id);
    if (index !== void 0 && (earliest === null || index < earliest)) {
      earliest = index;
    }
  }
  return earliest;
}
var TRUNCATION_MARKER = "[truncated for context space]";
var DEFAULTS = {
  minOutputTokens: 1e3,
  keepPrefixChars: 2e3,
  keepSuffixChars: 2e3,
  protectRecentMessages: 3
};
function truncateLargeToolOutputs(messages, tokenCount, config, countTokens, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (config.modelContextLimit <= 0) return { messages, truncatedCount: 0, savedTokens: 0 };
  const threshold = config.truncate.threshold * config.modelContextLimit;
  if (tokenCount < threshold) return { messages, truncatedCount: 0, savedTokens: 0 };
  const protectedIndex = messages.length - opts.protectRecentMessages;
  const candidates = [];
  for (let index = 0; index < messages.length; index++) {
    if (index >= protectedIndex) break;
    const message = messages[index];
    if (message.contentType !== "tool-result") continue;
    const text = message.text ?? "";
    if (text.length === 0 || text.includes(TRUNCATION_MARKER)) continue;
    const tokens = countTokens(text);
    if (tokens < opts.minOutputTokens) continue;
    candidates.push({ index, tokens });
  }
  if (candidates.length === 0) return { messages, truncatedCount: 0, savedTokens: 0 };
  candidates.sort((left, right) => right.tokens - left.tokens);
  const targetTokens = threshold * 0.9;
  let savedTokens = 0;
  const edits = /* @__PURE__ */ new Map();
  let truncatedCount = 0;
  for (const candidate of candidates) {
    if (tokenCount - savedTokens <= targetTokens) break;
    const original = messages[candidate.index].text ?? "";
    if (original.length <= opts.keepPrefixChars + opts.keepSuffixChars) continue;
    const prefix = original.slice(0, opts.keepPrefixChars);
    const suffix = original.slice(-opts.keepSuffixChars);
    const replacement = prefix + `

...${TRUNCATION_MARKER} \u2014 original ~${candidate.tokens} tokens]...

` + suffix;
    edits.set(candidate.index, replacement);
    savedTokens += candidate.tokens - countTokens(replacement);
    truncatedCount++;
  }
  if (truncatedCount === 0) return { messages, truncatedCount: 0, savedTokens: 0 };
  const updated = messages.map(
    (message, index) => edits.has(index) ? { ...message, text: edits.get(index) } : message
  );
  return { messages: updated, truncatedCount, savedTokens };
}
var KEEP_LAST_ORPHANED = 2;
function rangeKey(startRef, endRef) {
  return `${startRef}::${endRef}`;
}
function rewriteCompressText(text, liveKeys) {
  let parsed;
  try {
    parsed = JSON.parse(text ?? "");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed;
  const content = obj.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const kept = content.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const s = typeof entry.startId === "string" ? entry.startId : typeof entry.messageId === "string" ? entry.messageId : "";
    const e = typeof entry.endId === "string" ? entry.endId : typeof entry.messageId === "string" ? entry.messageId : "";
    return liveKeys.has(rangeKey(s, e));
  });
  if (kept.length === content.length || kept.length === 0) return null;
  return JSON.stringify({ ...obj, content: kept });
}
function hideConsumedCompressCalls(state, messages) {
  const allBlockCallIds = /* @__PURE__ */ new Set();
  const activeCallIds = /* @__PURE__ */ new Set();
  const liveRangeKeysByCallId = /* @__PURE__ */ new Map();
  const legacyLiveByCallId = /* @__PURE__ */ new Set();
  for (const block of state.blocks) {
    if (!block.compressCallId) continue;
    allBlockCallIds.add(block.compressCallId);
    if (!block.active) continue;
    activeCallIds.add(block.compressCallId);
    if (block.startRef === void 0 || block.endRef === void 0) {
      legacyLiveByCallId.add(block.compressCallId);
      continue;
    }
    let keys = liveRangeKeysByCallId.get(block.compressCallId);
    if (!keys) {
      keys = /* @__PURE__ */ new Set();
      liveRangeKeysByCallId.set(block.compressCallId, keys);
    }
    keys.add(rangeKey(block.startRef, block.endRef));
  }
  const lastOrphanedCallIds = [];
  for (let i = messages.length - 1; i >= 0 && lastOrphanedCallIds.length < KEEP_LAST_ORPHANED; i--) {
    const message = messages[i];
    if (message.toolName !== "compress" || message.contentType !== "tool-call") continue;
    const callId = message.toolCallId;
    if (callId && !allBlockCallIds.has(callId)) {
      lastOrphanedCallIds.push(callId);
    }
  }
  const keepCallIds = /* @__PURE__ */ new Set([...activeCallIds, ...lastOrphanedCallIds]);
  const hiddenCallIds = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (message.toolName === "compress" && message.contentType === "tool-call" && (!message.toolCallId || !keepCallIds.has(message.toolCallId))) {
      if (message.toolCallId) hiddenCallIds.add(message.toolCallId);
    }
  }
  let hidden = 0;
  const result = [];
  for (const message of messages) {
    if (message.toolName === "compress" && message.contentType === "tool-call" && (!message.toolCallId || !keepCallIds.has(message.toolCallId))) {
      hidden++;
      continue;
    }
    if (message.contentType === "tool-result" && message.toolCallId && hiddenCallIds.has(message.toolCallId)) {
      hidden++;
      continue;
    }
    if (message.toolName === "compress" && message.contentType === "tool-call" && message.toolCallId && keepCallIds.has(message.toolCallId)) {
      const liveKeys = liveRangeKeysByCallId.get(message.toolCallId);
      if (liveKeys && liveKeys.size > 0 && !legacyLiveByCallId.has(message.toolCallId)) {
        const rewritten = rewriteCompressText(message.text, liveKeys);
        if (rewritten !== null) {
          result.push({ ...message, text: rewritten });
          continue;
        }
      }
    }
    result.push(message);
  }
  return { messages: result, hidden };
}
var COMPRESS_TOOL_NAME = "compress";
var DECOMPRESS_TOOL_NAME = "decompress";
var SEARCH_CONTEXT_TOOL_NAME = "search_context";
var ACP_STATUS_TOOL_NAME = "acp_status";
var ABSORB_TOOL_NAME = "absorb";
var COMPRESS_TOOL = {
  name: COMPRESS_TOOL_NAME,
  description: "Replace a contiguous range of older conversation with a detailed summary you write. Use when content is genuinely consumed. Batch form: content=[{startId,endId,summary,topic?}]. REQUIRED \u2014 compress without content is invalid.",
  input_schema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Optional short title for the compressed range"
      },
      content: {
        type: "array",
        description: "One or more ranges to compress into separate summary blocks",
        items: {
          type: "object",
          properties: {
            topic: { type: "string" },
            startId: {
              type: "string",
              description: "mNNNNN ref at the start of the range"
            },
            endId: {
              type: "string",
              description: "mNNNNN ref at the end of the range"
            },
            summary: {
              type: "string",
              description: "Self-contained summary replacing the range"
            }
          },
          required: ["startId", "endId", "summary"]
        }
      }
    },
    required: ["content"]
  }
};
var COMPRESS_TOOL_OPENAI = {
  type: "function",
  function: {
    name: COMPRESS_TOOL_NAME,
    description: COMPRESS_TOOL.description,
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Optional short title for the compressed range"
        },
        content: {
          type: "array",
          description: "One or more ranges to compress into separate summary blocks. REQUIRED \u2014 compress without content is invalid.",
          items: {
            type: "object",
            properties: {
              topic: { type: "string" },
              startId: {
                type: "string",
                description: "mNNNNN ref at the start of the range"
              },
              endId: {
                type: "string",
                description: "mNNNNN ref at the end of the range"
              },
              summary: {
                type: "string",
                description: "Self-contained summary replacing the range"
              }
            },
            required: ["startId", "endId", "summary"]
          }
        }
      },
      required: ["content"]
    }
  }
};
var DECOMPRESS_TOOL_OPENAI = {
  type: "function",
  function: {
    name: DECOMPRESS_TOOL_NAME,
    description: "Restores previously compressed content. Use when you need exact details lost in compression. By default restores one tier up. Use full:true for all the way to original messages. Use toFile to write to file instead of inflating context.",
    parameters: {
      type: "object",
      properties: {
        blockId: {
          type: "string",
          description: "Block ID to decompress (e.g. b5)"
        },
        toFile: {
          type: "string",
          description: "Optional: write content to file instead of context"
        },
        full: {
          type: "boolean",
          description: "Restore all the way to original messages"
        }
      },
      required: ["blockId"]
    }
  }
};
var SEARCH_CONTEXT_TOOL_OPENAI = {
  type: "function",
  function: {
    name: SEARCH_CONTEXT_TOOL_NAME,
    description: "Search through compressed block summaries by keyword. Use BEFORE decompressing to find the right block.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 5)" }
      },
      required: ["query"]
    }
  }
};
var ACP_STATUS_TOOL_OPENAI = {
  type: "function",
  function: {
    name: ACP_STATUS_TOOL_NAME,
    description: "Show context usage and compressible ranges. No args = overview. Use to find what to compress next.",
    parameters: {
      type: "object",
      properties: {}
    }
  }
};
var DECOMPRESS_TOOL = {
  name: DECOMPRESS_TOOL_NAME,
  description: DECOMPRESS_TOOL_OPENAI.function.description,
  input_schema: DECOMPRESS_TOOL_OPENAI.function.parameters
};
var SEARCH_CONTEXT_TOOL = {
  name: SEARCH_CONTEXT_TOOL_NAME,
  description: SEARCH_CONTEXT_TOOL_OPENAI.function.description,
  input_schema: SEARCH_CONTEXT_TOOL_OPENAI.function.parameters
};
var ACP_STATUS_TOOL = {
  name: ACP_STATUS_TOOL_NAME,
  description: ACP_STATUS_TOOL_OPENAI.function.description,
  input_schema: ACP_STATUS_TOOL_OPENAI.function.parameters
};
var COMPRESS_TOOL_RESPONSES = {
  type: "function",
  name: COMPRESS_TOOL_NAME,
  description: COMPRESS_TOOL.description,
  parameters: COMPRESS_TOOL_OPENAI.function.parameters
};
var DECOMPRESS_TOOL_RESPONSES = {
  type: "function",
  name: DECOMPRESS_TOOL_OPENAI.function.name,
  description: DECOMPRESS_TOOL_OPENAI.function.description,
  parameters: DECOMPRESS_TOOL_OPENAI.function.parameters
};
var SEARCH_CONTEXT_TOOL_RESPONSES = {
  type: "function",
  name: SEARCH_CONTEXT_TOOL_OPENAI.function.name,
  description: SEARCH_CONTEXT_TOOL_OPENAI.function.description,
  parameters: SEARCH_CONTEXT_TOOL_OPENAI.function.parameters
};
var ACP_STATUS_TOOL_RESPONSES = {
  type: "function",
  name: ACP_STATUS_TOOL_OPENAI.function.name,
  description: ACP_STATUS_TOOL_OPENAI.function.description,
  parameters: ACP_STATUS_TOOL_OPENAI.function.parameters
};
var ACP_TOOL_NAMES = /* @__PURE__ */ new Set([
  COMPRESS_TOOL_NAME,
  DECOMPRESS_TOOL_NAME,
  SEARCH_CONTEXT_TOOL_NAME,
  ACP_STATUS_TOOL_NAME
]);
var ALWAYS_PROTECTED_TOOLS = ["compress"];
var NEVER_PRESERVE_RECENT_TOOLS = [
  "decompress",
  "search_context",
  "read",
  "bash"
];
function isNeverPreserveRecent(msg) {
  if (msg.contentType !== "tool-call" && msg.contentType !== "tool-result") {
    return false;
  }
  if (!msg.toolName) return false;
  return NEVER_PRESERVE_RECENT_TOOLS.includes(msg.toolName);
}
function matchToolPattern(toolName, pattern) {
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
}
function isMessageProtected(msg, config) {
  if (msg.contentType !== "tool-call" && msg.contentType !== "tool-result" || !msg.toolName) {
    return false;
  }
  if (ALWAYS_PROTECTED_TOOLS.includes(msg.toolName)) {
    return true;
  }
  for (const pattern of config.protectedTools) {
    if (matchToolPattern(msg.toolName, pattern)) return true;
  }
  if (config.isToolProtected?.(msg.toolName, msg.text)) return true;
  return false;
}
function collectProtectedToolCallIds(messages, config) {
  const ids = /* @__PURE__ */ new Set();
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId && isMessageProtected(m, config)) {
      ids.add(m.toolCallId);
    }
  }
  return ids;
}
function isMessageProtectedWithPairing(msg, config, protectedCallIds) {
  if (isMessageProtected(msg, config)) return true;
  if (msg.contentType === "tool-result" && msg.toolCallId && protectedCallIds.has(msg.toolCallId)) {
    return true;
  }
  return false;
}
var ABSORB_PROMPT_MARKER = "[ACP absorb]";
var DEFAULT_ABSORB_CONFIG = {
  enabled: false,
  toolName: ABSORB_TOOL_NAME,
  minToolTokens: 1e3,
  contextThresholdPct: 0,
  excludeTools: []
};
function resolveAbsorbConfig(config) {
  return { ...DEFAULT_ABSORB_CONFIG, ...config.absorb ?? {} };
}
function formatTokenCount(tokens) {
  if (tokens < 1e3) return String(tokens);
  if (tokens < 1e4) return (tokens / 1e3).toFixed(1) + "K";
  return Math.round(tokens / 1e3) + "K";
}
function buildAbsorbPrompt(ref, tokens, toolName = ABSORB_TOOL_NAME) {
  return `${ABSORB_PROMPT_MARKER} This tool result (~${formatTokenCount(tokens)} tokens) will be REMOVED from context. Your IMMEDIATE next action: call ${toolName}({ ref: "${ref}", summary: "..." }) \u2014 summary = distilled essentials only (outcome, key values, exact paths:lines, error text verbatim, decisions). Afterwards work from your summary; do NOT re-run this tool. If the result contains nothing you need, call ${toolName} with summary "(nothing needed)".`;
}
function isAcpOrConfiguredTool(toolName, cfg) {
  if (!toolName) return false;
  if (toolName === cfg.toolName) return true;
  return ACP_TOOL_NAMES.has(toolName);
}
function isAbsorbCandidate(msg, config) {
  if (msg.contentType !== "tool-result" || !msg.toolCallId) return false;
  const cfg = resolveAbsorbConfig(config);
  if (isAcpOrConfiguredTool(msg.toolName, cfg)) return false;
  if (isMessageProtected(msg, config)) return false;
  for (const pattern of cfg.excludeTools) {
    if (msg.toolName && matchToolPattern(msg.toolName, pattern)) return false;
  }
  return true;
}
function hideAbsorbedMessages(messages, state) {
  const records = state.absorbed ?? [];
  if (records.length === 0) return messages;
  const hidden = /* @__PURE__ */ new Set();
  for (const record of records) {
    if (record.callMessageId) hidden.add(record.callMessageId);
    if (record.resultMessageId) hidden.add(record.resultMessageId);
  }
  return messages.filter((msg) => !hidden.has(msg.id));
}
function appendAbsorbPrompts(messages, state, config, tokenCount, countTokens) {
  const cfg = resolveAbsorbConfig(config);
  if (!cfg.enabled) return { messages, promptedCount: 0 };
  const limit = config.modelContextLimit;
  if (cfg.contextThresholdPct > 0 && limit > 0 && tokenCount < cfg.contextThresholdPct * limit) {
    return { messages, promptedCount: 0 };
  }
  const absorbedIds = /* @__PURE__ */ new Set();
  for (const record of state.absorbed ?? []) {
    if (record.resultMessageId) absorbedIds.add(record.resultMessageId);
  }
  let promptedCount = 0;
  const out = messages.map((msg) => {
    if (!isAbsorbCandidate(msg, config)) return msg;
    if (absorbedIds.has(msg.id)) return msg;
    const text = msg.text ?? "";
    if (text.includes(ABSORB_PROMPT_MARKER)) return msg;
    const tokens = countTokens(text);
    if (tokens < cfg.minToolTokens) return msg;
    const ref = refForRaw(state.messageRefs, msg.id);
    if (!ref || ref === BLOCKED_REF) return msg;
    promptedCount++;
    return {
      ...msg,
      text: text + "\n\n" + buildAbsorbPrompt(ref, tokens, cfg.toolName)
    };
  });
  return { messages: out, promptedCount };
}
function applyAbsorb(input) {
  const countTokens = input.countTokens ?? ((text) => Math.ceil(text.length / 4));
  const summary = input.summary?.trim() ?? "";
  if (!summary) {
    return {
      state: input.state,
      ok: false,
      resultText: "absorb failed: summary is empty \u2014 provide the distilled key info of the tool result."
    };
  }
  const cfg = resolveAbsorbConfig(input.config);
  const rawId = rawForRef(input.state.messageRefs, input.ref.trim());
  if (!rawId) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ref ${input.ref} does not exist in this session (it may be hidden, already compressed, or stale).`
    };
  }
  const existing = (input.state.absorbed ?? []).find(
    (record2) => record2.resultMessageId === rawId
  );
  if (existing) {
    return {
      state: input.state,
      ok: true,
      resultText: `already absorbed (${input.ref}) \u2014 no change.`
    };
  }
  const target = input.messages.find((m) => m.id === rawId);
  if (!target) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ref ${input.ref} is not visible in this session (hidden or compressed).`
    };
  }
  if (target.contentType !== "tool-result") {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ref ${input.ref} is a ${target.contentType}, not a tool result.`
    };
  }
  if (isAcpOrConfiguredTool(target.toolName, cfg)) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ${target.toolName} is an ACP-managed tool result \u2014 it is not absorbable.`
    };
  }
  if (isMessageProtected(target, input.config)) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ${target.toolName} is a protected tool \u2014 its results must stay visible.`
    };
  }
  if (!target.toolCallId) {
    return {
      state: input.state,
      ok: false,
      resultText: `absorb failed: ref ${input.ref} has no tool-call id \u2014 cannot pair it for hiding.`
    };
  }
  const call = input.messages.find(
    (m) => m.contentType === "tool-call" && m.toolCallId === target.toolCallId
  );
  const tokens = countTokens(target.text ?? "");
  const summaryTokens = countTokens(summary);
  const record = {
    toolCallId: target.toolCallId,
    callMessageId: call?.id ?? "",
    resultMessageId: target.id,
    ...input.absorbCallId ? { absorbCallId: input.absorbCallId } : {},
    summary,
    tokensReclaimed: tokens,
    createdAt: Date.now()
  };
  const state = {
    ...input.state,
    absorbed: [...input.state.absorbed ?? [], record],
    stats: {
      ...input.state.stats,
      absorbedTokens: (input.state.stats.absorbedTokens ?? 0) + tokens
    }
  };
  const bloat = summaryTokens >= tokens && tokens > 0 ? ` WARNING: your summary (~${formatTokenCount(summaryTokens)} tokens) is not smaller than the original (~${formatTokenCount(tokens)} tokens) \u2014 distill harder next time.` : "";
  return {
    state,
    ok: true,
    resultText: `absorbed ${input.ref} (~${formatTokenCount(tokens)} tokens \u2192 summary ~${formatTokenCount(summaryTokens)}). The original tool output is now hidden; your summary is the durable record.${bloat}`
  };
}
var registry = /* @__PURE__ */ new Map();
function listMessageFilters() {
  return [...registry.values()];
}
function applyMessageFilters(messages, config) {
  if (!config?.enabled) {
    return { messages, partsFiltered: 0, partsDropped: 0, partsModified: 0 };
  }
  const active = listMessageFilters().filter(
    (filter) => config.filters?.[filter.name]?.enabled !== false
  );
  if (active.length === 0) {
    return { messages, partsFiltered: 0, partsDropped: 0, partsModified: 0 };
  }
  let working = messages.map((message) => ({ ...message }));
  const tally = { partsFiltered: 0, partsDropped: 0, partsModified: 0 };
  const total = working.length;
  const immediate = active.filter((filter) => !filter.keepLastOnly);
  for (let index = 0; index < working.length; index++) {
    const message = working[index];
    const text = message.text ?? "";
    if (text.length === 0) continue;
    let current = text;
    const baseCtx = {
      text: current,
      role: message.role,
      messageIndex: index,
      totalMessages: total,
      toolName: message.toolName
    };
    for (const filter of immediate) {
      let decision;
      try {
        decision = filter.filter(baseCtx);
      } catch {
        continue;
      }
      if (decision.action === "keep") continue;
      tally.partsFiltered++;
      if (decision.action === "drop") {
        current = "";
        tally.partsDropped++;
      } else if (decision.action === "modify" && decision.text !== void 0) {
        current = decision.text;
        tally.partsModified++;
      }
      baseCtx.text = current;
    }
    if (current !== text) working[index] = { ...message, text: current };
  }
  const keepLast = active.filter((filter) => filter.keepLastOnly);
  for (const filter of keepLast) {
    let foundLast = false;
    for (let index = working.length - 1; index >= 0; index--) {
      const message = working[index];
      const text = message.text ?? "";
      if (text.length === 0) continue;
      const ctx = {
        text,
        role: message.role,
        messageIndex: index,
        totalMessages: total,
        toolName: message.toolName
      };
      let decision;
      try {
        decision = filter.filter(ctx);
      } catch {
        continue;
      }
      if (decision.action !== "drop" && decision.action !== "modify") continue;
      if (foundLast) {
        tally.partsFiltered++;
        tally.partsDropped++;
        working[index] = { ...message, text: "" };
      } else {
        foundLast = true;
        if (decision.action === "modify" && decision.text !== void 0) {
          tally.partsFiltered++;
          tally.partsModified++;
          working[index] = { ...message, text: decision.text };
        }
      }
    }
  }
  return { messages: working, ...tally };
}
function formatTokens(tokens) {
  if (tokens < 1e3) return String(tokens);
  if (tokens < 1e4) return (tokens / 1e3).toFixed(1) + "K";
  return Math.round(tokens / 1e3) + "K";
}
function classifyType(message) {
  if (message.contentType === "tool-call" || message.contentType === "tool-result") {
    return message.toolName || "tool";
  }
  return message.contentType;
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var LT = "<";
var GT = ">";
var TAG_OPEN = LT + "acp ";
var TAG_CLOSE = LT + "/acp" + GT;
function acpTag(ref, tokens, type) {
  return TAG_OPEN + 'tokens="' + formatTokens(tokens) + '" type="' + type + '"' + GT + ref + TAG_CLOSE;
}
function renderMessage(message, map, countTokens, strategy, snapshot = null) {
  const ref = refForRaw(map, message.id);
  if (!ref || ref === BLOCKED_REF) return message;
  if (strategy === "none") return message;
  if (strategy === "text-only" && message.contentType !== "text") {
    return message;
  }
  const ownTagRe = new RegExp(
    "^" + escapeRegex(TAG_OPEN) + "[^>]*" + GT + escapeRegex(ref) + escapeRegex(TAG_CLOSE) + "\\n?"
  );
  const cleanText = (message.text || "").replace(ownTagRe, "");
  const tokens = snapshot ? snapshot[ref] ?? (snapshot[ref] = countTokens(cleanText)) : countTokens(cleanText);
  const type = classifyType(message);
  const prefix = acpTag(ref, tokens, type) + "\n";
  if (!cleanText) return { ...message, text: prefix };
  return { ...message, text: prefix + cleanText };
}
function renderWithSnapshot(messages, state, countTokens = (text) => Math.ceil(text.length / 4), strategy = "all") {
  const map = state.messageRefs;
  const snapshot = { ...state.tokenSnapshot ?? {} };
  const rendered = messages.map(
    (message) => renderMessage(message, map, countTokens, strategy, snapshot)
  );
  return { messages: rendered, tokenSnapshot: snapshot };
}
function createRenderRefsNode(strategy) {
  return {
    name: "render-refs",
    run(io, ctx) {
      const { messages, tokenSnapshot } = renderWithSnapshot(
        io.messages,
        io.state,
        ctx.countTokens,
        strategy
      );
      const prev = io.state.tokenSnapshot;
      const changed = !prev || Object.keys(tokenSnapshot).length !== Object.keys(prev).length;
      return changed ? { ...io, messages, state: { ...io.state, tokenSnapshot } } : { ...io, messages };
    }
  };
}
var renderRefsNode = createRenderRefsNode("all");
function adjustBoundariesForToolPairs(startIndex, endIndex, messages, maxScan = 20) {
  const callIdsInRange = /* @__PURE__ */ new Set();
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (!msg || !msg.toolCallId) continue;
    if (msg.toolName === "compress") continue;
    callIdsInRange.add(msg.toolCallId);
  }
  if (callIdsInRange.size === 0) {
    return { startIndex, endIndex };
  }
  let newEndIndex = endIndex;
  for (let i = endIndex + 1; i < messages.length && i <= endIndex + maxScan; i++) {
    const msg = messages[i];
    if (!msg) break;
    if (msg.toolCallId && callIdsInRange.has(msg.toolCallId)) {
      newEndIndex = i;
    } else if (newEndIndex > endIndex) {
      break;
    }
  }
  let newStartIndex = startIndex;
  for (let i = startIndex - 1; i >= 0 && i >= startIndex - maxScan; i--) {
    const msg = messages[i];
    if (!msg) break;
    if (msg.toolCallId && callIdsInRange.has(msg.toolCallId)) {
      newStartIndex = i;
    } else if (newStartIndex < startIndex) {
      break;
    }
  }
  return { startIndex: newStartIndex, endIndex: newEndIndex };
}
function adjustBoundariesForReasoningPairs(startIndex, endIndex, messages) {
  if (startIndex > endIndex) {
    return { startIndex, endIndex };
  }
  let newStartIndex = startIndex;
  let newEndIndex = endIndex;
  for (let i = startIndex; i <= endIndex && i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.contentType === "reasoning") {
      let j = i;
      while (j + 1 < messages.length && messages[j + 1].contentType === "reasoning") {
        j++;
      }
      const companion = messages[j + 1];
      if (companion !== void 0 && companion.role === "assistant" && (companion.contentType === "text" || companion.contentType === "tool-call") && j + 1 > newEndIndex) {
        newEndIndex = j + 1;
      }
    }
    if (msg.role === "assistant" && (msg.contentType === "text" || msg.contentType === "tool-call")) {
      let k = i - 1;
      while (k >= 0 && messages[k].contentType === "reasoning") {
        k--;
      }
      const runStart = k + 1;
      if (runStart < i && runStart >= 0 && messages[runStart].contentType === "reasoning" && runStart < newStartIndex) {
        newStartIndex = runStart;
      }
    }
  }
  return { startIndex: newStartIndex, endIndex: newEndIndex };
}
function refNum(ref) {
  const n = parseInt(ref.slice(1), 10);
  return Number.isNaN(n) ? -1 : n;
}
function estimateTextTokens(text) {
  return Math.ceil(text.length / 4);
}
function isToolMessage(message) {
  return message.contentType === "tool-call" || message.contentType === "tool-result";
}
function isSyntheticOrPruned(message, state) {
  if (message.text?.startsWith("[Compressed conversation section]")) return true;
  for (const block of state.blocks) {
    if (block.active && block.effectiveMessageIds.includes(message.id)) return true;
  }
  return false;
}
function computeProtectedRefs(messages, state, config, countTokens = estimateTextTokens) {
  const preserveN = config.preserveRecentMessages;
  const preserveTokens = config.preserveRecentTokens;
  const result = /* @__PURE__ */ new Set();
  const visible = [];
  for (const msg of messages) {
    if (isSyntheticOrPruned(msg, state)) continue;
    if (isNeverPreserveRecent(msg)) continue;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    visible.push({ ref, tokens: countTokens(msg.text ?? "") });
  }
  if (preserveN > 0) {
    for (const m of visible.slice(-preserveN)) {
      result.add(m.ref);
    }
  }
  if (preserveTokens > 0) {
    let tokenAccum = 0;
    for (let i = visible.length - 1; i >= 0 && tokenAccum < preserveTokens; i--) {
      result.add(visible[i].ref);
      tokenAccum += visible[i].tokens;
    }
  }
  if (preserveN > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "user" || isSyntheticOrPruned(msg, state)) continue;
      const ref = state.messageRefs.byRaw[msg.id];
      if (ref && ref !== "BLOCKED") result.add(ref);
      break;
    }
  }
  return result;
}
function buildCompressibleRanges(messages, state, config, protectedZoneRefs, countTokens = estimateTextTokens) {
  const compressibleMsgs = [];
  const protectedMsgs = [];
  const protectedCallIds = collectProtectedToolCallIds(messages, config);
  for (const msg of messages) {
    if (isSyntheticOrPruned(msg, state)) continue;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    const rn = refNum(ref);
    if (isMessageProtectedWithPairing(msg, config, protectedCallIds)) {
      protectedMsgs.push({
        ref,
        refNum: rn,
        tokens: countTokens(msg.text ?? ""),
        tools: msg.toolName ? [msg.toolName] : []
      });
      continue;
    }
    if (protectedZoneRefs?.has(ref)) {
      continue;
    }
    compressibleMsgs.push({
      ref,
      refNum: rn,
      tokens: countTokens(msg.text ?? ""),
      chars: (msg.text ?? "").length,
      isTool: isToolMessage(msg),
      isUser: msg.role === "user"
    });
  }
  const compressible = [];
  let cur = null;
  let prevRefNum = -2;
  for (const info of compressibleMsgs) {
    const hasGap = info.refNum > prevRefNum + 1;
    if (cur && (info.isUser && cur.count >= 3 || hasGap)) {
      compressible.push(cur);
      cur = null;
    }
    prevRefNum = info.refNum;
    if (!cur) {
      cur = {
        startRef: info.ref,
        endRef: info.ref,
        count: 1,
        tokens: info.tokens,
        chars: info.chars,
        toolPct: info.isTool ? 100 : 0,
        textPct: info.isTool ? 0 : 100
      };
    } else {
      cur.endRef = info.ref;
      cur.count++;
      cur.tokens += info.tokens;
      cur.chars = (cur.chars ?? 0) + info.chars;
      if (info.isTool) {
        cur.toolPct = Math.round((cur.toolPct * (cur.count - 1) + 100) / cur.count);
      } else {
        cur.toolPct = Math.round(cur.toolPct * (cur.count - 1) / cur.count);
      }
      cur.textPct = 100 - cur.toolPct;
    }
  }
  if (cur) compressible.push(cur);
  const protectedRanges = [];
  let pcur = null;
  let pPrevRefNum = -2;
  for (const info of protectedMsgs) {
    const hasGap = info.refNum > pPrevRefNum + 1;
    if (pcur && hasGap) {
      protectedRanges.push(pcur);
      pcur = null;
    }
    pPrevRefNum = info.refNum;
    if (!pcur) {
      pcur = {
        startRef: info.ref,
        endRef: info.ref,
        count: 1,
        tokens: info.tokens,
        tools: [...info.tools]
      };
    } else {
      pcur.endRef = info.ref;
      pcur.count++;
      pcur.tokens += info.tokens;
      for (const t of info.tools) {
        if (!pcur.tools.includes(t)) pcur.tools.push(t);
      }
    }
  }
  if (pcur) protectedRanges.push(pcur);
  return {
    compressible: compressible.filter((g) => g.tokens > 0),
    protected: protectedRanges
  };
}
function mergeBatch(batch) {
  const first = batch[0];
  const last = batch[batch.length - 1];
  const count = batch.reduce((s, r) => s + r.count, 0);
  const tokens = batch.reduce((s, r) => s + r.tokens, 0);
  const chars = batch.reduce((s, r) => s + rangeChars(r), 0);
  const toolPct = Math.round(
    batch.reduce((s, r) => s + r.toolPct * r.count, 0) / count
  );
  const merged = {
    startRef: first.startRef,
    endRef: last.endRef,
    count,
    tokens,
    chars,
    toolPct,
    textPct: 100 - toolPct
  };
  if (batch.some((r) => r.dangerous === true)) {
    merged.dangerous = true;
  }
  return merged;
}
function rangeChars(r) {
  return r.chars ?? r.tokens * 4;
}
function mergeRangesToThreshold(ranges, minChars) {
  if (minChars <= 0 || ranges.length === 0) return ranges;
  const result = [];
  let batch = [];
  let batchChars = 0;
  for (const r of ranges) {
    batch.push(r);
    batchChars += rangeChars(r);
    if (batchChars >= minChars) {
      result.push(mergeBatch(batch));
      batch = [];
      batchChars = 0;
    }
  }
  if (batch.length > 0) {
    result.push(mergeBatch(batch));
  }
  return result;
}
function runPipeline(nodes, initial, ctx) {
  let io = initial;
  for (const node of nodes) {
    if (node.enabled && !node.enabled(io, ctx)) continue;
    io = node.run(io, ctx);
  }
  return io;
}
function rangeError(spec, message) {
  return `range ${spec.startRef}..${spec.endRef}: ${message}`;
}
function numericBlockId(id) {
  const parsed = /^b(\d+)$/.exec(id);
  return parsed ? Number(parsed[1]) : 0;
}
function refGateDiagnostics(state, requestedRanges, unknownCount) {
  const highest = highestUsedIndex(state.messageRefs);
  const highestRef = highest > 0 ? indexToRef(highest) : "none";
  return `[diagnostics: session highest ref=${highestRef}, unknown ranges in request=${unknownCount}/${requestedRanges}, session history=${state.stats.compressionCount} compression(s), ${state.blocks.length} block(s)]`;
}
function danglingMessageRefs(state, messages, spec) {
  const visible = new Set(messages.map((m) => m.id));
  const dangling = [];
  for (const ref of [spec.startRef, spec.endRef]) {
    const parsed = parseBoundary(ref);
    if (!parsed || parsed.kind !== "message") continue;
    const rawId = state.messageRefs.byRef[parsed.raw] ?? state.messageRefs.byRef[indexToRef(parsed.numericId)];
    if (!rawId || visible.has(rawId)) continue;
    const covered = state.blocks.some(
      (block) => block.active && block.effectiveMessageIds.includes(rawId)
    );
    if (!covered) dangling.push(parsed.raw);
  }
  return dangling;
}
function createCore(ports = {}) {
  const countTokens = ports.countTokens ?? defaultCountTokens;
  function applyCompression(input) {
    const state = cloneState(input.state);
    const runId = allocateRunId(state);
    let blocksCreated = 0;
    let tokensCompressed = 0;
    const errors = [];
    const warnings = [];
    const protectedMessageIds = input.protectedMessageIds ?? computeProtectedRefs(
      input.messages,
      input.state,
      input.config,
      countTokens
    );
    const preExistingCoverage = collectCoverage(state);
    const classifications = /* @__PURE__ */ new Map();
    const classificationErrors = [];
    const consumedRanges = [];
    for (const spec of input.ranges) {
      try {
        const resolved = resolveBoundaries({
          startRef: spec.startRef,
          endRef: spec.endRef,
          messages: input.messages,
          state
        });
        classifications.set(spec, { status: "ok", resolved });
      } catch (error) {
        if (error instanceof BoundaryNotFoundError) {
          classifications.set(
            spec,
            error.kind === "unknown" ? { status: "unknown", error } : { status: "consumed", error }
          );
          if (error.kind === "consumed") {
            consumedRanges.push(spec);
          } else {
            classificationErrors.push(rangeError(spec, error.message));
          }
        } else {
          classifications.set(spec, {
            status: "invalid",
            error: error instanceof Error ? error : new Error(String(error))
          });
          classificationErrors.push(
            rangeError(
              spec,
              error instanceof Error ? error.message : String(error)
            )
          );
        }
      }
    }
    let resolvableCount = 0;
    let unknownCount = 0;
    for (const resolution of classifications.values()) {
      if (resolution.status === "ok") resolvableCount++;
      else if (resolution.status === "unknown") unknownCount++;
    }
    const rangeSpans = [];
    for (const [spec, resolution] of classifications) {
      if (resolution.status !== "ok") continue;
      rangeSpans.push({
        spec,
        start: resolution.resolved.startIndex,
        end: resolution.resolved.endIndex
      });
    }
    const sortedRanges = [...rangeSpans].sort((a, b) => a.start - b.start);
    const skipSpecs = /* @__PURE__ */ new Set();
    let acceptedMaxIndex = -1;
    for (const entry of sortedRanges) {
      if (entry.start <= acceptedMaxIndex) {
        skipSpecs.add(entry.spec);
        warnings.push(
          `Skipped range (${entry.spec.startRef}..${entry.spec.endRef}) \u2014 overlaps an earlier range in the batch; the earlier range takes precedence. Keep ranges disjoint.`
        );
        continue;
      }
      if (entry.end > acceptedMaxIndex) acceptedMaxIndex = entry.end;
    }
    if (input.config.compress.minCompressRange > 0 && input.ranges.length > 0) {
      let totalRangeChars = 0;
      let hasBlockBoundaryRange = false;
      let countedRanges = 0;
      for (const [spec, resolution] of classifications) {
        if (resolution.status !== "ok" || skipSpecs.has(spec)) continue;
        if (resolution.resolved.boundaryKind === "block") {
          hasBlockBoundaryRange = true;
          continue;
        }
        countedRanges++;
        for (const id of resolution.resolved.messageIds) {
          const msg = input.messages.find((m) => m.id === id);
          totalRangeChars += msg?.text?.length ?? 0;
        }
      }
      if (!hasBlockBoundaryRange && totalRangeChars < input.config.compress.minCompressRange) {
        const live = activeBlocks(state).map((b) => b.blockId).sort((x, y) => numericBlockId(x) - numericBlockId(y));
        const liveHint = live.length > 0 ? ` Current active blocks span ${live[0]}..${live[live.length - 1]} \u2014 retry with startId/endId set to active block IDs in that span.` : "";
        const diagnostics = refGateDiagnostics(
          state,
          input.ranges.length,
          unknownCount
        );
        const danglingRefs = consumedRanges.flatMap(
          (spec) => danglingMessageRefs(state, input.messages, spec)
        );
        const gateMessage = resolvableCount === 0 && consumedRanges.length === 0 && unknownCount > 0 ? `None of the ${input.ranges.length} requested range(s) resolved \u2014 every ref is unknown to this session. Refs are per-session snapshots, assigned once when a message is first rendered; no compress reassigns them, so unknown refs cannot come from an earlier compress in this session. They come from a different generation: a previous session instance (switching model or upstream mid-conversation starts a fresh session whose refs restart at m00001), the generation before a native-compaction rebase (which also resets refs to m00001), or a typo. ${diagnostics} Run acp_status, then call the compress tool again using only the refs it reports.` : consumedRanges.length > 0 ? danglingRefs.length > 0 ? `Requested range(s) cannot be anchored (e.g. ${consumedRanges[0].startRef}..${consumedRanges[0].endRef}) \u2014 the refs exist in this session's ref map, but the messages they point to are no longer in the visible context and no active block covers them: the message content changed (or the message was filtered out of the view) and now carries a new ref, leaving your old refs dangling. ${diagnostics} Run acp_status, then call the compress tool again using only the refs it reports.` : `Requested range(s) already compressed (e.g. ${consumedRanges[0].startRef}..${consumedRanges[0].endRef}) \u2014 those refs no longer point to directly compressible content: the range is covered by active block(s) or the block ref(s) are stale (distilled or consumed). ${diagnostics} Run acp_status, then call the compress tool again using only the CURRENT compressible ranges it reports.${liveHint}` : `Total compressible content too small (${totalRangeChars} chars across ${countedRanges} range(s), min ${input.config.compress.minCompressRange}). Combine more messages into your range(s) to meet the threshold.`;
        return {
          state: input.state,
          result: {
            blocksCreated: 0,
            tokensCompressed: 0,
            errors: [gateMessage, ...classificationErrors],
            warnings: []
          }
        };
      }
    }
    for (const spec of input.ranges) {
      if (skipSpecs.has(spec)) continue;
      const resolution = classifications.get(spec);
      if (resolution === void 0) continue;
      if (resolution.status === "consumed") {
        warnings.push(
          `Skipped range (${spec.startRef}..${spec.endRef}) \u2014 already compressed (messages consumed by existing block(s)); nothing to compress.`
        );
        continue;
      }
      if (resolution.status === "unknown" || resolution.status === "invalid") {
        errors.push(rangeError(spec, resolution.error.message));
        continue;
      }
      warnings.push(...resolution.resolved.snappedBoundaries);
      try {
        const outcome = applySingleRange({
          spec,
          messages: input.messages,
          state,
          runId,
          config: input.config,
          protectedMessageIds,
          countTokens,
          preExistingCoverage
        });
        blocksCreated++;
        tokensCompressed += outcome.tokens;
        warnings.push(...outcome.warnings);
      } catch (error) {
        errors.push(
          rangeError(
            spec,
            error instanceof Error ? error.message : String(error)
          )
        );
      }
    }
    state.stats.compressionCount += blocksCreated;
    state.stats.tokensCompressed += tokensCompressed;
    if (blocksCreated > 0) {
      state.nudge.lastPerMessageNudgeTokens = 0;
      state.nudge.lastNudgeShownTokens = 0;
      state.nudge.lastShownByTier = {};
    }
    return {
      state,
      result: { blocksCreated, tokensCompressed, errors, warnings }
    };
  }
  function processTurn(input) {
    const configErrors = validateConfig(input.config);
    if (configErrors.length > 0) {
      console.warn(
        `[acp-kernel] Config validation warnings: ${configErrors.join("; ")}. Thresholds may not fire correctly.`
      );
    }
    const ctx = {
      config: input.config,
      tokenCount: input.tokenCount,
      countTokens
    };
    const initial = {
      messages: input.messages,
      state: input.state,
      effects: {}
    };
    const strategy = input.renderTags ?? "all";
    const nodes = buildNodes(strategy);
    const result = runPipeline(nodes, initial, ctx);
    return {
      messages: result.messages,
      state: result.state,
      nudge: result.effects.nudge
    };
  }
  function decompress2(blockId, state) {
    return blockById(state, blockId);
  }
  function search(query, state) {
    const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
    if (terms.length === 0) return [];
    const scored = activeBlocks(state).map((block) => ({ block, score: scoreRelevance(block, terms) })).filter((entry) => entry.score > 0.1).sort((left, right) => right.score - left.score);
    return scored.map((entry) => entry.block);
  }
  function status(state, tokenCount, config) {
    const active = activeBlocks(state);
    const usage = config.modelContextLimit > 0 ? tokenCount / config.modelContextLimit : 0;
    return {
      contextUsage: usage,
      tokenCount,
      modelContextLimit: config.modelContextLimit,
      activeBlocks: active.length,
      totalBlocks: state.blocks.length,
      tokensCompressed: state.stats.tokensCompressed,
      breakdown: { active: active.length, total: state.blocks.length }
    };
  }
  function defaultNodes() {
    return buildNodes("all");
  }
  function buildNodes(strategy) {
    const base = [
      assignRefsNode,
      syncBlocksNode,
      pruneNode,
      absorbHideNode,
      absorbPromptNode,
      filterNode,
      hideCompressCallsNode,
      recommendNode,
      nudgeNode,
      emergencyTruncateNode
    ];
    if (strategy === "none") return base;
    return [...base, createRenderRefsNode(strategy)];
  }
  return {
    processTurn,
    applyCompression,
    defaultNodes,
    decompress: decompress2,
    search,
    status
  };
}
var assignRefsNode = {
  name: "assign-refs",
  run(io, ctx) {
    const hasProtection = ctx.config.protectedTools.length > 0 || !!ctx.config.isToolProtected;
    const protectedFn = hasProtection ? (m) => isMessageProtected(m, ctx.config) : void 0;
    const refResult = assignRefs(io.messages, {
      existing: io.state.messageRefs,
      nextIndex: highestUsedIndex(io.state.messageRefs) + 1,
      isProtected: protectedFn
    });
    return { ...io, state: { ...io.state, messageRefs: refResult.map } };
  }
};
var syncBlocksNode = {
  name: "sync-blocks",
  run(io, ctx) {
    const synced = syncBlocks(io.messages, io.state);
    advanceSurvival(synced.state, ctx.config.promotionThreshold);
    return { ...io, state: synced.state };
  }
};
var pruneNode = {
  name: "prune",
  run(io) {
    return { ...io, messages: prune(io.messages, io.state) };
  }
};
var absorbHideNode = {
  name: "absorb-hide",
  enabled: (io) => (io.state.absorbed?.length ?? 0) > 0,
  run(io) {
    return { ...io, messages: hideAbsorbedMessages(io.messages, io.state) };
  }
};
var absorbPromptNode = {
  name: "absorb-prompt",
  enabled: (_io, ctx) => ctx.config.absorb?.enabled === true,
  run(io, ctx) {
    const applied = appendAbsorbPrompts(
      io.messages,
      io.state,
      ctx.config,
      ctx.tokenCount,
      ctx.countTokens
    );
    return {
      ...io,
      messages: applied.messages,
      effects: { ...io.effects, absorbPromptedCount: applied.promptedCount }
    };
  }
};
var filterNode = {
  name: "filter",
  enabled: (_io, ctx) => !!ctx.config.messageFilters?.enabled && listMessageFilters().length > 0,
  run(io, ctx) {
    const applied = applyMessageFilters(io.messages, ctx.config.messageFilters);
    return { ...io, messages: applied.messages };
  }
};
var hideCompressCallsNode = {
  name: "hide-compress-calls",
  run(io) {
    const hidden = hideConsumedCompressCalls(io.state, io.messages);
    return { ...io, messages: hidden.messages };
  }
};
var recommendNode = {
  name: "recommend",
  run(io, ctx) {
    const protectedRefs = computeProtectedRefs(
      io.messages,
      io.state,
      ctx.config,
      ctx.countTokens
    );
    const contextRanges = buildCompressibleRanges(
      io.messages,
      io.state,
      ctx.config,
      protectedRefs,
      ctx.countTokens
    );
    const nothingToCompress = contextRanges.compressible.length === 0;
    const recommendation = {
      contextRanges,
      recommendedRanges: mergeRangesToThreshold(
        contextRanges.compressible,
        ctx.config.compress.minCompressRange
      ),
      nothingToCompress
    };
    return { ...io, effects: { ...io.effects, recommendation } };
  }
};
var nudgeNode = {
  name: "nudge-inject",
  run(io, ctx) {
    const nudge = decideNudge({
      tokenCount: ctx.tokenCount,
      config: ctx.config,
      state: io.state,
      messages: io.messages,
      recommendation: io.effects.recommendation,
      countTokens: ctx.countTokens
    });
    const baseline = io.state.nudge.lastPerMessageNudgeTokens;
    const nudgeGrowthTokens = resolveAdaptiveGrowth(
      ctx.config.modelContextLimit,
      ctx.config.nudge
    );
    let stamped = { ...io.state.nudge };
    if (baseline > 0 && ctx.tokenCount < baseline - nudgeGrowthTokens) {
      stamped.lastPerMessageNudgeTokens = ctx.tokenCount;
      stamped.lastNudgeShownTokens = 0;
      stamped.lastShownByTier = {};
    }
    if (stamped.lastPerMessageNudgeTokens === 0) {
      stamped.lastPerMessageNudgeTokens = ctx.tokenCount;
    }
    if (nudge.shouldInject) {
      stamped.lastNudgeShownTokens = ctx.tokenCount;
      if (nudge.tier !== null) {
        stamped.lastShownByTier = {
          ...stamped.lastShownByTier,
          [nudge.tier]: ctx.tokenCount
        };
      }
    }
    return {
      ...io,
      state: { ...io.state, nudge: stamped },
      effects: { ...io.effects, nudge }
    };
  }
};
var emergencyTruncateNode = {
  name: "emergency-truncate",
  run(io, ctx) {
    const usage = ctx.config.modelContextLimit > 0 ? ctx.tokenCount / ctx.config.modelContextLimit : 0;
    if (usage < ctx.config.truncate.threshold) return io;
    const trunc = truncateLargeToolOutputs(
      io.messages,
      ctx.tokenCount,
      ctx.config,
      ctx.countTokens,
      { protectRecentMessages: ctx.config.preserveRecentMessages }
    );
    return {
      ...io,
      messages: trunc.messages,
      effects: { ...io.effects, truncatedCount: trunc.truncatedCount }
    };
  }
};
function applySingleRange(input) {
  const warnings = [];
  const resolved = resolveBoundaries({
    startRef: input.spec.startRef,
    endRef: input.spec.endRef,
    messages: input.messages,
    state: input.state
  });
  const rangeMessageIds = applyPairBoundaryAdjustments(
    resolved,
    input.messages
  ).filter((id) => !isSummaryMessageId(id));
  if (rangeMessageIds.length > resolved.messageIds.length) {
    const indexByMessageId = /* @__PURE__ */ new Map();
    input.messages.forEach((m, i) => indexByMessageId.set(m.id, i));
    const adjustedStart = rangeMessageIds.length > 0 ? indexByMessageId.get(rangeMessageIds[0]) ?? resolved.startIndex : resolved.startIndex;
    const adjustedEnd = rangeMessageIds.length > 0 ? indexByMessageId.get(rangeMessageIds[rangeMessageIds.length - 1]) ?? resolved.endIndex : resolved.endIndex;
    const nestedSeen = new Set(resolved.nestedBlockIds);
    for (const block2 of activeBlocks(input.state)) {
      if (nestedSeen.has(block2.blockId)) continue;
      if (blockVisibleInRange(block2, indexByMessageId, adjustedStart, adjustedEnd)) {
        nestedSeen.add(block2.blockId);
        resolved.nestedBlockIds.push(block2.blockId);
      }
    }
  }
  const isBlockBoundary = resolved.boundaryKind === "block";
  const targetTier = resolveTargetTier(
    input.state,
    resolved.nestedBlockIds,
    isBlockBoundary
  );
  const outputTier = isBlockBoundary ? Math.min(3, targetTier + 1) : 1;
  const consumedBlockIds = resolved.nestedBlockIds.filter((id) => {
    const block2 = blockById(input.state, id);
    return block2?.active && block2.tier === targetTier;
  });
  const effectiveMessageIds = new Set(rangeMessageIds);
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) {
      for (const id of consumed.effectiveMessageIds)
        effectiveMessageIds.add(id);
    }
  }
  const directMessageIds = [...effectiveMessageIds].filter(
    (id) => !input.preExistingCoverage.has(id)
  );
  let filteredIds = filterProtectedToolMessages(
    directMessageIds,
    input.messages,
    input.config
  );
  if (filteredIds.length < directMessageIds.length) {
    const kept = new Set(filteredIds);
    for (const id of directMessageIds) {
      if (!kept.has(id)) effectiveMessageIds.delete(id);
    }
  }
  const protectedRefs = input.protectedMessageIds;
  const hitProtectedRaw = protectedRefs ? filteredIds.filter((id) => {
    const ref = input.state.messageRefs.byRaw[id];
    return ref !== void 0 && protectedRefs.has(ref);
  }) : [];
  if (hitProtectedRaw.length > 0) {
    const protectedSet = new Set(hitProtectedRaw);
    filteredIds = filteredIds.filter((id) => !protectedSet.has(id));
    for (const id of hitProtectedRaw) effectiveMessageIds.delete(id);
    const hitRefs = hitProtectedRaw.map((id) => input.state.messageRefs.byRaw[id]).filter((v) => typeof v === "string");
    if (filteredIds.length === 0 && consumedBlockIds.length === 0) {
      const recentN = input.config.preserveRecentMessages;
      throw new Error(
        `Range is entirely within the protected zone (the last ${recentN} messages and/or the most recent user message): ${hitRefs.join(
          ", "
        )}. Adjust startId/endId to older messages.`
      );
    }
    warnings.push(
      `Excluded ${hitProtectedRaw.length} protected message(s) ${hitRefs.join(
        ", "
      )} from compression range (recent/last-user zone).`
    );
  }
  if (!isBlockBoundary && filteredIds.length === 0 && consumedBlockIds.length > 0) {
    const first = consumedBlockIds[0];
    const last = consumedBlockIds[consumedBlockIds.length - 1];
    throw new Error(
      `Range ${input.spec.startRef}..${input.spec.endRef} contains no new compressible messages \u2014 every message in it is already covered by active block(s) ${consumedBlockIds.join(
        ", "
      )}. Nothing was compressed. To rewrite or merge those blocks, reference them by block ID (${first}..${last}); otherwise run acp_status and compress a range it reports as compressible.`
    );
  }
  validateCompressionRange(input, filteredIds, consumedBlockIds.length);
  let compressedTokens = 0;
  for (const id of filteredIds) {
    const message = input.messages.find((entry) => entry.id === id);
    compressedTokens += input.countTokens(message?.text ?? "");
  }
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) {
      compressedTokens += input.countTokens(consumed.summary);
    }
  }
  const blockId = allocateBlockId(input.state);
  const block = {
    blockId,
    runId: input.runId,
    tier: outputTier,
    topic: input.spec.topic,
    summary: input.spec.summary,
    directMessageIds: filteredIds,
    effectiveMessageIds: [...effectiveMessageIds],
    directBlockIds: [...consumedBlockIds],
    compressedTokens,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    compressCallId: input.spec.compressCallId,
    startRef: input.spec.startRef,
    endRef: input.spec.endRef
  };
  input.state.blocks.push(block);
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) consumed.active = false;
  }
  return { tokens: compressedTokens, warnings };
}
function applyPairBoundaryAdjustments(resolved, messages) {
  if (resolved.boundaryKind === "block") {
    return resolved.messageIds;
  }
  let startIndex = resolved.startIndex;
  let endIndex = resolved.endIndex;
  for (let pass = 0; pass < 2; pass++) {
    const reasoningAdjusted = adjustBoundariesForReasoningPairs(
      startIndex,
      endIndex,
      messages
    );
    const toolAdjusted = adjustBoundariesForToolPairs(
      reasoningAdjusted.startIndex,
      reasoningAdjusted.endIndex,
      messages
    );
    const changed = toolAdjusted.startIndex !== startIndex || toolAdjusted.endIndex !== endIndex;
    startIndex = toolAdjusted.startIndex;
    endIndex = toolAdjusted.endIndex;
    if (!changed) break;
  }
  if (startIndex === resolved.startIndex && endIndex === resolved.endIndex) {
    return resolved.messageIds;
  }
  const ids = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (msg) ids.push(msg.id);
  }
  return ids;
}
function validateCompressionRange(input, directMessageIds, consumedBlockCount) {
  const cfg = input.config.compress;
  const summary = input.spec.summary?.trim() ?? "";
  if (summary.length === 0) {
    throw new Error(
      "Summary is empty \u2014 provide a meaningful summary of the compressed range."
    );
  }
  if (cfg.minSummaryLength > 0 && summary.length < cfg.minSummaryLength) {
    throw new Error(
      `Summary too short (${summary.length} chars, min ${cfg.minSummaryLength}). The summary must capture the compressed range's key information.`
    );
  }
  const effectiveMax = input.spec.summaryMaxChars ?? cfg.maxSummaryLength;
  if (effectiveMax > 0 && summary.length > effectiveMax) {
    throw new Error(
      `Summary too long (${summary.length} chars, max ${effectiveMax}). Strip noise \u2014 keep critical paths, decisions, errors, and code references. Or pass summaryMaxChars to increase the limit \u2014 don't lose critical info just to fit.`
    );
  }
  if (directMessageIds.length === 0 && consumedBlockCount === 0) {
    throw new Error(
      "Range contains no compressible messages \u2014 all are already covered by active blocks or protected."
    );
  }
}
function filterProtectedToolMessages(directMessageIds, messages, config) {
  const protectedCallIds = /* @__PURE__ */ new Set();
  const removedIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (isMessageProtected(msg, config) && msg.toolCallId) {
      protectedCallIds.add(msg.toolCallId);
    }
  }
  for (const id of directMessageIds) {
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (isMessageProtected(msg, config)) {
      removedIds.add(id);
      if (msg.toolCallId) protectedCallIds.add(msg.toolCallId);
    }
  }
  for (const id of directMessageIds) {
    if (removedIds.has(id)) continue;
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (msg.contentType === "tool-result" && msg.toolCallId && protectedCallIds.has(msg.toolCallId)) {
      removedIds.add(id);
    }
  }
  return directMessageIds.filter((id) => !removedIds.has(id));
}
function resolveTargetTier(state, nestedBlockIds, isBlockBoundary) {
  if (!isBlockBoundary) return 1;
  if (nestedBlockIds.length === 0) return 1;
  let minTier = 3;
  for (const id of nestedBlockIds) {
    const block = blockById(state, id);
    if (block && block.tier < minTier) minTier = block.tier;
  }
  return minTier;
}
function collectCoverage(state) {
  const coverage = /* @__PURE__ */ new Set();
  for (const block of activeBlocks(state)) {
    for (const id of block.effectiveMessageIds) coverage.add(id);
  }
  return coverage;
}
function resolveAdaptiveGrowth(modelContextLimit, nudge) {
  if (!modelContextLimit || modelContextLimit <= 0) return nudge.growthFloor;
  return Math.min(
    nudge.growthCap,
    Math.max(
      nudge.growthFloor,
      Math.round(modelContextLimit * nudge.growthRatio)
    )
  );
}
function resolveMinPressureBenefit(modelContextLimit, nudge) {
  return nudge.minPressureBenefitTokens ?? Math.max(5e3, Math.round(modelContextLimit * 0.01));
}
function pendingByTier(state, recommendation, countTokens, minCompressRange) {
  const out = {};
  const merged = recommendation?.recommendedRanges ?? [];
  const effective = minCompressRange > 0 ? merged.filter((r) => (r.chars ?? r.tokens * 4) >= minCompressRange) : merged;
  out[1] = {
    pending: effective.reduce((s, r) => s + r.tokens, 0),
    targetBlocks: []
  };
  const active = activeBlocks(state);
  const t1 = active.filter((b) => b.tier === 1);
  const t2 = active.filter((b) => b.tier === 2);
  out[2] = {
    pending: t1.reduce((s, b) => s + countTokens(b.summary), 0),
    targetBlocks: t1
  };
  out[3] = {
    pending: t2.reduce((s, b) => s + countTokens(b.summary), 0),
    targetBlocks: t2
  };
  return out;
}
function decideNudge(input) {
  const { config, state, tokenCount, recommendation, countTokens } = input;
  const limit = config.modelContextLimit;
  const usage = limit > 0 ? tokenCount / limit : 0;
  const nudgeGrowthTokens = resolveAdaptiveGrowth(limit, config.nudge);
  const minPressureBenefit = resolveMinPressureBenefit(limit, config.nudge);
  const overLimit = usage >= config.nudge.maxContextLimitPct;
  const emergencyOverride = usage >= config.nudge.emergencyThresholdPct;
  const pressure = overLimit || emergencyOverride;
  const baseline = state.nudge.lastPerMessageNudgeTokens;
  const hadPendingNudge = state.nudge.lastNudgeShownTokens > 0;
  const hasPendingNudge = hadPendingNudge;
  const effectiveThreshold = hasPendingNudge ? Math.floor(nudgeGrowthTokens / 2) : nudgeGrowthTokens;
  const growthReference = state.nudge.lastNudgeShownTokens > 0 ? state.nudge.lastNudgeShownTokens : baseline > 0 ? baseline : tokenCount;
  const growthFloor = Math.max(
    config.nudge.minGrowthFloor,
    config.nudge.minGrowthRatio * nudgeGrowthTokens
  );
  const growthSinceReference = tokenCount - growthReference;
  const rec = recommendation;
  const tiers = pendingByTier(
    state,
    rec,
    countTokens,
    config.compress.minCompressRange
  );
  const tier2Threshold = Math.round(
    nudgeGrowthTokens * (config.nudge.tier2GrowthMultiplier ?? 1.5)
  );
  let injectedTier = null;
  let injectedReason = "";
  let bestPending = 0;
  const t1Eff = tiers[1]?.pending ?? 0;
  const t2Pen = tiers[2]?.pending ?? 0;
  const t3Pen = tiers[3]?.pending ?? 0;
  const firstSightMassReady = state.nudge.lastNudgeShownTokens === 0 && baseline === 0 && usage >= config.nudge.minContextLimitPct && Math.max(t1Eff, t2Pen, t3Pen) >= nudgeGrowthTokens;
  const growthReady = firstSightMassReady || growthSinceReference >= growthFloor;
  const t2Count = tiers[2]?.targetBlocks.length ?? 0;
  const t3Count = tiers[3]?.targetBlocks.length ?? 0;
  if (pressure) {
    const candidates = [1];
    if (config.tiers.enabled) {
      candidates.push(2, 3);
    }
    let best = null;
    for (const t of candidates) {
      const p = tiers[t]?.pending ?? 0;
      if (p > bestPending) {
        bestPending = p;
        best = t;
      }
    }
    if (best !== null && bestPending >= minPressureBenefit) {
      injectedTier = best;
      const label = emergencyOverride ? "EMERGENCY" : "OVER-LIMIT";
      injectedReason = best === 1 ? `${label} T1: max effective pending ${bestPending}, usage ${Math.round(usage * 100)}%` : `${label} T${best} distill: max pending ${bestPending} (T1 effective ${t1Eff}, T2 ${t2Pen}, T3 ${t3Pen}), usage ${Math.round(usage * 100)}%`;
    }
  } else if (growthReady) {
    if (t1Eff >= nudgeGrowthTokens) {
      injectedTier = 1;
      injectedReason = `T1 effective ${t1Eff} >= ${nudgeGrowthTokens}, growth ${growthSinceReference}, usage ${Math.round(usage * 100)}%`;
    } else if (config.tiers.enabled && (t2Count >= config.tiers.tier2Trigger || t2Pen >= tier2Threshold && t2Pen > t1Eff)) {
      const lastShown = state.nudge.lastShownByTier[2] ?? 0;
      const cadenceMet = lastShown === 0 || tokenCount - lastShown >= growthFloor;
      if (cadenceMet) {
        injectedTier = 2;
        injectedReason = t2Count >= config.tiers.tier2Trigger ? `T2 distill ready: ${t2Count} tier-1 blocks >= tier2Trigger ${config.tiers.tier2Trigger} (${t2Pen} tokens), usage ${Math.round(usage * 100)}%` : `T2 distill ready: ${tiers[2].targetBlocks.length} tier-1 blocks (${t2Pen} tokens) >= ${tier2Threshold} (1.5x) and > T1 effective ${t1Eff}, usage ${Math.round(usage * 100)}%`;
      }
    } else if (config.tiers.enabled && (t3Count >= config.tiers.tier3Trigger || t3Pen >= tier2Threshold && t3Pen > t2Pen && t3Pen > t1Eff)) {
      const lastShown = state.nudge.lastShownByTier[3] ?? 0;
      const cadenceMet = lastShown === 0 || tokenCount - lastShown >= growthFloor;
      if (cadenceMet) {
        injectedTier = 3;
        injectedReason = t3Count >= config.tiers.tier3Trigger ? `T3 condense ready: ${t3Count} tier-2 blocks >= tier3Trigger ${config.tiers.tier3Trigger} (${t3Pen} tokens), usage ${Math.round(usage * 100)}%` : `T3 condense ready: ${tiers[3].targetBlocks.length} tier-2 blocks (${t3Pen} tokens) >= ${tier2Threshold} (1.5x) and > T2 ${t2Pen} and > T1 effective ${t1Eff}, usage ${Math.round(usage * 100)}%`;
      }
    }
  }
  const shouldInject = injectedTier !== null;
  if (shouldInject && firstSightMassReady) {
    injectedReason += " [first-sight mass]";
  }
  let reason;
  if (injectedTier !== null) {
    reason = injectedReason;
  } else if (pressure) {
    const label = emergencyOverride ? "EMERGENCY" : "OVER-LIMIT";
    reason = bestPending === 0 ? `${label}: usage ${Math.round(usage * 100)}% but no tier has effective compressible content (T1 effective ${t1Eff}, T2 ${t2Pen}, T3 ${t3Pen}) \u2014 nudge suppressed to avoid offering ranges below minCompressRange` : `${label}: usage ${Math.round(usage * 100)}% but max pending ${bestPending} < min benefit ${minPressureBenefit} tokens (T1 effective ${t1Eff}, T2 ${t2Pen}, T3 ${t3Pen}) \u2014 suppressed: rewriting below the benefit floor reclaims almost nothing while usage stays high; truncate.threshold remains the safety valve`;
  } else {
    const tiersList = [1, 2, 3];
    const eligible = tiersList.filter((t) => config.tiers.enabled || t === 1);
    const countReady = (t) => t === 2 ? t2Count >= config.tiers.tier2Trigger : t === 3 ? t3Count >= config.tiers.tier3Trigger : false;
    const ready = eligible.filter((t) => (tiers[t]?.pending ?? 0) >= nudgeGrowthTokens).map((t) => `T${t} ${tiers[t].pending}`);
    const readyCount = eligible.filter((t) => (tiers[t]?.pending ?? 0) < nudgeGrowthTokens && countReady(t)).map((t) => `T${t} ${t === 2 ? t2Count : t3Count} blocks (count)`);
    const readyAll = [...ready, ...readyCount];
    const readyHint = readyAll.length > 0 ? `, ready: ${readyAll.join(", ")}` : "";
    const blocked = eligible.filter(
      (t) => ((tiers[t]?.pending ?? 0) >= nudgeGrowthTokens || countReady(t)) && (state.nudge.lastShownByTier[t] ?? 0) > 0 && tokenCount - (state.nudge.lastShownByTier[t] ?? 0) < growthFloor
    ).map((t) => `T${t} (cadence)`);
    const blockedHint = blocked.length > 0 ? `, blocked: ${blocked.join(", ")}` : "";
    const maxPending = Math.max(
      0,
      ...Object.values(tiers).map((t) => t.pending)
    );
    const pendingShort = maxPending < nudgeGrowthTokens;
    const growthShort = growthSinceReference < growthFloor;
    const parts = [];
    if (pendingShort)
      parts.push(
        `max compressible ${maxPending} < threshold ${nudgeGrowthTokens}`
      );
    if (growthShort)
      parts.push(`growth ${growthSinceReference} < floor ${growthFloor}`);
    if (parts.length === 0)
      parts.push(
        `max compressible ${maxPending}, growth ${growthSinceReference}`
      );
    reason = `${parts.join("; ")}${readyHint}${blockedHint}`;
  }
  const ctxBreakdown = computeContextBreakdown(
    input.messages,
    tokenCount,
    growthSinceReference,
    countTokens
  );
  return {
    shouldInject,
    reason,
    compressibleRanges: rec?.recommendedRanges ?? [],
    protectedRanges: rec?.contextRanges.protected ?? [],
    tierTargetBlocks: injectedTier ? tiers[injectedTier].targetBlocks : [],
    contextUsage: usage,
    tier: injectedTier,
    breakdown: {
      usage,
      growth: growthSinceReference,
      growthReference,
      effectiveThreshold,
      nudgeGrowthTokens,
      growthFloor,
      hasPendingNudge: hasPendingNudge ? 1 : 0,
      overLimit: overLimit ? 1 : 0,
      emergencyOverride: emergencyOverride ? 1 : 0,
      minPressureBenefit,
      pendingT1: tiers[1].pending,
      pendingT2: tiers[2].pending,
      pendingT3: tiers[3].pending
    },
    contextBreakdown: ctxBreakdown
  };
}
function computeContextBreakdown(messages, total, growth, countTokens) {
  const count = countTokens ?? ((t) => Math.ceil(t.length / 4));
  let system = 0, tool = 0, summaries = 0, code = 0, text = 0;
  for (const msg of messages) {
    const tokens = count(msg.text ?? "");
    if (msg.text?.startsWith("[Compressed conversation section]")) {
      summaries += tokens;
    } else if (msg.contentType === "tool-call" || msg.contentType === "tool-result") {
      tool += tokens;
    } else if (msg.role === "system") {
      system += tokens;
    } else if (msg.text?.includes("```")) {
      code += tokens;
    } else {
      text += tokens;
    }
  }
  return { system, tool, summaries, code, text, total, growth };
}
function cloneState(state) {
  return {
    blocks: state.blocks.map((block) => ({
      ...block,
      directMessageIds: [...block.directMessageIds],
      effectiveMessageIds: [...block.effectiveMessageIds],
      directBlockIds: [...block.directBlockIds]
    })),
    messageRefs: {
      byRaw: { ...state.messageRefs.byRaw },
      byRef: { ...state.messageRefs.byRef }
    },
    tokenSnapshot: { ...state.tokenSnapshot ?? {} },
    nudge: { ...state.nudge, anchors: { ...state.nudge.anchors } },
    stats: { ...state.stats },
    absorbed: (state.absorbed ?? []).map((record) => ({ ...record })),
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId
  };
}
function scoreRelevance(block, terms) {
  const topic = (block.topic ?? "").toLowerCase();
  const summary = block.summary.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const topicHits = countOccurrences(topic, term);
    if (topicHits > 0) score += Math.min(topicHits * 0.15, 0.45);
    const summaryHits = countOccurrences(summary, term);
    if (summaryHits > 0) score += Math.min(summaryHits * 0.04, 0.2);
  }
  return Math.min(score, 1);
}
function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count++;
    position += needle.length;
  }
  return count;
}
function deactivateBlock(state, blockIds, options = {}) {
  const targets = new Set(blockIds);
  const updated = state.blocks.map((block) => {
    if (!targets.has(block.blockId) || !block.active) return block;
    return {
      ...block,
      active: false,
      durationMs: block.durationMs,
      createdAt: block.createdAt
    };
  });
  let final = updated;
  if (options.deep) {
    const visited = /* @__PURE__ */ new Set();
    const queue = [];
    for (const id of blockIds) {
      const block = updated.find((b) => b.blockId === id);
      if (block) queue.push(...block.directBlockIds);
    }
    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      final = final.map((block) => {
        if (block.blockId !== id) return block;
        queue.push(...block.directBlockIds);
        return block.active ? { ...block, active: false } : block;
      });
    }
  }
  return { ...state, blocks: final };
}
function stem(word) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ses") || w.endsWith("xes") || w.endsWith("zes")) w = w.slice(0, -2);
  else if (w.endsWith("ches") || w.endsWith("shes")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith("ation") && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith("tion") && w.length > 5) w = w.slice(0, -4) + "t";
  else if (w.endsWith("ion") && w.length > 4) w = w.slice(0, -3);
  if (w.endsWith("ment") && w.length > 6) w = w.slice(0, -4);
  if (w.endsWith("ness") && w.length > 6) w = w.slice(0, -4);
  if (w.endsWith("ly") && w.length > 4) w = w.slice(0, -2);
  return w;
}
var CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
var LATIN_WORD = /[a-z][a-z0-9_]*[a-z0-9]|[a-z0-9]/g;
var cjkSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
function cjkRunTokens(segs) {
  const words = segs.filter((w) => w.length >= 2);
  if (words.length > 0) return words;
  const run = segs.join("");
  const out = [];
  for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  for (const ch of run) out.push(ch);
  return out;
}
function tokenize(text, opts = {}) {
  const lower = text.toLowerCase();
  const tokens = [];
  const latin = lower.match(LATIN_WORD) ?? [];
  for (let w of latin) {
    if (w.length >= 2) {
      if (opts.stem) w = stem(w);
      tokens.push(w);
    }
  }
  if (!CJK.test(lower)) return tokens;
  const runSegs = [];
  let cur = null;
  for (const s of cjkSegmenter.segment(lower)) {
    const t = s.segment;
    if (t.length === 0) continue;
    if (CJK.test(t)) {
      (cur ?? (cur = [])).push(t);
    } else if (cur) {
      runSegs.push(cur);
      cur = null;
    }
  }
  if (cur) runSegs.push(cur);
  for (const segs of runSegs) {
    tokens.push(...cjkRunTokens(segs));
  }
  return tokens;
}
function charBigrams(text) {
  const grams = [];
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    if (pair.trim().length === pair.length) grams.push(pair);
  }
  return grams;
}
function tfMap(text, stem2) {
  const m = /* @__PURE__ */ new Map();
  for (const t of tokenize(text, { stem: stem2 })) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
var DEFAULT_CAP_CHARS = 8 * 1024 * 1024;
var capChars = DEFAULT_CAP_CHARS;
var cache = /* @__PURE__ */ new Map();
var cachedChars = 0;
function build(text) {
  const tf = tfMap(text, true);
  let len = 0;
  for (const v of tf.values()) len += v;
  const lower = text.toLowerCase();
  return { tf, len, lower, grams: new Set(charBigrams(lower)) };
}
function docFeatures(text) {
  const hit = cache.get(text);
  if (hit) return hit;
  const f = build(text);
  if (text.length > 0 && text.length <= capChars) {
    while (cachedChars + text.length > capChars && cache.size > 0) {
      const k = cache.keys().next().value;
      cachedChars -= k.length;
      cache.delete(k);
    }
    cache.set(text, f);
    cachedChars += text.length;
  }
  return f;
}
var substringAlgorithm = {
  name: "substring",
  description: "Exact substring counting (original baseline). Predictable, no normalization.",
  score(docs, query) {
    const terms = query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
    if (terms.length === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));
    return docs.map((d) => {
      const haystack = docFeatures(d.text).lower;
      let score = 0;
      for (const term of terms) score += countOccurrences2(haystack, term);
      return { ref: d.ref, score };
    });
  }
};
function countOccurrences2(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}
var bm25Algorithm = {
  name: "bm25",
  description: "BM25 with stemming + CJK bigram tokenization. IR-standard relevance ranking.",
  score(docs, query) {
    const N = docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const parsed = docs.map((d) => {
      const f = docFeatures(d.text);
      return { id: d.ref, tf: f.tf, len: f.len };
    });
    const avgdl = parsed.reduce((s, d) => s + d.len, 0) / (N || 1);
    const qTerms = tokenize(query, { stem: true });
    if (qTerms.length === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));
    const idf = /* @__PURE__ */ new Map();
    for (const t of new Set(qTerms)) {
      let df = 0;
      for (const d of parsed) if (d.tf.has(t)) df++;
      idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }
    return parsed.map((d) => {
      let score = 0;
      for (const t of qTerms) {
        const f = d.tf.get(t) ?? 0;
        if (f === 0) continue;
        const idfT = idf.get(t) ?? 0;
        score += idfT * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / (avgdl || 1)));
      }
      return { ref: d.id, score };
    });
  }
};
var fuzzyAlgorithm = {
  name: "fuzzy",
  description: "Character bigram overlap. Typo-tolerant, script-agnostic, high recall.",
  score(docs, query) {
    const qTokens = query.toLowerCase().split(/[\s,]+/).filter((t) => t.length >= 4 || t.length >= 2 && CJK.test(t));
    if (qTokens.length === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));
    const qGrams = /* @__PURE__ */ new Set();
    for (const t of qTokens) for (const g of charBigrams(t)) qGrams.add(g);
    if (qGrams.size === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));
    return docs.map((d) => {
      const docGrams = docFeatures(d.text).grams;
      let hits = 0;
      for (const g of qGrams) if (docGrams.has(g)) hits++;
      return { ref: d.ref, score: hits / qGrams.size };
    });
  }
};
var W_BM25 = 0.7;
var W_FUZZY = 0.3;
var hybridAlgorithm = {
  name: "hybrid",
  description: "Weighted BM25(stem) + fuzzy n-gram. Default \u2014 best precision + recall.",
  score(docs, query) {
    const bm = bm25Algorithm.score(docs, query);
    const fz = fuzzyAlgorithm.score(docs, query);
    const maxBm = Math.max(...bm.map((r) => r.score), 1e-9);
    const maxFz = Math.max(...fz.map((r) => r.score), 1e-9);
    const bmMap = new Map(bm.map((r) => [r.ref, r.score / maxBm]));
    const fzMap = new Map(fz.map((r) => [r.ref, r.score / maxFz]));
    return docs.map((d) => ({
      ref: d.ref,
      score: W_BM25 * (bmMap.get(d.ref) ?? 0) + W_FUZZY * (fzMap.get(d.ref) ?? 0)
    }));
  }
};
var registry2 = /* @__PURE__ */ new Map();
function registerSearchAlgorithm(algo) {
  registry2.set(algo.name, algo);
}
function getSearchAlgorithm(name) {
  return registry2.get(name);
}
registerSearchAlgorithm(substringAlgorithm);
registerSearchAlgorithm(bm25Algorithm);
registerSearchAlgorithm(fuzzyAlgorithm);
registerSearchAlgorithm(hybridAlgorithm);
var DEFAULT_ROLE_WEIGHTS = {
  user: 1.5,
  assistant: 1,
  tool: 0.6,
  block: 1
};
var DEFAULT_ALGORITHM = "hybrid";
function blockDocs(state) {
  return state.blocks.map((b) => ({
    kind: "block",
    ref: b.blockId,
    text: `${b.topic ?? ""} ${b.summary ?? ""}`,
    title: b.topic ?? b.blockId,
    blockId: b.blockId,
    tier: b.tier ?? 1,
    tokens: b.compressedTokens
  }));
}
function applyRoleWeight(scored, docs, rw) {
  if (docs.length === 0) return scored;
  const docByRef = new Map(docs.map((d) => [d.ref, d]));
  return scored.map((s) => {
    const doc = docByRef.get(s.ref);
    if (!doc) return s;
    const w = doc.kind === "message" ? doc.role === "user" ? rw.user : doc.role === "assistant" ? rw.assistant : rw.tool : rw.block;
    return { ref: s.ref, score: s.score * w };
  });
}
function runSearch(docs, query, options) {
  const limit = options.limit ?? 10;
  const previewLength = options.previewLength ?? 200;
  const minScore = options.minScore ?? 0.01;
  const algoName = options.algorithm ?? DEFAULT_ALGORITHM;
  const rw = { ...DEFAULT_ROLE_WEIGHTS, ...options.roleWeights };
  const algo = getSearchAlgorithm(algoName);
  if (!algo) return [];
  if (docs.length === 0) return [];
  const scoredOrPromise = algo.score(docs, query);
  const buildResults = (weighted) => {
    const byRef = new Map(docs.map((d) => [d.ref, d]));
    return weighted.map((s) => {
      const doc = byRef.get(s.ref);
      if (!doc) return null;
      return {
        kind: doc.kind,
        ref: doc.ref,
        blockId: doc.blockId,
        tier: doc.tier ?? 1,
        score: s.score,
        title: doc.title,
        preview: makePreview(doc.text, query, previewLength),
        role: doc.role,
        tokens: doc.tokens
      };
    }).filter((r) => r !== null && r.score >= minScore).sort((a, b) => b.score - a.score).slice(0, limit);
  };
  if (scoredOrPromise instanceof Promise) {
    return scoredOrPromise.then((raw) => buildResults(applyRoleWeight(raw, docs, rw)));
  }
  return buildResults(applyRoleWeight(scoredOrPromise, docs, rw));
}
function searchBlocks(docs, query, options = {}) {
  const result = runSearch(docs, query, options);
  if (result instanceof Promise) {
    throw new Error(
      `searchBlocks: algorithm "${options.algorithm ?? DEFAULT_ALGORITHM}" is async (e.g. semantic). Use searchBlocksAsync() instead.`
    );
  }
  return result;
}
function makePreview(text, query, len) {
  if (!text) return "";
  const terms = query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return text.slice(0, len);
  const lower = text.toLowerCase();
  let hitIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      hitIdx = idx;
      break;
    }
  }
  if (hitIdx < 0) return text.slice(0, len);
  const half = Math.max(0, Math.floor(len / 2) - 10);
  const start = Math.max(0, hitIdx - half);
  const end = Math.min(text.length, start + len);
  const prefix = start > 0 ? "\u2026" : "";
  const suffix = end < text.length ? "\u2026" : "";
  return prefix + text.slice(start, end).trim() + suffix;
}

// src/acp/paths.ts
var DATA_DIR = "/sdcard/Download/Operit/plugins/com.operit.acp_compressor";
var SETTINGS_FILE = `${DATA_DIR}/acp-config.json`;
var STATE_DIR = `${DATA_DIR}/acp-state`;
var LOG_DIR = `${DATA_DIR}/logs`;
var LOG_ACP_FILE = `${LOG_DIR}/acp.log`;
var LOG_TOOLS_VISIBILITY_FILE = `${LOG_DIR}/tools_visibility.log`;
var LOG_TOOL_CALLS_FILE = `${LOG_DIR}/acp_tool_calls.log`;

// src/acp/config.ts
var KEYS = {
  enabled: "enabled",
  modelContextLimit: "contextLimit",
  preserveRecentMessages: "preserveRecentMessages",
  minCompressRange: "minCompressRangeChars",
  hardLimitPct: "hardLimitPct",
  nudgeThresholdPct: "nudgeThresholdPct"
};
var SETTINGS_FILE2 = SETTINGS_FILE;
var SETTINGS_CACHE_KEY = "__acp_settings_cache_v2";
function readJsonSettings() {
  const g = globalThis;
  try {
    const fs = Tools.Files;
    const res = fs.read(SETTINGS_FILE2);
    const content = res && res.content;
    if (!content) return {};
    const cached = g[SETTINGS_CACHE_KEY];
    if (cached && cached.raw === content) return cached.data;
    const parsed = JSON.parse(content);
    const data = parsed && typeof parsed === "object" ? parsed : {};
    g[SETTINGS_CACHE_KEY] = { raw: content, data };
    return data;
  } catch {
    return {};
  }
}
function readEnv(key) {
  const json = readJsonSettings();
  const v = json[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}
function readBool(key, dflt) {
  const raw = readEnv(key).toLowerCase();
  if (!raw) return dflt;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
function readNum(key, dflt) {
  const raw = readEnv(key);
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function readPct(key, dflt) {
  const raw = readEnv(key);
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return n > 1 ? n / 100 : n;
}
function readList(key, dflt) {
  const raw = readEnv(key);
  if (!raw) return dflt;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
function loadAdapterSettings() {
  const modelContextLimit = readNum(KEYS.modelContextLimit, 2e5);
  return {
    enabled: readBool(KEYS.enabled, true),
    modelContextLimit,
    preserveRecentMessages: readNum(KEYS.preserveRecentMessages, 5),
    preserveRecentTokens: 5e3,
    protectedTools: readList("protectedTools", []),
    renderTags: "none",
    nudgeEnabled: true,
    nudgeThresholdPct: readPct(KEYS.nudgeThresholdPct, 0.75),
    hardLimitPct: readPct(KEYS.hardLimitPct, 0.85),
    minCompressRange: readNum(KEYS.minCompressRange, 5e3),
    hideConsumedCompressCalls: true,
    nudgeCooldownTurns: 3,
    nudgeCooldownTokens: 2e4,
    nudgeGrowthFloor: 1e4,
    nudgeMinGrowthFloor: 5e3,
    // V0.4 三档：温和提示沿用旧键 nudgeThresholdPct（兼容已存设置），强制/硬限新增键。
    gentleThresholdPct: readPct("nudgeThresholdPct", 0.72),
    strongThresholdPct: readPct("strongThresholdPct", 0.82),
    // V0.7 host 自接管下限：约 0.70（低于 gentle 0.72，允许 Adapter 在 kernel 沉默区先接管）。
    hostEscalationFloor: readPct("hostEscalationFloor", 0.7),
    // V0.4.1 usage credit：压缩后 contextLimit*15% token 内免除 nudge。
    usageCreditTokens: Math.round(modelContextLimit * 0.15),
    // V0.6 Phase7 增量投影阈值（默认允许新增 8 条内走增量）。
    incrementalMaxNewTurns: readNum("incrementalMaxNewTurns", 8),
    dataDir: DATA_DIR
  };
}
function resolveKernelConfig(settings) {
  const cfg = defaultConfig(settings.modelContextLimit);
  return {
    ...cfg,
    preserveRecentMessages: settings.preserveRecentMessages,
    preserveRecentTokens: settings.preserveRecentTokens,
    protectedTools: settings.protectedTools,
    nudge: {
      ...cfg.nudge,
      // 主动压缩窗口拉长：min 为温和区起点（usage 进入即 soft nudge），
      // max 为强制区起点（strong nudge），emergency 为紧急兜底（宿主兜底折叠）。
      // 三档递进：gentle → strong → emergency auto-fold。
      minContextLimitPct: settings.gentleThresholdPct,
      maxContextLimitPct: settings.strongThresholdPct,
      emergencyThresholdPct: settings.hardLimitPct,
      force: "soft",
      growthFloor: settings.nudgeGrowthFloor,
      minGrowthFloor: settings.nudgeMinGrowthFloor
    },
    compress: {
      ...cfg.compress,
      minCompressRange: settings.minCompressRange
    }
  };
}

// src/acp/messages.ts
function hashString(input) {
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822507) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
var KIND_TO_ROLE = {
  SYSTEM: "system",
  USER: "user",
  ASSISTANT: "assistant",
  TOOL_RESULT: "tool",
  TOOL_CALL: "assistant",
  SUMMARY: "system"
};
var KIND_TO_CONTENT_TYPE = {
  SYSTEM: "text",
  USER: "text",
  ASSISTANT: "text",
  TOOL_RESULT: "tool-result",
  TOOL_CALL: "tool-call",
  SUMMARY: "text"
};
function toolNameFromXml(content) {
  if (typeof content !== "string") return "";
  const m = /<tool(?:_result)?_[a-zA-Z0-9_]+ name="([^"]*)"/.exec(content);
  return m ? m[1] : "";
}
function toolTagIdFromXml(content) {
  if (typeof content !== "string") return "";
  const m = /<tool(?:_result)?_([a-zA-Z0-9_]+)/.exec(content);
  return m ? m[1] : "";
}
function stableKeyForTurn(turn) {
  const kind = turn.kind || "UNKNOWN";
  const content = typeof turn.content === "string" ? turn.content : "";
  let toolName = turn.toolName || "";
  if (toolName === "null" || toolName === "undefined") toolName = "";
  const stableMeta = {};
  if (turn.metadata && typeof turn.metadata === "object") {
    for (const [k, v] of Object.entries(turn.metadata)) {
      if (k === "toolCallId" || k === "tool_call_id") continue;
      stableMeta[k] = v;
    }
  }
  const meta = Object.keys(stableMeta).length > 0 ? stableStringify(stableMeta) : "";
  return `${kind}|${toolName}|${hashString(JSON.stringify([content, meta]))}`;
}
function promptTurnsToCoreMessages(turns, identity) {
  const messages = [];
  const byKey = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Map();
  const pendingCallIds = [];
  const identityFn = identity?.identityForTurn ? identity.identityForTurn : (turn) => ({ id: stableKeyForTurn(turn) });
  for (const turn of turns) {
    const idBase = identityFn(turn).id;
    const occurrence = (seen.get(idBase) || 0) + 1;
    seen.set(idBase, occurrence);
    const key = occurrence === 1 ? idBase : `${idBase}#${occurrence}`;
    const role = KIND_TO_ROLE[turn.kind] || "user";
    const contentType = KIND_TO_CONTENT_TYPE[turn.kind] || "text";
    const text = typeof turn.content === "string" ? turn.content : "";
    const core = {
      id: key,
      role,
      contentType,
      text
    };
    if (turn.kind === "TOOL_CALL" || turn.kind === "TOOL_RESULT") {
      const xmlName = toolNameFromXml(text);
      if (xmlName) core.toolName = xmlName;
      else if (turn.toolName && turn.toolName !== "null" && turn.toolName !== "undefined") {
        core.toolName = turn.toolName;
      }
    }
    let explicitCallId;
    if (turn.metadata && typeof turn.metadata.toolCallId === "string") {
      explicitCallId = turn.metadata.toolCallId;
    } else if (turn.metadata && typeof turn.metadata.tool_call_id === "string") {
      explicitCallId = turn.metadata.tool_call_id;
    }
    if (explicitCallId) {
      core.toolCallId = explicitCallId;
      if (turn.kind === "TOOL_CALL") {
        pendingCallIds.push(explicitCallId);
      } else if (turn.kind === "TOOL_RESULT") {
        if (pendingCallIds.length > 0 && pendingCallIds[0] === explicitCallId) {
          pendingCallIds.shift();
        }
      }
    } else if (turn.kind === "TOOL_CALL") {
      const tagId = toolTagIdFromXml(text);
      const callId = tagId ? `tc_${tagId}` : `tc_${hashString(text + "|call").slice(0, 8)}`;
      core.toolCallId = callId;
      pendingCallIds.push(callId);
    } else if (turn.kind === "TOOL_RESULT") {
      const paired = pendingCallIds.shift();
      if (paired) {
        core.toolCallId = paired;
      } else {
        const tagId = toolTagIdFromXml(text);
        if (tagId) core.toolCallId = `orphan_${tagId}`;
      }
    }
    messages.push(core);
    byKey.set(key, turn);
  }
  return { messages, byKey };
}
function capProjectionSize(turns, opts) {
  const keepChars = opts?.keepChars ?? 2e3;
  const maxRecent = opts?.maxRecent ?? 3;
  const totalBudgetChars = opts?.totalBudgetChars ?? 0;
  const protectFrom = Math.max(0, turns.length - maxRecent);
  const truncate = (t, chars) => {
    const content = typeof t.content === "string" ? t.content : "";
    if (content.length <= chars) return t;
    if (t.kind === "SUMMARY" || t.kind === "SYSTEM") return t;
    const prefix = content.slice(0, chars);
    const suffix = content.slice(-chars);
    return {
      ...t,
      content: `${prefix}
...[truncated for context space (original ${content.length} chars)]...
${suffix}`
    };
  };
  let out = turns.map((t, i) => i >= protectFrom ? t : truncate(t, keepChars));
  if (totalBudgetChars > 0) {
    let total = out.reduce((s, t) => s + (typeof t.content === "string" ? t.content.length : 0), 0);
    let rounds = 0;
    while (total > totalBudgetChars && rounds < 3) {
      rounds++;
      let reduced = false;
      for (let i = 0; i < out.length && total > totalBudgetChars; i++) {
        if (i >= protectFrom) continue;
        if (out[i].kind === "SYSTEM" || out[i].kind === "SUMMARY") continue;
        const before = typeof out[i].content === "string" ? out[i].content.length : 0;
        if (before > Math.floor(keepChars / 4)) {
          out[i] = truncate(out[i], Math.floor(keepChars / 4));
          const after = out[i].content.length;
          if (after < before) {
            total -= before - after;
            reduced = true;
          }
        }
      }
      if (!reduced) break;
    }
  }
  return out;
}
function coreMessagesToPromptTurns(coreMessages, byKey) {
  const out = [];
  const emitted = /* @__PURE__ */ new Set();
  for (const core of coreMessages) {
    if (!core.id) continue;
    if (emitted.has(core.id)) continue;
    emitted.add(core.id);
    if (core.id.startsWith("acp_summary_") || core.id.startsWith("acp_block_")) {
      out.push({
        kind: "SUMMARY",
        content: core.text || "",
        metadata: { acp: true, blockId: core.toolCallId || void 0 }
      });
      continue;
    }
    const original = byKey.get(core.id);
    if (original) {
      const isStructured = original.kind === "TOOL_CALL" || original.kind === "TOOL_RESULT";
      const outTurn = { ...original };
      if (!isStructured && typeof core.text === "string" && core.text !== original.content) {
        outTurn.content = core.text;
      }
      if (core.toolCallId && (!outTurn.metadata || !outTurn.metadata.toolCallId)) {
        outTurn.metadata = { ...outTurn.metadata || {}, toolCallId: core.toolCallId };
      }
      out.push(outTurn);
      continue;
    }
    const role = core.role;
    const kind = role === "system" ? "SYSTEM" : role === "user" ? "USER" : role === "tool" ? "TOOL_RESULT" : "ASSISTANT";
    out.push({
      kind,
      content: core.text || "",
      toolName: core.toolName,
      metadata: { acpSynthetic: true }
    });
  }
  return out;
}

// src/identity-bridge.ts
function classifyTurn(turn) {
  const kind = turn.kind || "UNKNOWN";
  const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : void 0;
  const isAcp = md?.acp === true || md?.acpNudge === true;
  switch (kind) {
    case "SYSTEM":
      return isAcp ? "ACP_NUDGE" : "HOST_SYSTEM";
    case "USER":
      return "HOST_USER";
    case "ASSISTANT":
      return "HOST_ASSISTANT";
    case "TOOL_CALL":
      return "HOST_TOOL_CALL";
    case "TOOL_RESULT":
      return "HOST_TOOL_RESULT";
    case "SUMMARY":
      return isAcp ? "ACP_SUMMARY" : "HOST_ASSISTANT";
    default:
      return "UNKNOWN";
  }
}
function createIdentityBridgeState() {
  return { toolAlignments: {}, toolSeqCounter: 0 };
}
function loadIdentityBridgeState(raw) {
  if (raw && typeof raw === "object") {
    const r = raw;
    return {
      toolAlignments: r.toolAlignments && typeof r.toolAlignments === "object" ? r.toolAlignments : {},
      toolSeqCounter: typeof r.toolSeqCounter === "number" ? r.toolSeqCounter : 0
    };
  }
  return createIdentityBridgeState();
}
function normalizeToolCallSignature(content) {
  return content.replace(/<tool_[a-zA-Z0-9_]+/g, "<tool").replace(/<\/tool_[a-zA-Z0-9_]+>/g, "</tool>").trim();
}
function normalizeToolResultSignature(content) {
  return content.replace(/<tool_result_[a-zA-Z0-9_]+/g, "<tool_result").replace(/<\/tool_result_[a-zA-Z0-9_]+>/g, "</tool_result>").trim();
}
function toolNameFromContent(content) {
  const m = /<tool(?:_result)?_[a-zA-Z0-9_]+ name="([^"]*)"/.exec(content || "");
  return m ? m[1] : "";
}
function explicitToolCallId(turn) {
  const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : void 0;
  if (md) {
    if (typeof md.toolCallId === "string" && md.toolCallId) return md.toolCallId;
    const v = md.tool_call_id;
    if (typeof v === "string" && v) return v;
  }
  const c = typeof turn.content === "string" ? turn.content : "";
  const m = /tool_call_id["']?\s*[:=]\s*["']([^"']+)["']/.exec(c);
  return m ? m[1] : void 0;
}
function legacyStableKey(turn) {
  const kind = turn.kind || "UNKNOWN";
  const content = typeof turn.content === "string" ? turn.content : "";
  let toolName = turn.toolName || "";
  if (toolName === "null" || toolName === "undefined") toolName = "";
  const stableMeta = {};
  if (turn.metadata && typeof turn.metadata === "object") {
    for (const [k, v] of Object.entries(turn.metadata)) {
      if (k === "toolCallId" || k === "tool_call_id") continue;
      stableMeta[k] = v;
    }
  }
  const meta = Object.keys(stableMeta).length > 0 ? stableStringify(stableMeta) : "";
  return `${kind}|${toolName}|${hashString(JSON.stringify([content, meta]))}`;
}
function hostAnchor(turn) {
  const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : void 0;
  if (md) {
    if (typeof md.messageId === "string" && md.messageId) return md.messageId;
    if (typeof md.hostMessageId === "string" && md.hostMessageId) return md.hostMessageId;
  }
  return void 0;
}
function identityForTurn(turn, ctx) {
  const cls = classifyTurn(turn);
  const legacyKey = legacyStableKey(turn);
  if (ctx?.legacyRefExists) {
    try {
      if (ctx.legacyRefExists(legacyKey)) {
        return { id: legacyKey, strategy: "legacy-continuity", cls, legacyKey };
      }
    } catch {
    }
  }
  switch (cls) {
    case "HOST_USER": {
      const a = hostAnchor(turn);
      if (a) return { id: `host:user:${a}`, strategy: "host-anchor", cls, legacyKey };
      return { id: `host:user:content:${hashString(JSON.stringify([turn.content]))}`, strategy: "content-fallback", cls, legacyKey };
    }
    case "HOST_ASSISTANT": {
      const a = hostAnchor(turn);
      if (a) return { id: `host:assistant:${a}`, strategy: "host-anchor", cls, legacyKey };
      return { id: `host:assistant:content:${hashString(JSON.stringify([turn.content]))}`, strategy: "content-fallback", cls, legacyKey };
    }
    case "HOST_TOOL_CALL": {
      const real = explicitToolCallId(turn);
      if (real) return { id: `host:toolcall:${real}`, strategy: "tool-call-id", cls, legacyKey };
      return virtualToolIdentity(turn, "toolcall", ctx);
    }
    case "HOST_TOOL_RESULT": {
      const real = explicitToolCallId(turn);
      if (real) return { id: `host:toolresult:${real}`, strategy: "tool-call-id", cls, legacyKey };
      return virtualToolIdentity(turn, "toolresult", ctx);
    }
    case "ACP_SUMMARY": {
      const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : void 0;
      const blockId = typeof md?.blockId === "string" && md.blockId ? md.blockId : hashString(String(turn.content)).slice(0, 10);
      return { id: `acp:summary:${blockId}`, strategy: "acp-summary", cls, legacyKey };
    }
    case "ACP_NUDGE": {
      const md = turn.metadata && typeof turn.metadata === "object" ? turn.metadata : void 0;
      const nudgeId = typeof md?.nudgeId === "string" && md.nudgeId ? md.nudgeId : hashString(String(turn.content)).slice(0, 10);
      return { id: `acp:nudge:${nudgeId}`, strategy: "acp-nudge", cls, legacyKey };
    }
    case "HOST_SYSTEM":
      return { id: `host:system:content:${hashString(String(turn.content))}`, strategy: "content-fallback", cls, legacyKey };
    default:
      return { id: `host:unknown:content:${hashString(JSON.stringify([turn.kind, turn.content]))}`, strategy: "content-fallback", cls, legacyKey };
  }
}
function virtualToolIdentity(turn, role, ctx) {
  const content = typeof turn.content === "string" ? turn.content : "";
  const toolName = toolNameFromContent(content) || turn.toolName || "";
  const sig = role === "toolcall" ? normalizeToolCallSignature(content) : normalizeToolResultSignature(content);
  const sigHash = hashString(sig).slice(0, 12);
  const state = ctx?.toolState ?? createIdentityBridgeState();
  const list = state.toolAlignments[toolName] ?? [];
  const existing = list.find((e) => e.callSig === sigHash || e.resultSig === sigHash);
  let seq;
  if (existing) {
    seq = existing.seq;
    if (role === "toolcall") existing.callSig = sigHash;
    else existing.resultSig = sigHash;
    existing.lastHop = ctx?.hop ?? 0;
  } else {
    seq = ++state.toolSeqCounter;
    state.toolAlignments[toolName] = [...list, {
      seq,
      toolName,
      callSig: role === "toolcall" ? sigHash : "",
      resultSig: role === "toolresult" ? sigHash : "",
      lastHop: ctx?.hop ?? 0
    }];
  }
  return {
    id: `host:${role}:V${seq}_${toolName || "unknown"}_${sigHash}`,
    strategy: "tool-virtual",
    cls: classifyTurn(turn),
    legacyKey: legacyStableKey(turn)
  };
}

// src/acp/token.ts
var CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g;
function countTokensCjk(text) {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_RE) || []).length;
  const otherCount = text.length - cjkCount;
  return cjkCount + Math.ceil(otherCount / 4);
}
function collectCoveredMessageIds(state) {
  const ids = /* @__PURE__ */ new Set();
  for (const b of state.blocks) {
    if (!b.active) continue;
    for (const id of b.effectiveMessageIds) ids.add(id);
  }
  return ids;
}
function estimateProjectionTokens(messages, coveredIds) {
  let tokens = 0;
  for (const m of messages) {
    if (m.toolName === "compress" || m.toolName && m.toolName.endsWith(":compress")) continue;
    if (coveredIds?.has(m.id)) continue;
    tokens += countTokensCjk(m.text ?? "");
  }
  return tokens;
}

// src/acp/persistence.ts
var EMPTY_RUNTIME_STATS = {
  nudgeIssued: 0,
  gentleNudges: 0,
  strongNudges: 0,
  emergencyNudges: 0,
  compressCalled: 0,
  compressSucceeded: 0,
  compressFailed: 0,
  emergencyTriggered: 0,
  emergencySavedTokens: 0,
  modelSavedTokens: 0,
  nudgeIgnored: 0
};
var ADAPTER_STATE_VERSION = 2;
var STATE_PREFIX = "state_";
function sessionKeyToFile(sessionKey) {
  const safe2 = sessionKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const hash = hashString(sessionKey).slice(0, 12);
  return `${STATE_PREFIX}${safe2}_${hash}.json`;
}
function mergeInitialState(parsed) {
  const fresh = createInitialState();
  return {
    blocks: Array.isArray(parsed.blocks) ? parsed.blocks : fresh.blocks,
    messageRefs: parsed.messageRefs && parsed.messageRefs.byRaw && parsed.messageRefs.byRef ? parsed.messageRefs : fresh.messageRefs,
    tokenSnapshot: parsed.tokenSnapshot && typeof parsed.tokenSnapshot === "object" ? parsed.tokenSnapshot : fresh.tokenSnapshot ?? {},
    nudge: { ...fresh.nudge, ...parsed.nudge ?? {} },
    stats: { ...fresh.stats, ...parsed.stats ?? {} },
    absorbed: Array.isArray(parsed.absorbed) ? parsed.absorbed : fresh.absorbed ?? [],
    nextBlockId: typeof parsed.nextBlockId === "number" ? parsed.nextBlockId : fresh.nextBlockId,
    nextRunId: typeof parsed.nextRunId === "number" ? parsed.nextRunId : fresh.nextRunId
  };
}
function stripOldAnchorMessages(messages) {
  const ANCHOR_MARKER = "[Compressed conversation section]";
  return messages.filter(
    (m) => !(m.id && isSummaryMessageId(m.id)) && !String(m.text || "").startsWith(ANCHOR_MARKER)
  );
}
function freshHostMeta() {
  return { toolLoopCoverage: "unknown", lastUpdatedAt: Date.now() };
}
function createPersistence(dataDir) {
  const stateDir = dataDir ? `${dataDir}/acp-state` : STATE_DIR;
  const logFile = stateDir.replace(/\/state$/, "") + "/logs/acp.log";
  const globalCache = globalThis.__acpLoadCacheV2;
  const cache2 = globalCache ?? /* @__PURE__ */ new Map();
  if (!globalThis.__acpLoadCacheV2) {
    globalThis.__acpLoadCacheV2 = cache2;
  }
  async function ensureDirs() {
    try {
      await Tools.Files.mkdir(stateDir, true, "android");
      await Tools.Files.mkdir(stateDir.replace(/\/state$/, "") + "/logs", true, "android");
    } catch {
    }
  }
  return {
    statePathFor(sessionKey) {
      return `${stateDir}/${sessionKeyToFile(sessionKey)}`;
    },
    async load(sessionKey) {
      await ensureDirs();
      const path = `${stateDir}/${sessionKeyToFile(sessionKey)}`;
      const fresh = {
        adapterStateVersion: ADAPTER_STATE_VERSION,
        kernelState: createInitialState(),
        hostMetadata: { toolLoopCoverage: "unknown", lastUpdatedAt: Date.now() }
      };
      try {
        let mtime = 0;
        try {
          const info = Tools.Files.info(path);
          mtime = info?.mtimeMs ?? 0;
          const cached = cache2.get(path);
          if (cached && cached.mtime === mtime) return cached.state;
        } catch {
        }
        const res = await Tools.Files.read(path);
        const content = res && res.content;
        if (!content) return fresh;
        const parsed = JSON.parse(content);
        if (!parsed || !parsed.kernelState) return fresh;
        const state = {
          adapterStateVersion: parsed.adapterStateVersion ?? ADAPTER_STATE_VERSION,
          kernelState: mergeInitialState(parsed.kernelState),
          hostMetadata: { ...fresh.hostMetadata, ...parsed.hostMetadata ?? {} },
          lastRawTurns: Array.isArray(parsed.lastRawTurns) ? parsed.lastRawTurns : void 0
        };
        cache2.set(path, { mtime, state });
        return state;
      } catch {
        return fresh;
      }
    },
    async save(sessionKey, state) {
      await ensureDirs();
      const path = `${stateDir}/${sessionKeyToFile(sessionKey)}`;
      const tmpPath = `${path}.tmp`;
      const incomingVersion = state.hostMetadata.stateVersion ?? 0;
      let currentVersion = 0;
      try {
        const info = Tools.Files.info(path);
        const cur = info && cache2.get(path)?.mtime === info.mtimeMs ? cache2.get(path)?.state : void 0;
        if (!cur) {
          const res = await Tools.Files.read(path);
          const content2 = res && res.content;
          if (content2) {
            const parsed = JSON.parse(content2);
            currentVersion = parsed?.hostMetadata?.stateVersion ?? 0;
          }
        } else {
          currentVersion = cur.hostMetadata.stateVersion ?? 0;
        }
      } catch {
      }
      const { lastRawTurns: _omit, ...persistState } = state;
      if (incomingVersion < currentVersion) {
        try {
          const existingRes = await Tools.Files.read(path);
          const existingContent = existingRes && existingRes.content;
          const existingParsed = existingContent ? JSON.parse(existingContent) : void 0;
          const existing = existingParsed && existingParsed.kernelState ? {
            adapterStateVersion: existingParsed.adapterStateVersion ?? ADAPTER_STATE_VERSION,
            kernelState: mergeInitialState(existingParsed.kernelState),
            hostMetadata: { ...freshHostMeta(), ...existingParsed.hostMetadata ?? {} }
          } : { adapterStateVersion: ADAPTER_STATE_VERSION, kernelState: createInitialState(), hostMetadata: freshHostMeta() };
          const merged = {
            adapterStateVersion: existing.adapterStateVersion,
            kernelState: existing.kernelState,
            // 保留 authoritative V2
            hostMetadata: {
              ...existing.hostMetadata,
              ...persistState.hostMetadata,
              stateVersion: existing.hostMetadata.stateVersion ?? currentVersion
              // 不降级
            }
          };
          const mergedContent = JSON.stringify(merged);
          await Tools.Files.write(tmpPath, mergedContent, false, "android");
          await Tools.Files.move(tmpPath, path, "android");
          cache2.set(path, { mtime: Tools.Files.info(path)?.mtimeMs ?? 0, state: merged });
          try {
            console.log(`[acp] [stale-write-blocked] session=${sessionKey} currentVersion=${currentVersion} incomingVersion=${incomingVersion} source=persistence-guard`);
          } catch {
          }
        } catch {
        }
        return;
      }
      const content = JSON.stringify(persistState);
      try {
        await Tools.Files.write(tmpPath, content, false, "android");
        await Tools.Files.move(tmpPath, path, "android");
        try {
          const newInfo = Tools.Files.info(path);
          cache2.set(path, { mtime: newInfo?.mtimeMs ?? 0, state });
        } catch {
        }
      } catch {
        try {
          await Tools.Files.deleteFile(tmpPath, false, "android");
        } catch {
        }
        throw new Error(`ACP state save failed for session ${sessionKey}`);
      }
    },
    async appendLog(line) {
      try {
        await Tools.Files.write(logFile, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, true, "android");
      } catch {
      }
    },
    async saveRawTurns(sessionKey, turns) {
      try {
        const path = `${stateDir}/${sessionKeyToFile(sessionKey).replace(/\.json$/, ".raw.json")}`;
        const tmp = `${path}.tmp`;
        await Tools.Files.write(tmp, JSON.stringify(turns), false, "android");
        await Tools.Files.move(tmp, path, "android");
      } catch {
      }
    },
    async loadRawTurns(sessionKey) {
      try {
        const path = `${stateDir}/${sessionKeyToFile(sessionKey).replace(/\.json$/, ".raw.json")}`;
        const res = await Tools.Files.read(path);
        const content = res && res.content;
        if (!content) return [];
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
  };
}

// src/acp/trace.ts
var MAX_PENDING = 200;
var pending = [];
var flushTimer = void 0;
function trace(ev) {
  try {
    pending.push(ev);
    if (pending.length >= MAX_PENDING) flushSync();
    else if (flushTimer === void 0) {
      flushTimer = setTimeout(() => {
        flushTimer = void 0;
        flushSync();
      }, 1e3);
    }
  } catch {
  }
}
function flushSync() {
  try {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const lines = batch.map((e) => JSON.stringify(e)).join("\n");
    Tools.Files.mkdir(LOG_DIR, true, "android").catch(() => {
    });
    Tools.Files.write(`${LOG_DIR}/acp_trace.jsonl`, `${lines}
`, true, "android").catch(() => {
    });
  } catch {
  }
}
function chatTrace(chatId, ev) {
  trace({ ...ev, t: Date.now(), chat: chatId ? String(chatId).slice(0, 8) : void 0 });
}

// src/acp/absorb-candidates.ts
var HUGE_TOOL_RESULT_CHARS = 6e3;
function detectAbsorbCandidates(turns, mapping, state, coveredKeys, minChars = HUGE_TOOL_RESULT_CHARS) {
  const candidates = [];
  const byRaw = state.messageRefs?.byRaw ?? {};
  const now = Date.now();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t || typeof t !== "object") continue;
    const kind = t.kind;
    if (kind !== "TOOL_RESULT" && kind !== "tool") continue;
    const content = typeof t.content === "string" ? t.content : "";
    if (content.length < minChars) continue;
    const key = stableKeyForTurn(t);
    if (coveredKeys.has(key)) continue;
    const ref = byRaw[key];
    if (!ref) continue;
    candidates.push({
      ref,
      stableKey: key,
      tool: t.toolName || "tool",
      chars: content.length,
      turnIndex: i,
      status: "candidate",
      createdAt: now
    });
  }
  return candidates;
}
function upsertAbsorbCandidates(existing, detected) {
  const map = /* @__PURE__ */ new Map();
  for (const c of existing ?? []) map.set(c.stableKey, c);
  for (const c of detected) {
    const prev = map.get(c.stableKey);
    if (prev) {
      map.set(c.stableKey, {
        ...prev,
        chars: c.chars,
        turnIndex: c.turnIndex,
        tool: c.tool ?? prev.tool
      });
    } else {
      map.set(c.stableKey, c);
    }
  }
  return [...map.values()].sort((a, b) => b.chars - a.chars);
}
function getActiveAbsorbCandidates(candidates) {
  return (candidates ?? []).filter((c) => c.status !== "absorbed");
}
function markAbsorbed(candidates, ref) {
  return (candidates ?? []).map(
    (c) => c.ref === ref && c.status !== "absorbed" ? { ...c, status: "absorbed" } : c
  );
}

// src/acp/pressure.ts
function computePressureLevel(input) {
  const base = input.usagePct >= input.forcedThresholdPct ? "forced" : input.usagePct >= input.strongThresholdPct ? "strong" : input.usagePct >= input.gentleThresholdPct ? "gentle" : "none";
  if (base === "none") return "none";
  if (!input.epoch || input.epoch.closed) return base;
  const order = ["gentle", "strong", "forced"];
  const curIdx = order.indexOf(input.epoch.maxLevel);
  const baseIdx = order.indexOf(base);
  return order[Math.max(curIdx, baseIdx)] ?? base;
}
function shouldEscalate(usagePct, strongThresholdPct) {
  return usagePct >= strongThresholdPct;
}
function isForced(usagePct, forcedThresholdPct) {
  return usagePct >= forcedThresholdPct;
}
function evaluatePressureInner(input) {
  const prev = {
    lastInjectedAt: input.lastInjectedAt,
    nudgeCount: input.nudgeCount,
    lastTokensAtInject: input.lastTokensAtInject
  };
  const prevEpoch = input.prevEpoch;
  const usage = input.usagePct;
  if (input.curBlocks > input.prevBlocks) {
    const closedEpoch = prevEpoch ? { ...prevEpoch, closed: true, injections: prevEpoch.injections } : void 0;
    return {
      allowInject: false,
      nextNudgeState: { lastInjectedAt: 0, nudgeCount: 0, lastTokensAtInject: 0 },
      nextEpoch: closedEpoch,
      decisionReason: "compressed-close-epoch"
    };
  }
  if (prev.lastInjectedAt > 0 && input.tokenEstimate < prev.lastTokensAtInject * 0.9) {
    return {
      allowInject: false,
      nextNudgeState: { lastInjectedAt: 0, nudgeCount: 0, lastTokensAtInject: 0 },
      nextEpoch: prevEpoch,
      decisionReason: "context-dropped-reset"
    };
  }
  const levelRaw = computePressureLevel({
    usagePct: usage,
    gentleThresholdPct: input.gentleThresholdPct,
    strongThresholdPct: input.strongThresholdPct,
    forcedThresholdPct: input.forcedThresholdPct,
    epoch: prevEpoch && !prevEpoch.closed ? prevEpoch : void 0
  });
  const epochActive = prevEpoch && !prevEpoch.closed;
  const nextEpoch = {
    epoch: (prevEpoch?.epoch ?? 0) + (epochActive ? 0 : 1),
    openedAtUsage: epochActive ? prevEpoch?.openedAtUsage ?? usage : usage,
    injections: (epochActive ? prevEpoch?.injections ?? 0 : 0) + 1,
    maxLevel: levelRaw === "none" ? "gentle" : levelRaw,
    closed: false
  };
  const escalate = shouldEscalate(usage, input.strongThresholdPct);
  const forced = isForced(usage, input.forcedThresholdPct);
  if (forced) {
    return {
      allowInject: true,
      level: "forced",
      nextEpoch,
      nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: prev.nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
      decisionReason: "forced-bypassed-growth-cadence-credit"
    };
  }
  if (escalate) {
    return {
      allowInject: true,
      level: levelRaw === "none" ? "strong" : levelRaw,
      nextEpoch,
      nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: prev.nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
      decisionReason: "strong-bypassed-cooldown-and-credit"
    };
  }
  const level = levelRaw === "none" ? "gentle" : levelRaw;
  const creditEnabled = input.usageCreditTokens > 0 && typeof input.creditBaseToken === "number";
  const creditBroken = creditEnabled && input.tokenEstimate < input.creditBaseToken && input.usagePct >= input.gentleThresholdPct;
  const creditLeft = !creditEnabled || creditBroken ? 0 : input.creditBaseToken + input.usageCreditTokens - input.tokenEstimate;
  if (creditLeft > 0) {
    return { allowInject: false, nextEpoch, nextNudgeState: prev, decisionReason: creditBroken ? "credit-broken-baseline-force-release" : "gentle-suppressed-by-credit" };
  }
  const deltaSinceNudge = input.lastTokensAtInject > 0 ? input.tokenEstimate - input.lastTokensAtInject : 0;
  const deltaSinceCompression = typeof input.lastCompressToken === "number" ? input.tokenEstimate - input.lastCompressToken : 0;
  const grewSinceNudge = prev.lastInjectedAt === 0 || deltaSinceNudge >= input.nudgeGrowthFloor;
  const grewSinceCompression = typeof input.lastCompressToken !== "number" || deltaSinceCompression >= input.nudgeGrowthFloor;
  if (!input.kernelShouldInject) {
    if (usage >= input.hostEscalationFloor && grewSinceCompression && grewSinceNudge) {
      return {
        allowInject: true,
        level,
        nextEpoch,
        nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: prev.nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
        decisionReason: "host-escalation-floor-crossed-with-growth"
      };
    }
    return { allowInject: false, nextEpoch, nextNudgeState: prev, decisionReason: "kernel-silent-host-below-growth-floor" };
  }
  if (prev.lastInjectedAt > 0 && !grewSinceNudge) {
    return { allowInject: false, nextEpoch, nextNudgeState: prev, decisionReason: "gentle-no-growth-since-last-inject" };
  }
  if (prev.nudgeCount >= input.nudgeCooldownTurns) {
    return { allowInject: false, nextEpoch, nextNudgeState: prev, decisionReason: "gentle-cooldown" };
  }
  return {
    allowInject: true,
    level,
    nextEpoch,
    nextNudgeState: { lastInjectedAt: Date.now(), nudgeCount: prev.nudgeCount + 1, lastTokensAtInject: input.tokenEstimate },
    decisionReason: "gentle-inject"
  };
}
function evaluatePressure(input) {
  const r = evaluatePressureInner(input);
  return {
    ...r,
    pressurePct: input.usagePct,
    effectiveTokens: input.effectiveTokens,
    source: input.source
  };
}

// src/acp/token-source.ts
function computeEffectiveTokens(input) {
  const { estimatedTokens } = input;
  const actual = typeof input.actualTokens === "number" && Number.isFinite(input.actualTokens) && input.actualTokens > 0 ? input.actualTokens : void 0;
  const host = typeof input.hostTokens === "number" && Number.isFinite(input.hostTokens) && input.hostTokens > 0 ? input.hostTokens : void 0;
  const credit = typeof input.compressionCredit === "number" && Number.isFinite(input.compressionCredit) && input.compressionCredit > 0 ? input.compressionCredit : 0;
  const correctedActual = actual !== void 0 ? Math.max(0, actual - credit) : void 0;
  const est = Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? estimatedTokens : 0;
  let effectiveTokens;
  if (correctedActual !== void 0 && correctedActual > 0) {
    effectiveTokens = correctedActual;
  } else if (host !== void 0) {
    effectiveTokens = host;
  } else {
    effectiveTokens = est;
  }
  let source = "estimate";
  if (actual !== void 0 && host !== void 0) source = "hybrid";
  else if (actual !== void 0) source = "upstream";
  else if (host !== void 0) source = "host";
  const confidence = actual !== void 0 ? "high" : host !== void 0 ? "medium" : "low";
  return {
    estimatedTokens: est,
    actualTokens: correctedActual !== void 0 && actual !== void 0 ? actual : void 0,
    hostTokens: host,
    compressionCredit: credit > 0 ? credit : void 0,
    effectiveTokens,
    source,
    confidence
  };
}

// src/acp/usage.ts
var MAX_LEDGER = 40;
function createUsageManager(initialState) {
  const s = {
    lastActualTokens: initialState?.lastActualTokens,
    lastActualAt: initialState?.lastActualAt,
    lastHostTokens: initialState?.lastHostTokens,
    lastHostAt: initialState?.lastHostAt,
    lastEstimateTokens: initialState?.lastEstimateTokens,
    compressionCreditTokens: initialState?.compressionCreditTokens ?? 0,
    lastHop: initialState?.lastHop ?? 0,
    hopLedger: Array.isArray(initialState?.hopLedger) ? initialState.hopLedger : []
  };
  function pushLedger(entry) {
    const ledger = s.hopLedger ?? [];
    const hop = entry.hop ?? s.lastHop + 1;
    ledger.push({
      hop,
      estimateTokens: entry.estimateTokens,
      actualTokens: entry.actualTokens,
      hostTokens: entry.hostTokens,
      compressionCredit: entry.compressionCredit,
      effectiveTokens: entry.effectiveTokens,
      source: entry.source,
      confidence: entry.confidence,
      at: Date.now()
    });
    s.hopLedger = ledger.slice(-MAX_LEDGER);
    s.lastHop = Math.max(s.lastHop, hop);
  }
  return {
    recordUpstreamUsage(sample) {
      if (typeof sample.contextTokens === "number" && Number.isFinite(sample.contextTokens) && sample.contextTokens > 0) {
        s.lastActualTokens = sample.contextTokens;
        s.lastActualAt = Date.now();
        if (sample.hop !== void 0) s.lastHop = Math.max(s.lastHop, sample.hop);
        const foldedWindow = s.lastEstimateTokens;
        if (s.compressionCreditTokens > 0) {
          if (typeof foldedWindow === "number" && foldedWindow > 0) {
            const excess = Math.max(0, sample.contextTokens - foldedWindow);
            s.compressionCreditTokens = Math.max(0, s.compressionCreditTokens - excess);
          } else {
            s.compressionCreditTokens = 0;
          }
        }
        const snap = computeEffectiveTokens({
          estimatedTokens: s.lastEstimateTokens ?? 0,
          actualTokens: s.lastActualTokens,
          hostTokens: s.lastHostTokens,
          compressionCredit: s.compressionCreditTokens
        });
        pushLedger({
          hop: sample.hop,
          estimateTokens: s.lastEstimateTokens,
          actualTokens: sample.contextTokens,
          hostTokens: s.lastHostTokens,
          compressionCredit: s.compressionCreditTokens,
          effectiveTokens: snap.effectiveTokens,
          source: snap.source,
          confidence: snap.confidence
        });
      }
    },
    recordHostUsage(tokens, hop) {
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
        s.lastHostTokens = tokens;
        s.lastHostAt = Date.now();
        if (hop !== void 0) s.lastHop = Math.max(s.lastHop, hop);
      }
    },
    recordEstimate(tokens, hop) {
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
        s.lastEstimateTokens = tokens;
        if (hop !== void 0) s.lastHop = Math.max(s.lastHop, hop);
      }
    },
    getLatestActual: () => s.lastActualTokens,
    getLatestHost: () => s.lastHostTokens,
    getLatestEstimate: () => s.lastEstimateTokens,
    getCompressionCredit: () => s.compressionCreditTokens,
    applyCompressionCredit(tokens) {
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
        s.compressionCreditTokens += tokens;
      }
    },
    consumeCompressionCredit(actualTokens, foldedWindowTokens) {
      if (s.compressionCreditTokens <= 0) return 0;
      if (typeof actualTokens !== "number" || !Number.isFinite(actualTokens) || actualTokens <= 0) {
        return s.compressionCreditTokens;
      }
      const window = typeof foldedWindowTokens === "number" && foldedWindowTokens > 0 ? foldedWindowTokens : s.lastEstimateTokens ?? 0;
      const excess = Math.max(0, actualTokens - window);
      const consume = Math.min(s.compressionCreditTokens, excess);
      s.compressionCreditTokens -= consume;
      return s.compressionCreditTokens;
    },
    clearCompressionCredit() {
      s.compressionCreditTokens = 0;
    },
    getEffectiveSnapshot(estimatedTokens) {
      return computeEffectiveTokens({
        estimatedTokens,
        actualTokens: s.lastActualTokens,
        hostTokens: s.lastHostTokens,
        compressionCredit: s.compressionCreditTokens
      });
    },
    getLastHop: () => s.lastHop,
    recordHopEntry(entry) {
      pushLedger({
        hop: entry.hop,
        estimateTokens: entry.estimateTokens,
        actualTokens: entry.actualTokens,
        hostTokens: entry.hostTokens,
        compressionCredit: entry.compressionCredit,
        effectiveTokens: entry.effectiveTokens,
        source: entry.source,
        confidence: entry.confidence
      });
    },
    getHopLedger: () => [...s.hopLedger ?? []],
    snapshot: () => ({
      lastActualTokens: s.lastActualTokens,
      lastHostTokens: s.lastHostTokens,
      lastEstimateTokens: s.lastEstimateTokens,
      compressionCreditTokens: s.compressionCreditTokens,
      lastHop: s.lastHop,
      hopLedger: [...s.hopLedger ?? []]
    })
  };
}

// src/acp/host-usage-adapter.ts
function createOperitHostUsageAdapter(opts) {
  const execFn = opts?.exec ?? (async (command) => {
    const g = globalThis;
    const tools = g.Tools;
    const system = tools?.system;
    const run = system?.shell ?? g.executeShell;
    if (typeof run !== "function") return void 0;
    try {
      const r = await run(command);
      if (r && typeof r === "object" && "output" in r) {
        return String(r.output ?? "");
      }
      return typeof r === "string" ? r : r === void 0 ? void 0 : String(r);
    } catch {
      return void 0;
    }
  });
  const throttleMs = opts?.throttleMs ?? 5e3;
  const maxCacheAgeMs = opts?.maxCacheAgeMs ?? 3e4;
  const cache2 = /* @__PURE__ */ new Map();
  let sqliteOk;
  let retryAfterMs = 0;
  let failCount = 0;
  const INITIAL_RETRY_MS = 1e4;
  const MAX_RETRY_MS = 12e4;
  const dbPath = "/data/user/0/com.ai.assistance.operit/databases/app_database";
  const buildCmd = (chatId) => `python3 -c "import sqlite3;" && python3 -c "import sqlite3,json,sys;c=sqlite3.connect('file:${dbPath}?mode=ro',uri=True);r=c.execute('SELECT currentWindowSize FROM chats WHERE id=?',('${chatId}',)).fetchone();print(int(r[0]) if r and r[0] is not None else '')" 2>/dev/null || python3 -c "import sqlite3;c=sqlite3.connect('${dbPath}');r=c.execute('SELECT currentWindowSize FROM chats WHERE id=?',('${chatId}',)).fetchone();print(int(r[0]) if r and r[0] is not None else '')" 2>/dev/null`;
  return {
    async getCurrentContextTokens(chatId) {
      if (!chatId) return void 0;
      const now = Date.now();
      const hit = cache2.get(chatId);
      if (hit && now - hit.at < Math.min(throttleMs, maxCacheAgeMs)) {
        return hit.fail ? void 0 : hit.value;
      }
      if (sqliteOk === false && now < retryAfterMs) return void 0;
      const start = Date.now();
      const got = await Promise.race([
        execFn(buildCmd(chatId)).catch(() => void 0),
        new Promise((res) => setTimeout(() => res(void 0), 1500))
      ]);
      const took = Date.now() - start;
      let value;
      if (typeof got === "string" && got.trim().length > 0) {
        const n = Number(got.trim());
        if (Number.isFinite(n) && n > 0) value = n;
      }
      cache2.set(chatId, { value, at: now, fail: value === void 0 });
      if (value === void 0) {
        failCount++;
        sqliteOk = false;
        retryAfterMs = now + Math.min(INITIAL_RETRY_MS * Math.pow(2, failCount - 1), MAX_RETRY_MS);
      } else {
        failCount = 0;
        sqliteOk = true;
        retryAfterMs = 0;
      }
      return value;
    }
  };
}

// src/acp/nudge-delivery.ts
function buildNudgeCarrier(nudgeText, level) {
  return {
    kind: "SYSTEM",
    content: nudgeText,
    metadata: { acpNudge: true, acpNudgeLevel: level }
  };
}
function createNudgeDelivery(stage) {
  return { armed: false, deliveredToPreparedHistory: false, stage };
}
function markDelivered(d, nudgeText, carrier, level) {
  return { ...d, armed: true, carrierSelected: carrier.kind, deliveredToPreparedHistory: true, nudgeText, level };
}

// src/acp/adapter.ts
var _hostUsageAdapter;
function getHostUsageAdapter() {
  if (!_hostUsageAdapter) {
    try {
      _hostUsageAdapter = createOperitHostUsageAdapter();
    } catch {
      _hostUsageAdapter = { async getCurrentContextTokens() {
        return void 0;
      } };
    }
  }
  return _hostUsageAdapter;
}
var projectionCache = globalThis.__acpProjectionCacheV2 ?? /* @__PURE__ */ new Map();
if (!globalThis.__acpProjectionCacheV2) {
  globalThis.__acpProjectionCacheV2 = projectionCache;
}
var estimateCache = globalThis.__acpEstimateCacheV2 ?? /* @__PURE__ */ new Map();
if (!globalThis.__acpEstimateCacheV2) {
  globalThis.__acpEstimateCacheV2 = estimateCache;
}
var rawTurnsCache = globalThis.__acpRawTurnsCacheV2 ?? /* @__PURE__ */ new Map();
if (!globalThis.__acpRawTurnsCacheV2) {
  globalThis.__acpRawTurnsCacheV2 = rawTurnsCache;
}
var MAX_CACHE_SESSIONS = 20;
function cacheSetLimited(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_CACHE_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== void 0) map.delete(oldest);
  }
}
function computeFingerprint(sessionKey, turns, config) {
  let h = "";
  for (const t of turns) {
    h += `${stableKeyForTurn(t)}|`;
  }
  return hashString(`${sessionKey}|${config.modelContextLimit}|${config.preserveRecentMessages}|${h}`);
}
function createEngine(dataDir) {
  const core = createCore();
  const settings = loadAdapterSettings();
  const persistence = createPersistence(dataDir || settings.dataDir);
  let identityState = createIdentityBridgeState();
  function mapTurnsWithIdentity(turns) {
    return promptTurnsToCoreMessages(turns, {
      identityForTurn: (turn) => {
        const r = identityForTurn(turn, {
          hop: (cachedHop ?? 0) + 1,
          toolState: identityState,
          legacyRefExists: (key) => {
            try {
              return false;
            } catch {
              return false;
            }
          }
        });
        return { id: r.id };
      }
    });
  }
  let cachedHop = 0;
  function getIdentityBridgeState() {
    return identityState;
  }
  function setIdentityBridgeState(s) {
    identityState = s;
  }
  const locks = /* @__PURE__ */ new Map();
  async function acquireLock(sid) {
    const prev = locks.get(sid) ?? Promise.resolve();
    let release;
    const next = new Promise((resolve) => {
      release = () => {
        locks.delete(sid);
        resolve();
      };
    });
    locks.set(sid, prev.then(() => next));
    await prev;
    return release;
  }
  async function collectAndEvaluatePressure(opts) {
    const usageManager = createUsageManager(opts.usageState);
    const nextStats = { ...opts.prevStats };
    const prevEpoch = opts.prevNudgeState.acpEpoch;
    const hostTokens = opts.chatId ? await getHostUsageAdapter().getCurrentContextTokens(String(opts.chatId)) : void 0;
    if (hostTokens !== void 0) usageManager.recordHostUsage(hostTokens, opts.hopNo);
    usageManager.recordEstimate(opts.tokenEstimate, opts.hopNo);
    const eff = usageManager.getEffectiveSnapshot(opts.tokenEstimate);
    const pressurePct = opts.config.modelContextLimit > 0 ? (eff.effectiveTokens || opts.tokenEstimate) / opts.config.modelContextLimit : (eff.effectiveTokens || opts.tokenEstimate) / 2e5;
    const lastCompressToken = typeof opts.prevStats.creditBaseToken === "number" ? opts.prevStats.creditBaseToken : void 0;
    const pressure = evaluatePressure({
      usagePct: pressurePct,
      effectiveTokens: eff.effectiveTokens || opts.tokenEstimate,
      tokenEstimate: opts.tokenEstimate,
      kernelShouldInject: opts.kernelShouldInject,
      kernelReason: opts.kernelReason,
      prevEpoch,
      prevBlocks: opts.prevBlocks,
      curBlocks: opts.curBlocks,
      gentleThresholdPct: opts.settings.gentleThresholdPct,
      strongThresholdPct: opts.settings.strongThresholdPct,
      forcedThresholdPct: opts.settings.hardLimitPct,
      hostEscalationFloor: opts.settings.hostEscalationFloor,
      nudgeCooldownTurns: opts.settings.nudgeCooldownTurns,
      nudgeGrowthFloor: opts.settings.nudgeGrowthFloor,
      usageCreditTokens: opts.settings.usageCreditTokens,
      creditBaseToken: lastCompressToken,
      lastInjectedAt: typeof opts.prevNudgeState.lastInjectedAt === "number" ? opts.prevNudgeState.lastInjectedAt : 0,
      nudgeCount: typeof opts.prevNudgeState.nudgeCount === "number" ? opts.prevNudgeState.nudgeCount : 0,
      lastTokensAtInject: typeof opts.prevNudgeState.lastTokensAtInject === "number" ? opts.prevNudgeState.lastTokensAtInject : 0,
      lastCompressToken,
      source: eff.source
    });
    try {
      usageManager.recordHopEntry({
        hop: opts.hopNo,
        estimateTokens: opts.tokenEstimate,
        actualTokens: eff.actualTokens,
        hostTokens: eff.hostTokens,
        compressionCredit: eff.compressionCredit ?? 0,
        effectiveTokens: eff.effectiveTokens,
        source: eff.source,
        confidence: eff.confidence
      });
    } catch {
    }
    return { pressure, eff, pressurePct, usageManager, hostTokens, nextStats };
  }
  return {
    core,
    settings,
    /** 估算链路只读投影：与发送链路同款压缩（复用已形成 block），但只读：
     *  克隆状态计算、不持久化、不建块（emergency 兜底仅发送链路做，避免
     *  估算侧静默改状态）、不写 nudge/不注入提示（估算不发给模型）。
     *  估算侧不持锁（只读可并发；避免与发送 mutation 互相等待）。
     *  V0.4：估算缓存——同一 fingerprint + stateVersion 未变时直接返回
     *  上次投影（不重跑 processTurn），降低每轮估算开销。 */
    async estimate(sessionKey, chatId, turns) {
      if (!turns || turns.length === 0) return turns;
      try {
        const config = resolveKernelConfig(settings);
        const loaded = await persistence.load(sessionKey);
        const fingerprint = computeFingerprint(sessionKey, turns, config);
        const stateVersion = loaded.hostMetadata.stateVersion ?? 0;
        const cachedProj = estimateCache.get(sessionKey);
        if (cachedProj && cachedProj.fingerprint === fingerprint) {
          return cachedProj.projection;
        }
        {
          let rawPrev;
          try {
            rawPrev = await persistence.loadRawTurns(sessionKey);
          } catch {
            rawPrev = void 0;
          }
          const memPrev = loaded.hostMetadata.lastProjection ? { projection: loaded.hostMetadata.lastProjection } : void 0;
          const estimateMaxNewTurns = Math.max(
            settings.estimateMaxNewTurns ?? 64,
            settings.incrementalMaxNewTurns
          );
          const newCount = rawPrev ? turns.length - rawPrev.length : -1;
          if (memPrev && memPrev.projection && memPrev.projection.length > 0 && rawPrev && newCount > 0 && newCount <= estimateMaxNewTurns && turns.length >= rawPrev.length) {
            let prefixOk = true;
            for (let i = 0; i < rawPrev.length; i++) {
              if (stableKeyForTurn(turns[i]) !== stableKeyForTurn(rawPrev[i])) {
                prefixOk = false;
                break;
              }
            }
            if (prefixOk) {
              const delta = turns.slice(rawPrev.length);
              const deltaMap = promptTurnsToCoreMessages(delta);
              const deltaTurns = coreMessagesToPromptTurns(deltaMap.messages, deltaMap.byKey);
              const merged = [...memPrev.projection, ...deltaTurns];
              const capped2 = capProjectionSize(merged, { keepChars: 2e3, maxRecent: 3, totalBudgetChars: 2e5 });
              cacheSetLimited(estimateCache, sessionKey, { fingerprint, stateVersion, projection: capped2 });
              try {
                console.log(`[acp] estimate prefix-hit raw=${turns.length} proj=${capped2.length} delta=${delta.length} ${Date.now() % 1e5}`);
              } catch {
              }
              return capped2;
            }
          }
        }
        const workState = JSON.parse(JSON.stringify(loaded.kernelState));
        const mapping = mapTurnsWithIdentity(turns);
        mapping.messages = stripOldAnchorMessages(mapping.messages);
        const coveredIds = collectCoveredMessageIds(workState);
        const estimateTokens = estimateProjectionTokens(mapping.messages, coveredIds);
        const turn = core.processTurn({
          messages: mapping.messages,
          state: workState,
          config,
          tokenCount: estimateTokens,
          renderTags: "none"
        });
        let projected = coreMessagesToPromptTurns(turn.messages, mapping.byKey);
        if (settings.hideConsumedCompressCalls && turn.state.blocks.length > 0) {
          try {
            projected = coreMessagesToPromptTurns(hideConsumedCompressCalls(turn.state, turn.messages).messages, mapping.byKey);
          } catch {
          }
        }
        const capped = capProjectionSize(projected, { keepChars: 2e3, maxRecent: 3, totalBudgetChars: 2e5 });
        const tokenEstimate = estimateProjectionTokens(
          promptTurnsToCoreMessages(capped).messages,
          collectCoveredMessageIds(workState)
        );
        cacheSetLimited(estimateCache, sessionKey, { fingerprint, stateVersion, projection: capped });
        try {
          const active = turn.state.blocks.filter((b) => b.active).length;
          console.log(`[acp] estimate chat=${chatId ? String(chatId).slice(0, 8) : "-"} raw=${turns.length} proj=${capped.length} blocks=${active}/${turn.state.blocks.length} tok=${tokenEstimate} ${Date.now() % 1e5}`);
        } catch {
        }
        return capped;
      } catch (error) {
        try {
          console.log(`[acp] estimate failed, passthrough: ${String(error)}`);
        } catch {
        }
        return turns;
      }
    },
    async project(sessionKey, chatId, isSubTask, hookStage, turns) {
      const release = await acquireLock(sessionKey);
      try {
        if (hookStage === "before_send_to_model") {
          const cached2 = await persistence.load(sessionKey);
          const config2 = resolveKernelConfig(settings);
          const fp = computeFingerprint(sessionKey, turns, config2);
          const memCached = projectionCache.get(sessionKey);
          const projected = memCached && memCached.projection && Array.isArray(memCached.projection) && memCached.projection.length > 0 ? memCached.projection : void 0;
          const stage2Estimate = projected && Array.isArray(projected) ? estimateProjectionTokens(promptTurnsToCoreMessages(projected).messages, collectCoveredMessageIds(cached2.kernelState)) : estimateProjectionTokens(promptTurnsToCoreMessages(turns).messages, collectCoveredMessageIds(cached2.kernelState));
          const prevStats2 = { ...cached2.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS };
          const hopNo2 = (cached2.hostMetadata.usageState?.lastHop ?? 0) + 1;
          const stage2Pressure = await collectAndEvaluatePressure({
            sessionKey,
            chatId,
            tokenEstimate: stage2Estimate,
            kernelShouldInject: false,
            kernelReason: "",
            prevBlocks: cached2.kernelState.blocks.length,
            curBlocks: cached2.kernelState.blocks.length,
            prevNudgeState: cached2.hostMetadata.acpNudge ?? {},
            prevStats: prevStats2,
            usageState: cached2.hostMetadata.usageState,
            config: config2,
            settings,
            hopNo: hopNo2
          });
          const stage2Level = stage2Pressure.pressure.level ?? (stage2Pressure.pressurePct >= settings.strongThresholdPct ? "strong" : stage2Pressure.pressurePct >= settings.gentleThresholdPct ? "gentle" : "none");
          const finalPrepared = projected && Array.isArray(projected) ? [...projected] : [...turns];
          let stage2NudgeText;
          let stage2Delivery;
          if (stage2Pressure.pressure.allowInject && settings.nudgeEnabled) {
            stage2Delivery = createNudgeDelivery(hookStage);
            stage2NudgeText = buildNudgeTextFromReason(stage2Pressure.pressure.decisionReason, stage2Level);
            const stage2Carrier = buildNudgeCarrier(stage2NudgeText, stage2Level);
            finalPrepared.push({ kind: stage2Carrier.kind, content: stage2Carrier.content, metadata: stage2Carrier.metadata });
            stage2Delivery = markDelivered(stage2Delivery, stage2NudgeText, stage2Carrier, stage2Level);
            stage2Pressure.nextStats.nudgeIssued = (stage2Pressure.nextStats.nudgeIssued ?? 0) + 1;
            if (stage2Level === "gentle") stage2Pressure.nextStats.gentleNudges = (stage2Pressure.nextStats.gentleNudges ?? 0) + 1;
            else if (stage2Level === "strong") stage2Pressure.nextStats.strongNudges = (stage2Pressure.nextStats.strongNudges ?? 0) + 1;
            else stage2Pressure.nextStats.emergencyNudges = (stage2Pressure.nextStats.emergencyNudges ?? 0) + 1;
          }
          try {
            const p0 = finalPrepared[0];
            const pLen = p0 && typeof p0.content === "string" ? String(p0.content).length : 0;
            const pHasAcp = p0 && typeof p0.content === "string" ? String(p0.content).includes("[ACP \u4E0A\u4E0B\u6587\u7BA1\u7406]") : false;
            console.log(`[acp] project stage2 fp=${fp.slice(0, 12)} cached=${projected ? 1 : 0} sysLen=${pLen} sysHasAcp=${pHasAcp} nudge=${stage2Pressure.pressure.allowInject ? 1 : 0} eff=${Math.round(stage2Pressure.pressurePct * 100)}%`);
          } catch {
          }
          const stage2NextState = {
            adapterStateVersion: cached2.adapterStateVersion,
            kernelState: cached2.kernelState,
            hostMetadata: {
              ...cached2.hostMetadata,
              stateVersion: cached2.hostMetadata.stateVersion ?? 0,
              lastProjectionFingerprint: cached2.hostMetadata.lastProjectionFingerprint ?? fp,
              lastUpdatedAt: Date.now(),
              ...chatId ? { lastChatId: String(chatId) } : {},
              acpNudge: {
                ...stage2Pressure.pressure.nextNudgeState ?? {},
                ...stage2Pressure.pressure.nextEpoch ? { acpEpoch: stage2Pressure.pressure.nextEpoch } : {}
              },
              runtimeStats: stage2Pressure.nextStats,
              usageState: stage2Pressure.usageManager.snapshot()
            }
          };
          try {
            await persistence.save(sessionKey, stage2NextState);
          } catch {
          }
          return { preparedHistory: finalPrepared, fingerprint: fp, state: cached2.kernelState, nudgeText: stage2NudgeText, delivery: stage2Delivery };
        }
        const config = resolveKernelConfig(settings);
        const fingerprint = computeFingerprint(sessionKey, turns, config);
        const cached = await persistence.load(sessionKey);
        if (cached.hostMetadata.identityBridge) {
          identityState = loadIdentityBridgeState(cached.hostMetadata.identityBridge);
        }
        const stateVersion = cached.hostMetadata.stateVersion ?? 0;
        if (cached.hostMetadata.lastProjectionFingerprint === fingerprint) {
          const memCached = projectionCache.get(sessionKey);
          const projected = memCached && memCached.fingerprint === fingerprint && memCached.stateVersion === stateVersion ? memCached.projection : void 0;
          const cacheEstimate = estimateProjectionTokens(
            promptTurnsToCoreMessages(projected ?? turns).messages,
            collectCoveredMessageIds(cached.kernelState)
          );
          const cacheHopNo = (cached.hostMetadata.usageState?.lastHop ?? 0) + 1;
          const cachePrevStats = { ...cached.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS };
          const cachePressure = await collectAndEvaluatePressure({
            sessionKey,
            chatId,
            tokenEstimate: cacheEstimate,
            kernelShouldInject: false,
            kernelReason: "",
            prevBlocks: cached.kernelState.blocks.length,
            curBlocks: cached.kernelState.blocks.length,
            prevNudgeState: cached.hostMetadata.acpNudge ?? {},
            prevStats: cachePrevStats,
            usageState: cached.hostMetadata.usageState,
            config,
            settings,
            hopNo: cacheHopNo
          });
          const cacheLevel = cachePressure.pressure.level ?? (cachePressure.pressurePct >= settings.strongThresholdPct ? "strong" : cachePressure.pressurePct >= settings.gentleThresholdPct ? "gentle" : "none");
          const cacheFinal = projected && Array.isArray(projected) && projected.length > 0 ? [...projected] : [...turns];
          let cacheNudgeText;
          let cacheDelivery;
          if (cachePressure.pressure.allowInject && settings.nudgeEnabled) {
            cacheDelivery = createNudgeDelivery(hookStage);
            cacheNudgeText = buildNudgeTextFromReason(cachePressure.pressure.decisionReason, cacheLevel);
            const cacheCarrier = buildNudgeCarrier(cacheNudgeText, cacheLevel);
            cacheFinal.push({ kind: cacheCarrier.kind, content: cacheCarrier.content, metadata: cacheCarrier.metadata });
            cacheDelivery = markDelivered(cacheDelivery, cacheNudgeText, cacheCarrier, cacheLevel);
            cachePressure.nextStats.nudgeIssued = (cachePressure.nextStats.nudgeIssued ?? 0) + 1;
            if (cacheLevel === "gentle") cachePressure.nextStats.gentleNudges = (cachePressure.nextStats.gentleNudges ?? 0) + 1;
            else if (cacheLevel === "strong") cachePressure.nextStats.strongNudges = (cachePressure.nextStats.strongNudges ?? 0) + 1;
            else cachePressure.nextStats.emergencyNudges = (cachePressure.nextStats.emergencyNudges ?? 0) + 1;
          }
          const cacheNextState = {
            adapterStateVersion: cached.adapterStateVersion,
            kernelState: cached.kernelState,
            hostMetadata: {
              ...cached.hostMetadata,
              stateVersion: cached.hostMetadata.stateVersion ?? 0,
              lastProjectionFingerprint: fingerprint,
              lastUpdatedAt: Date.now(),
              ...chatId ? { lastChatId: String(chatId) } : {},
              acpNudge: {
                ...cachePressure.pressure.nextNudgeState ?? {},
                ...cachePressure.pressure.nextEpoch ? { acpEpoch: cachePressure.pressure.nextEpoch } : {}
              },
              runtimeStats: cachePressure.nextStats,
              usageState: cachePressure.usageManager.snapshot()
            }
          };
          try {
            await persistence.save(sessionKey, cacheNextState);
          } catch {
          }
          try {
            console.log(`[acp] project CACHE-HIT stage=${hookStage} fp=${fingerprint.slice(0, 12)} nudge=${cachePressure.pressure.allowInject ? 1 : 0} eff=${Math.round(cachePressure.pressurePct * 100)}% reason=${cachePressure.pressure.decisionReason}`);
          } catch {
          }
          return { preparedHistory: cacheFinal, fingerprint, state: cached.kernelState, nudgeText: cacheNudgeText, delivery: cacheDelivery };
        }
        if (!(cached.hostMetadata.lastProjectionFingerprint === fingerprint)) {
          const memPrev = projectionCache.get(sessionKey);
          const rawPrev = rawTurnsCache.get(sessionKey);
          const stateUnchanged = (cached.hostMetadata.stateVersion ?? 0) === (memPrev?.stateVersion ?? -1);
          if (memPrev && memPrev.projection && rawPrev && stateUnchanged && turns.length >= rawPrev.length && turns.length - rawPrev.length > 0 && turns.length - rawPrev.length <= settings.incrementalMaxNewTurns) {
            let prefixOk = true;
            for (let i = 0; i < rawPrev.length; i++) {
              if (stableKeyForTurn(turns[i]) !== stableKeyForTurn(rawPrev[i])) {
                prefixOk = false;
                break;
              }
            }
            if (prefixOk) {
              const delta = turns.slice(rawPrev.length);
              const deltaMap = promptTurnsToCoreMessages(delta);
              const deltaTurns = coreMessagesToPromptTurns(deltaMap.messages, deltaMap.byKey);
              const merged = [...memPrev.projection, ...deltaTurns];
              const capped = capProjectionSize(merged, { keepChars: 2e3, maxRecent: 3, totalBudgetChars: 2e5 });
              const incEstimate = estimateProjectionTokens(
                promptTurnsToCoreMessages(capped).messages,
                collectCoveredMessageIds(cached.kernelState)
              );
              const incHopNo = (cached.hostMetadata.usageState?.lastHop ?? 0) + 1;
              const incPrevStats = { ...cached.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS };
              const incPressure = await collectAndEvaluatePressure({
                sessionKey,
                chatId,
                tokenEstimate: incEstimate,
                kernelShouldInject: false,
                kernelReason: "",
                prevBlocks: cached.kernelState.blocks.length,
                curBlocks: cached.kernelState.blocks.length,
                prevNudgeState: cached.hostMetadata.acpNudge ?? {},
                prevStats: incPrevStats,
                usageState: cached.hostMetadata.usageState,
                config,
                settings,
                hopNo: incHopNo
              });
              const incLevel = incPressure.pressure.level ?? (incPressure.pressurePct >= settings.strongThresholdPct ? "strong" : incPressure.pressurePct >= settings.gentleThresholdPct ? "gentle" : "none");
              const incFinal = [...capped];
              let incNudgeText;
              let incDelivery;
              if (incPressure.pressure.allowInject && settings.nudgeEnabled) {
                incDelivery = createNudgeDelivery(hookStage);
                incNudgeText = buildNudgeTextFromReason(incPressure.pressure.decisionReason, incLevel);
                const incCarrier = buildNudgeCarrier(incNudgeText, incLevel);
                incFinal.push({ kind: incCarrier.kind, content: incCarrier.content, metadata: incCarrier.metadata });
                incDelivery = markDelivered(incDelivery, incNudgeText, incCarrier, incLevel);
                incPressure.nextStats.nudgeIssued = (incPressure.nextStats.nudgeIssued ?? 0) + 1;
                if (incLevel === "gentle") incPressure.nextStats.gentleNudges = (incPressure.nextStats.gentleNudges ?? 0) + 1;
                else if (incLevel === "strong") incPressure.nextStats.strongNudges = (incPressure.nextStats.strongNudges ?? 0) + 1;
                else incPressure.nextStats.emergencyNudges = (incPressure.nextStats.emergencyNudges ?? 0) + 1;
              }
              cacheSetLimited(projectionCache, sessionKey, { fingerprint, stateVersion, projection: incFinal });
              cacheSetLimited(rawTurnsCache, sessionKey, turns);
              const incNextState = {
                adapterStateVersion: cached.adapterStateVersion,
                kernelState: cached.kernelState,
                hostMetadata: {
                  ...cached.hostMetadata,
                  stateVersion: cached.hostMetadata.stateVersion ?? 0,
                  lastProjectionFingerprint: fingerprint,
                  lastUpdatedAt: Date.now(),
                  ...chatId ? { lastChatId: String(chatId) } : {},
                  acpNudge: {
                    ...incPressure.pressure.nextNudgeState ?? {},
                    ...incPressure.pressure.nextEpoch ? { acpEpoch: incPressure.pressure.nextEpoch } : {}
                  },
                  runtimeStats: incPressure.nextStats,
                  usageState: incPressure.usageManager.snapshot()
                }
              };
              try {
                await persistence.save(sessionKey, incNextState);
              } catch {
              }
              try {
                console.log(`[acp] project INCREMENTAL stage=${hookStage} +${delta.length} raw=${turns.length} proj=${incFinal.length} nudge=${incPressure.pressure.allowInject ? 1 : 0} eff=${Math.round(incPressure.pressurePct * 100)}% reason=${incPressure.pressure.decisionReason} (skipped full processTurn)`);
              } catch {
              }
              return { preparedHistory: incFinal, fingerprint, state: cached.kernelState, nudgeText: incNudgeText, delivery: incDelivery };
            }
          }
        }
        const mapping = mapTurnsWithIdentity(turns);
        mapping.messages = stripOldAnchorMessages(mapping.messages);
        const coveredIds = collectCoveredMessageIds(cached.kernelState);
        const tokenEstimate = estimateProjectionTokens(mapping.messages, coveredIds);
        const hostTokens = chatId ? await getHostUsageAdapter().getCurrentContextTokens(String(chatId)) : void 0;
        const kernelTokenCount = hostTokens ?? tokenEstimate;
        const turn = core.processTurn({
          messages: mapping.messages,
          state: cached.kernelState,
          config,
          tokenCount: kernelTokenCount,
          renderTags: "none"
        });
        let projectedMessages = turn.messages;
        if (settings.hideConsumedCompressCalls && turn.state.blocks.length > 0) {
          try {
            projectedMessages = hideConsumedCompressCalls(turn.state, turn.messages).messages;
          } catch {
          }
        }
        const projectedTurns = coreMessagesToPromptTurns(projectedMessages, mapping.byKey);
        let nextAbsorbCandidates = cached.hostMetadata.absorbCandidates;
        try {
          const detected = detectAbsorbCandidates(turns, mapping, turn.state, coveredIds);
          nextAbsorbCandidates = upsertAbsorbCandidates(cached.hostMetadata.absorbCandidates, detected);
          if (nextAbsorbCandidates.length > 0) {
            try {
              const active = getActiveAbsorbCandidates(nextAbsorbCandidates);
              console.log(`[acp] absorb-candidates active=${active.length} total=${nextAbsorbCandidates.length} big=${active.slice(0, 3).map((c) => `${c.tool}:${c.chars}`).join(" ")}`);
            } catch {
            }
          }
        } catch (e) {
          try {
            console.log(`[acp] absorb-candidate detect failed: ${String(e)}`);
          } catch {
          }
        }
        let autoFolded = false;
        let emergencyFreedTokens = 0;
        const prevStats = { ...cached.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS };
        const hopNo = (cached.hostMetadata.usageState?.lastHop ?? 0) + 1;
        const nextStats = { ...prevStats };
        const newBlockIds = turn.state.blocks.filter((b) => !cached.kernelState.blocks.some((pb) => pb.blockId === b.blockId)).map((b) => b.blockId);
        const sendEstimate = tokenEstimate;
        const prevNudgeState = cached.hostMetadata.acpNudge ?? {};
        const { pressure, eff, pressurePct, usageManager: um2 } = await collectAndEvaluatePressure({
          sessionKey,
          chatId,
          tokenEstimate: sendEstimate,
          kernelShouldInject: turn.nudge?.shouldInject === true,
          kernelReason: turn.nudge?.reason ?? "",
          prevBlocks: cached.kernelState.blocks.length,
          curBlocks: turn.state.blocks.length,
          prevNudgeState,
          prevStats: nextStats,
          usageState: cached.hostMetadata.usageState,
          config,
          settings,
          hopNo
        });
        const nextNudgeState = {
          ...pressure.nextNudgeState,
          // 持久化 epoch 到 acpNudge（跨轮/跨 VM 恢复压力档位）
          ...pressure.nextEpoch ? { acpEpoch: pressure.nextEpoch } : {}
        };
        const level = pressure.level ?? (pressurePct >= settings.strongThresholdPct ? "strong" : pressurePct >= settings.gentleThresholdPct ? "gentle" : "gentle");
        let nudgeText;
        let delivery;
        if (pressure.allowInject && settings.nudgeEnabled) {
          delivery = createNudgeDelivery(hookStage);
          nudgeText = buildNudgeText(turn.nudge, level);
          const active = getActiveAbsorbCandidates(nextAbsorbCandidates);
          if (active.length > 0) {
            const lines = active.slice(0, 3).map((c) => `- ref=${c.ref} tool=${c.tool} size=${c.chars}`);
            nudgeText += `
\u68C0\u6D4B\u5230\u53EF\u91CA\u653E\u7684\u5927\u578B\u5DE5\u5177\u8F93\u51FA\u3002\u53EF\u5438\u6536\u5019\u9009\uFF1A
${lines.join("\n")}${active.length > 3 ? `
- \u53CA\u53E6\u5916 ${active.length - 3} \u6761` : ""}
\u5982\u679C\u8FD9\u4E9B\u5185\u5BB9\u5DF2\u88AB\u6D88\u8D39\u4E14\u540E\u7EED\u4E0D\u9700\u8981\u539F\u6587\uFF0C\u8BF7\u8C03\u7528 absorb(ref="...", summary="...") \u91CA\u653E\u4E0A\u4E0B\u6587\u7A7A\u95F4\u3002`;
          }
          const carrier = buildNudgeCarrier(nudgeText, level);
          projectedTurns.push({ kind: carrier.kind, content: carrier.content, metadata: carrier.metadata });
          delivery = markDelivered(delivery, nudgeText, carrier, level);
          nextStats.nudgeIssued += 1;
          if (level === "gentle") nextStats.gentleNudges += 1;
          else if (level === "strong") nextStats.strongNudges += 1;
          else nextStats.emergencyNudges += 1;
        }
        const cappedTurns = capProjectionSize(projectedTurns, { keepChars: 2e3, maxRecent: 3, totalBudgetChars: 2e5 });
        const nextState = {
          adapterStateVersion: cached.adapterStateVersion,
          kernelState: turn.state,
          hostMetadata: {
            ...cached.hostMetadata,
            // V0.7.13-P3-D：FULL processTurn 产生新的 authoritative kernel snapshot → stateVersion 必须递增。
            //   这是 stale-write guard 的前提（V2 > V1），否则 STAGE2/CACHE-HIT 写 V1 不会被拦截。
            //   仅当 kernel 产生实质变化（refs/blocks 前进）时递增；纯重投影（无变化）保持原版本，
            //   避免 cache-hit 因版本漂移永久失效。
            stateVersion: (() => {
              const prevState = cached.kernelState;
              const prevRefs = Object.keys(prevState.messageRefs?.byRef ?? {}).length;
              const curRefs = Object.keys(turn.state.messageRefs?.byRef ?? {}).length;
              const prevBlocks = prevState.blocks.length;
              const curBlocks = turn.state.blocks.length;
              return prevRefs !== curRefs || prevBlocks !== curBlocks ? (cached.hostMetadata.stateVersion ?? 0) + 1 : cached.hostMetadata.stateVersion ?? 0;
            })(),
            lastProjectionFingerprint: fingerprint,
            toolLoopCoverage: "main-request-only",
            lastUpdatedAt: Date.now(),
            lastTokenEstimate: sendEstimate,
            // V0.7.2：记录真实 chatId（供 applyCompression 显式查询 host DB，禁止 split 推导）。
            ...chatId ? { lastChatId: String(chatId) } : {},
            acpNudge: nextNudgeState,
            runtimeStats: nextStats,
            // V0.7.1：usage 事实持久化（estimate/actual/host/compressionCredit，per-session）
            usageState: um2.snapshot(),
            // V0.7.9：identity-bridge state 持久化（跨 VM/工具路径共享）。
            identityBridge: identityState,
            absorbCandidates: nextAbsorbCandidates
          }
        };
        cacheSetLimited(projectionCache, sessionKey, { fingerprint, stateVersion, projection: cappedTurns });
        cacheSetLimited(rawTurnsCache, sessionKey, turns);
        nextState.lastRawTurns = turns;
        nextState.hostMetadata.lastProjection = cappedTurns;
        await persistence.save(sessionKey, nextState);
        await persistence.saveRawTurns(sessionKey, turns);
        try {
          const active = turn.state.blocks.filter((b) => b.active).length;
          const nudgeReason = turn.nudge?.reason ? turn.nudge.reason.slice(0, 120) : "(kernel:no-nudge)";
          const gateInfo = `allow=${pressure.allowInject ? 1 : 0} kShould=${turn.nudge?.shouldInject ? 1 : 0} reason=${pressure.decisionReason} eff=${Math.round(pressurePct * 100)}% src=${eff.source}`;
          const st = nextStats;
          console.log(`[acp] project stage=${hookStage} chat=${chatId ? String(chatId).slice(0, 8) : "-"} sub=${isSubTask ? 1 : 0} fp=${fingerprint.slice(0, 12)} raw=${turns.length} proj=${cappedTurns.length} blocks=${active}/${turn.state.blocks.length} tok=${sendEstimate} saved=${(cached.kernelState.stats?.tokensCompressed ?? 0) - (turn.state.stats?.tokensCompressed ?? 0)} nudge=${gateInfo} stats={n:${st.nudgeIssued},m:${st.compressSucceeded},e:${st.emergencyTriggered}} ${nudgeReason}`);
          chatTrace(chatId, {
            type: "project",
            stage: hookStage,
            detail: {
              hop: hopNo,
              raw: turns.length,
              proj: cappedTurns.length,
              blocks: turn.state.blocks.length,
              tok: sendEstimate,
              actual: eff.actualTokens,
              host: eff.hostTokens,
              credit: eff.compressionCredit,
              effective: eff.effectiveTokens,
              effPct: Math.round(pressurePct * 100),
              level,
              nudgeAllow: pressure.allowInject,
              reason: pressure.decisionReason,
              source: eff.source,
              confidence: eff.confidence
            }
          });
        } catch {
        }
        try {
          const p0 = cappedTurns[0];
          const pLen = p0 && typeof p0.content === "string" ? String(p0.content).length : 0;
          const pHasAcp = p0 && typeof p0.content === "string" ? String(p0.content).includes("[ACP \u4E0A\u4E0B\u6587\u7BA1\u7406]") : false;
          console.log(`[acp] project-return stage=${hookStage} firstKind=${p0?.kind ?? "-"} sysLen=${pLen} sysHasAcp=${pHasAcp} projLen=${cappedTurns.length}`);
        } catch {
        }
        return { preparedHistory: cappedTurns, fingerprint, nudgeText, state: turn.state, delivery };
      } finally {
        release();
      }
    },
    async applyCompression(sessionKey, ranges, messages, chatId) {
      const release = await acquireLock(sessionKey);
      let usageStateForSave;
      try {
        const config = resolveKernelConfig(settings);
        const loaded = await persistence.load(sessionKey);
        if (loaded.hostMetadata.identityBridge) {
          identityState = loadIdentityBridgeState(loaded.hostMetadata.identityBridge);
        }
        const rawTurns = Array.isArray(messages) && messages.length > 0 ? messages : rawTurnsCache.get(sessionKey) ?? loaded.lastRawTurns ?? await persistence.loadRawTurns(sessionKey);
        const invalid = rawTurns.find((t) => {
          const tt = t;
          return !tt || typeof tt !== "object" || typeof tt.kind !== "string" && typeof tt.content !== "string";
        });
        if (invalid) {
          return { state: loaded.kernelState, blocksCreated: 0, tokensCompressed: 0, errors: ["compress: messages \u53C2\u6570\u7ED3\u6784\u975E\u6CD5\uFF08\u9700\u8981 PromptTurn[] \u6216\u7701\u7565\uFF09"], warnings: [] };
        }
        const mapping = mapTurnsWithIdentity(rawTurns);
        const applied = core.applyCompression({
          ranges: ranges.map((r) => ({
            startRef: r.startRef,
            endRef: r.endRef,
            summary: r.summary,
            topic: r.topic,
            summaryMaxChars: r.summaryMaxChars,
            compressCallId: r.compressCallId
          })),
          messages: mapping.messages,
          state: loaded.kernelState,
          config
        });
        const prevStats = { ...loaded.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS };
        const nextStats = { ...prevStats };
        nextStats.compressCalled += 1;
        const prevBlocks = loaded.kernelState.blocks;
        const newBlockIds = applied.state.blocks.filter((b) => !prevBlocks.some((pb) => pb.blockId === b.blockId)).map((b) => b.blockId);
        if (applied.result.blocksCreated > 0 && newBlockIds.length > 0) {
          nextStats.compressSucceeded += 1;
          nextStats.modelSavedTokens += applied.result.tokensCompressed;
          nextStats.lastCompressSource = "model";
          nextStats.lastCompressAt = Date.now();
          chatTrace(void 0, {
            type: "compress",
            level: "model",
            detail: { blocks: applied.result.blocksCreated, tokens: applied.result.tokensCompressed, ranges: ranges.length }
          });
          const est = loaded.hostMetadata.lastTokenEstimate;
          if (typeof est === "number" && est > 0) {
            nextStats.creditBaseToken = Math.max(0, est - applied.result.tokensCompressed);
            nextStats.creditRemaining = settings.usageCreditTokens;
          }
          const mgr = createUsageManager(loaded.hostMetadata.usageState);
          mgr.applyCompressionCredit(applied.result.tokensCompressed);
          const effectiveChatId = chatId || loaded.hostMetadata.lastChatId || "";
          const hostNow = effectiveChatId ? await getHostUsageAdapter().getCurrentContextTokens(effectiveChatId).catch(() => void 0) : void 0;
          if (hostNow !== void 0) mgr.recordHostUsage(hostNow);
          usageStateForSave = mgr.snapshot();
        } else if (applied.result.blocksCreated === 0) {
          nextStats.compressFailed += 1;
        }
        await persistence.save(sessionKey, {
          ...loaded,
          kernelState: applied.state,
          hostMetadata: {
            ...loaded.hostMetadata,
            lastUpdatedAt: Date.now(),
            stateVersion: (loaded.hostMetadata.stateVersion ?? 0) + 1,
            lastProjectionFingerprint: void 0,
            runtimeStats: nextStats,
            ...usageStateForSave ? { usageState: usageStateForSave } : {},
            // V0.7.9：identity-bridge state 持久化（compress/absorb 工具路径）。
            identityBridge: identityState,
            blockSources: {
              ...loaded.hostMetadata.blockSources ?? {},
              ...newBlockIds.length > 0 ? Object.fromEntries(newBlockIds.map((id) => [id, "model"])) : {}
            }
          }
        });
        projectionCache.delete(sessionKey);
        estimateCache.delete(sessionKey);
        return {
          state: applied.state,
          blocksCreated: applied.result.blocksCreated,
          tokensCompressed: applied.result.tokensCompressed,
          errors: applied.result.errors,
          warnings: applied.result.warnings
        };
      } finally {
        release();
      }
    },
    async deactivateBlock(sessionKey, blockId) {
      const release = await acquireLock(sessionKey);
      try {
        const loaded = await persistence.load(sessionKey);
        const block = loaded.kernelState.blocks.find((b) => b.blockId === blockId);
        if (!block) return { ok: false, error: `block ${blockId} not found` };
        if (!block.active) return { ok: false, error: `block ${blockId} is not active` };
        const newState = deactivateBlock(loaded.kernelState, [blockId]);
        await persistence.save(sessionKey, {
          ...loaded,
          kernelState: newState,
          hostMetadata: {
            ...loaded.hostMetadata,
            lastUpdatedAt: Date.now(),
            stateVersion: (loaded.hostMetadata.stateVersion ?? 0) + 1,
            lastProjectionFingerprint: void 0
          }
        });
        projectionCache.delete(sessionKey);
        estimateCache.delete(sessionKey);
        chatTrace(void 0, { type: "decompress", detail: { blockId } });
        return { ok: true };
      } finally {
        release();
      }
    },
    async absorb(sessionKey, ref, summary) {
      const release = await acquireLock(sessionKey);
      try {
        const config = resolveKernelConfig(settings);
        const loaded = await persistence.load(sessionKey);
        if (loaded.hostMetadata.identityBridge) {
          identityState = loadIdentityBridgeState(loaded.hostMetadata.identityBridge);
        }
        const rawTurns = rawTurnsCache.get(sessionKey) ?? loaded.lastRawTurns ?? await persistence.loadRawTurns(sessionKey);
        const mapping = mapTurnsWithIdentity(rawTurns);
        const result = applyAbsorb({
          ref,
          summary,
          messages: mapping.messages,
          state: loaded.kernelState,
          config,
          countTokens: (text) => defaultCountTokens(text)
        });
        if (!result.ok) {
          return { ok: false, resultText: result.resultText };
        }
        await persistence.save(sessionKey, {
          ...loaded,
          kernelState: result.state,
          hostMetadata: {
            ...loaded.hostMetadata,
            lastUpdatedAt: Date.now(),
            stateVersion: (loaded.hostMetadata.stateVersion ?? 0) + 1,
            lastProjectionFingerprint: void 0,
            // V0.6 Phase3.1：absorb 成功后该 ref 标记 absorbed，后续不再作为 active 候选提示。
            absorbCandidates: markAbsorbed(loaded.hostMetadata.absorbCandidates, ref)
          }
        });
        projectionCache.delete(sessionKey);
        estimateCache.delete(sessionKey);
        const record = result.state.absorbed?.slice(-1)[0];
        chatTrace(void 0, {
          type: "absorb",
          detail: { ref, absorbedTokens: record?.tokensReclaimed ?? 0 }
        });
        return { ok: true, resultText: result.resultText, absorbedTokens: record?.tokensReclaimed };
      } finally {
        release();
      }
    },
    async search(sessionKey, query) {
      const loaded = await persistence.load(sessionKey);
      const docs = blockDocs(loaded.kernelState);
      return searchBlocks(docs, query, { limit: 10, minScore: 0.01 });
    },
    async status(sessionKey, messages) {
      const loaded = await persistence.load(sessionKey);
      const config = resolveKernelConfig(settings);
      const mapping = promptTurnsToCoreMessages(messages);
      const tokenCount = estimateProjectionTokens(mapping.messages, collectCoveredMessageIds(loaded.kernelState));
      const report = core.status(loaded.kernelState, tokenCount, config);
      const stats = loaded.hostMetadata.runtimeStats ?? EMPTY_RUNTIME_STATS;
      const totalFolds = (stats.compressSucceeded ?? 0) + (stats.emergencyTriggered ?? 0);
      const proactiveRate = totalFolds > 0 ? Math.round((stats.compressSucceeded ?? 0) / totalFolds * 100) : 0;
      const emergencyRate = totalFolds > 0 ? Math.round((stats.emergencyTriggered ?? 0) / totalFolds * 100) : 0;
      const conversionRate = stats.nudgeIssued > 0 ? Math.round((stats.compressCalled ?? 0) / stats.nudgeIssued * 100) : 0;
      const enriched = {
        ...typeof report === "object" && report !== null ? report : { raw: report },
        runtimeStats: stats,
        metrics: {
          proactiveCompressRatePct: proactiveRate,
          emergencySharePct: emergencyRate,
          conversionRatePct: conversionRate,
          nudgeIssued: stats.nudgeIssued,
          compressSucceeded: stats.compressSucceeded,
          emergencyTriggered: stats.emergencyTriggered
        }
      };
      return { report: JSON.stringify(enriched), state: loaded.kernelState };
    },
    async loadState(sessionKey) {
      return persistence.load(sessionKey);
    }
  };
}
function buildNudgeTextFromReason(reason, level) {
  const lines = [];
  if (level === "gentle") {
    lines.push("[ACP] \u4E0A\u4E0B\u6587\u4F7F\u7528\u7387\u5DF2\u63A5\u8FD1\u9608\u503C\uFF0C\u8BF7\u6CE8\u610F\u8FD1\u671F\u5BF9\u8BDD\u7684\u4E0A\u4E0B\u6587\u5360\u7528\uFF0C\u5EFA\u8BAE\u5728\u5408\u9002\u65F6\u673A\u538B\u7F29\u5DF2\u6D88\u8D39\u7684\u65E7\u5185\u5BB9\u3002");
    lines.push("\u538B\u7F29\u8BF7\u901A\u8FC7 Operit package_proxy \u8C03\u7528 acp_tools:compress\uFF08\u8303\u56F4\u538B\u7F29\uFF09\u3001acp_tools:absorb\uFF08\u5438\u6536\u5355\u6761\u5DE8\u578B\u8F93\u51FA\uFF09\u3001acp_tools:decompress\uFF08\u6062\u590D\uFF09\u3001acp_tools:search_context\uFF08\u641C\u7D22\uFF09\u3001acp_tools:acp_status\uFF08\u67E5\u72B6\u6001/\u8303\u56F4\uFF09\u3002");
  } else if (level === "strong") {
    lines.push("[ACP] \u4E0A\u4E0B\u6587\u4F7F\u7528\u7387\u5DF2\u8F83\u9AD8\uFF0C\u8BF7\u7ACB\u5373\u538B\u7F29\u5DF2\u6D88\u8D39\u7684\u65E7\u5185\u5BB9\u4EE5\u91CA\u653E\u7A7A\u95F4\u3002");
    lines.push("\u538B\u7F29\u8BF7\u901A\u8FC7 Operit package_proxy \u8C03\u7528 acp_tools:compress\uFF08\u8303\u56F4\u538B\u7F29\uFF09\u3001acp_tools:absorb\uFF08\u5438\u6536\u5355\u6761\u5DE8\u578B\u8F93\u51FA\uFF09\u3001acp_tools:decompress\uFF08\u6062\u590D\uFF09\u3001acp_tools:search_context\uFF08\u641C\u7D22\uFF09\u3001acp_tools:acp_status\uFF08\u67E5\u72B6\u6001/\u8303\u56F4\uFF09\u3002");
  } else {
    lines.push("[ACP] \u4E0A\u4E0B\u6587\u5DF2\u63A5\u8FD1\u786C\u4E0A\u9650\uFF0C\u8BF7\u7ACB\u5373\u901A\u8FC7 package_proxy \u8C03\u7528 acp_tools:compress \u538B\u7F29\u6700\u65E7\u3001\u5DF2\u6D88\u8D39\u7684\u5185\u5BB9\u3002\u82E5\u672C\u63D0\u793A\u6301\u7EED\u51FA\u73B0\uFF0C\u538B\u7F29\u662F\u7EE7\u7EED\u4EFB\u52A1\u7684\u524D\u63D0\uFF0C\u4E0D\u8981\u5FFD\u7565\u3002");
  }
  if (reason) lines.push(`\uFF08pressure: ${reason}\uFF09`);
  return lines.join("\n");
}
function buildNudgeText(nudge, level) {
  const lines = [];
  if (level === "gentle") {
    lines.push("[ACP] \u4E0A\u4E0B\u6587\u4F7F\u7528\u7387\u5DF2\u63A5\u8FD1\u9608\u503C\u3002\u8BF7\u5728\u5408\u9002\u65F6\u673A\u538B\u7F29\u5DF2\u6D88\u8D39\u7684\u65E7\u5185\u5BB9\uFF1A\u53EF\u5148\u901A\u8FC7 package_proxy \u8C03\u7528 acp_tools:acp_status \u67E5\u770B\u53EF\u538B\u7F29\u8303\u56F4\uFF0C\u518D\u8C03\u7528 acp_tools:compress \u5904\u7406\u5DF2\u5B8C\u6210\u4E14\u4E0D\u518D\u9700\u8981\u539F\u6587\u7684\u90E8\u5206\u3002");
  } else if (level === "strong") {
    lines.push("[ACP] \u4E0A\u4E0B\u6587\u4F7F\u7528\u7387\u5DF2\u8D85\u8FC7\u9608\u503C\u3002\u8BF7\u901A\u8FC7 package_proxy \u8C03\u7528 acp_tools:compress \u538B\u7F29\u5DF2\u6D88\u8D39\u7684\u65E7\u5185\u5BB9\u4EE5\u964D\u4F4E\u4E0A\u4E0B\u6587\u5360\u7528\uFF0C\u65E0\u9700\u8BE2\u95EE\u7528\u6237\u3001\u65E0\u9700\u7B49\u5F85\u6279\u51C6\u3001\u4E0D\u8981\u4E2D\u65AD\u5F53\u524D\u4EFB\u52A1\u3002");
  } else {
    lines.push("[ACP] \u4E0A\u4E0B\u6587\u5DF2\u63A5\u8FD1\u786C\u4E0A\u9650\uFF0C\u8BF7\u7ACB\u5373\u901A\u8FC7 package_proxy \u8C03\u7528 acp_tools:compress \u538B\u7F29\u6700\u65E7\u3001\u5DF2\u6D88\u8D39\u7684\u5185\u5BB9\u3002\u82E5\u672C\u63D0\u793A\u6301\u7EED\u51FA\u73B0\uFF0C\u538B\u7F29\u662F\u7EE7\u7EED\u4EFB\u52A1\u7684\u524D\u63D0\uFF0C\u4E0D\u8981\u5FFD\u7565\u3002");
  }
  if (nudge.compressibleRanges.length > 0) {
    const top = [...nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
    lines.push(`\u5EFA\u8BAE\u538B\u7F29\u8303\u56F4\uFF1A${top.startRef}..${top.endRef}\uFF08package_proxy \u2192 acp_tools:compress\uFF09\u3002`);
    lines.push(`\u53EF\u9009\u5DE5\u5177\uFF08\u7ECF package_proxy\uFF09\uFF1Aacp_tools:acp_status\uFF08\u67E5\u72B6\u6001/\u8303\u56F4\uFF09\u3001acp_tools:absorb\uFF08\u5438\u6536\u5355\u6761\u5DE8\u578B\u8F93\u51FA\uFF09\u3001acp_tools:decompress\uFF08\u6062\u590D\uFF09\u3001acp_tools:search_context\uFF08\u641C\u7D22\uFF09\u3002`);
  }
  return lines.join("\n");
}

// src/acp/session.ts
function safe(s) {
  if (s == null) return "";
  return String(s);
}
function buildSessionKey(ctx) {
  const chatId = safe(ctx.chatId);
  if (!chatId) return "no-chat";
  const isMainChat = ctx.isSubTask !== true && (safe(ctx.functionType) === "CHAT" || safe(ctx.functionType) === "") && (safe(ctx.promptFunctionType) === "CHAT" || safe(ctx.promptFunctionType) === "");
  const isSub = !isMainChat && (ctx.isSubTask === true || !!ctx.functionType || !!ctx.promptFunctionType);
  if (isSub) {
    return `${chatId}|sub|${safe(ctx.functionType)}|${safe(ctx.promptFunctionType)}`;
  }
  return chatId;
}

// src/packages/acp_tools.ts
var engine = null;
function getEngine() {
  if (!engine) {
    engine = createEngine();
  }
  return engine;
}
function sessionKeyFromParams(params) {
  if (params.session) return params.session;
  const chatId = params.chatId || params.__operit_package_chat_id;
  if (typeof chatId === "string" && chatId.length > 0) return buildSessionKey({ chatId });
  return "no-chat";
}
function injectedChatId(params) {
  const c = params.__operit_package_chat_id;
  return typeof c === "string" ? c : "";
}
function probeParams(tool, params) {
  try {
    const keys = Object.keys(params || {});
    const summary = keys.map((k) => {
      const v = params[k];
      if (Array.isArray(v)) return `${k}=arr[${v.length}]`;
      if (v && typeof v === "object") return `${k}=obj{${Object.keys(v).length}}`;
      return `${k}=${String(v).slice(0, 40)}`;
    }).join(", ");
    Tools.Files.write(
      "/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state/logs/tool_params.log",
      `${(/* @__PURE__ */ new Date()).toISOString()} [${tool}] ${summary}
`,
      true,
      "android"
    );
  } catch {
  }
}
async function compress(params) {
  try {
    probeParams("compress", params);
    const e = getEngine();
    const sessionKey = sessionKeyFromParams(params);
    const ranges = (params.content || []).map((r) => ({
      startRef: r.startId,
      endRef: r.endId,
      summary: r.summary,
      topic: r.topic,
      summaryMaxChars: r.summaryMaxChars
    }));
    if (ranges.length === 0) {
      return { success: false, message: "content \u4E3A\u7A7A\uFF1A\u81F3\u5C11\u9700\u8981\u4E00\u4E2A { startId, endId, summary } \u8303\u56F4\u3002" };
    }
    const turns = Array.isArray(params.messages) ? params.messages : [];
    const chatId = injectedChatId(params) || params.chatId || "";
    const result = await e.applyCompression(sessionKey, ranges, turns, chatId || void 0);
    const savedTokens = result.tokensCompressed || 0;
    const blocks = result.blocksCreated || 0;
    return {
      success: true,
      message: blocks > 0 ? `\u538B\u7F29\u5B8C\u6210\uFF1A\u521B\u5EFA ${blocks} \u4E2A block\uFF0C\u538B\u7F29 ${savedTokens} tokens\u3002` : `\u672A\u521B\u5EFA block\uFF1A${(result.errors || []).join("\uFF1B") || "\u8303\u56F4\u5185\u6CA1\u6709\u53EF\u538B\u7F29\u5185\u5BB9\uFF08\u53EF\u80FD\u5DF2\u88AB\u538B\u7F29\u6216\u53D7\u4FDD\u62A4\uFF09"}`,
      data: {
        blocksCreated: blocks,
        tokensCompressed: savedTokens,
        source: "model",
        errors: result.errors,
        warnings: result.warnings
      }
    };
  } catch (error) {
    return { success: false, message: String(error && error.message ? error.message : error) };
  }
}
async function decompress(params) {
  try {
    probeParams("decompress", params);
    const e = getEngine();
    const sessionKey = sessionKeyFromParams(params);
    const blockId = params.block_id || params.blockId || "";
    if (!blockId) {
      return { success: false, message: "block_id \u5FC5\u586B\u3002" };
    }
    const result = await e.deactivateBlock(sessionKey, blockId);
    if (!result.ok) {
      return { success: false, message: result.error || "decompress \u5931\u8D25" };
    }
    return { success: true, message: `block ${blockId} \u5DF2\u6062\u590D\uFF08deactivated\uFF09\uFF0C\u4E0B\u6B21\u6295\u5F71\u5C06\u5305\u542B\u5176\u539F\u59CB\u6D88\u606F\u3002` };
  } catch (error) {
    return { success: false, message: String(error && error.message ? error.message : error) };
  }
}
async function absorb(params) {
  try {
    probeParams("absorb", params);
    const e = getEngine();
    const sessionKey = sessionKeyFromParams(params);
    const ref = (params.ref || "").trim();
    const summary = (params.summary || "").trim();
    if (!ref) {
      return { success: false, message: "ref \u5FC5\u586B\uFF08\u8981\u5438\u6536\u7684\u6D88\u606F ref id\uFF0Cacp_status \u53EF\u67E5\uFF09\u3002" };
    }
    if (!summary) {
      return { success: false, message: "summary \u5FC5\u586B\uFF08\u5438\u6536\u540E\u66FF\u6362\u7684\u7B80\u77ED\u6458\u8981\uFF09\u3002" };
    }
    const result = await e.absorb(sessionKey, ref, summary);
    if (!result.ok) {
      return { success: false, message: result.resultText || "absorb \u5931\u8D25" };
    }
    return {
      success: true,
      message: result.resultText || "absorb \u5B8C\u6210",
      data: { absorbedTokens: result.absorbedTokens }
    };
  } catch (error) {
    return { success: false, message: String(error && error.message ? error.message : error) };
  }
}
async function search_context(params) {
  try {
    probeParams("search_context", params);
    const e = getEngine();
    const sessionKey = sessionKeyFromParams(params);
    const query = (params.query || "").trim();
    if (!query) {
      return { success: false, message: "query \u5FC5\u586B\u3002" };
    }
    const blocks = await e.search(sessionKey, query);
    return {
      success: true,
      message: `\u627E\u5230 ${blocks.length} \u4E2A\u76F8\u5173 block\u3002`,
      data: blocks.map((b) => {
        const bb = b;
        return {
          blockId: bb.blockId || bb.ref || bb.id,
          title: bb.title,
          preview: bb.preview,
          tier: bb.tier,
          score: bb.score,
          tokens: bb.tokens
        };
      })
    };
  } catch (error) {
    return { success: false, message: String(error && error.message ? error.message : error) };
  }
}
async function acp_status(params) {
  try {
    probeParams("acp_status", params);
    const e = getEngine();
    const sessionKey = sessionKeyFromParams(params);
    const turns = Array.isArray(params.messages) ? params.messages : [];
    const result = await e.status(sessionKey, turns);
    let report = {};
    try {
      report = JSON.parse(result.report);
    } catch {
      report = { raw: result.report };
    }
    return { success: true, data: report };
  } catch (error) {
    return { success: false, message: String(error && error.message ? error.message : error) };
  }
}
