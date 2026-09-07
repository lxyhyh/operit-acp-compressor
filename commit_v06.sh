#!/bin/bash
cd /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin
git add -A
git commit -q -m "feat: 架构级改造（文档 Phase 2/5）— preflight 多轮压缩 + 多 Hop 状态验证

Phase 5 preflight 多轮压缩:
- emergency 时循环压缩(最多5轮), 每轮重新 processTurn 评估 usage,
  直到脱离 emergency 或无可压缩范围, 一次 preflight 可释放多轮
- 替换原\"仅无块时压一次2段\"的弱兜底

Phase 2 多 Hop 状态验证(文档 Test A/B):
- Test B: 同 Session 连续3次压缩 → blocks>=3(复用状态不重建) ✔
- Test A: 跨 Hop processTurn blocks 只增不减 ✔
- 25/25 测试全绿"
git push origin master 2>&1 | tail -2
git log --oneline | head -3
rm -f /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin/commit_fix.sh 2>/dev/null
rm -f /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin/audit_refs.sh 2>/dev/null
exit 0