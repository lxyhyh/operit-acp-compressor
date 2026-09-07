#!/bin/bash
cd /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin
git add -A
git commit -q -m "feat: Phase3.1 巨型TOOL_RESULT候选检测 — 稳定ref + 持久化 + 幂等

- 新增 src/acp/absorb-candidates.ts: AbsorbCandidate 类型(ref/stableKey/tool/chars/turnIndex/status)
- 检测与 nudge 完全解耦: project 内恒执行 detect, 持久化到 hostMetadata.absorbCandidates
- 稳定 ref = kernel messageRefs.byRaw[stableKeyForTurn](m00042), 与 absorb 工具/kernelApplyAbsorb 兼容
- 幂等: 同一 TOOL_RESULT 多 Hop 只一个 candidate(upsert by stableKey)
- 已被 compression block 覆盖的消息跳过(coveredKeys)
- absorb 成功后 markAbsorbed -> 不再作为 active 候选提示
- nudge 只消费候选, 提供可操作 ref 文案(ref/tool/size + absorb 指引)
- 删除旧的 nudge 内联 findHugeToolResults
- 测试: 文档 Test1-5(无nudge检测/多Hop幂等/多candidate/absorb后消失/covered跳过) 30/30 全绿"
git push origin master 2>&1 | tail -2
git log --oneline | head -2
exit 0