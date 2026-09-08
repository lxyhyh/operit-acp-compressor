#!/bin/bash
cd /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin
printf '%s\n' \
  "V0.7.8: Adapter Identity Bridge" \
  "" \
  "Phase0 证据(实测): Operit 无稳定 toolCallId(13/1240), CALL/RESULT tag 无交叉引用(overlap=0) → virtual identity" \
  "- src/identity-bridge.ts(新): classifyTurn / identityForTurn / legacyStableKey / virtualToolIdentity / ToolAlignmentState" \
  "- 分层策略: host-anchor → tool-call-id → tool-virtual → acp-summary/nudge → content-fallback → legacy-continuity" \
  "- messages.ts: promptTurnsToCoreMessages 支持注入 identityForTurn(向后兼容)" \
  "- adapter.ts: createEngine 内 identity state + mapTurnsWithIdentity 接线(仅 project 主路径)" \
  "- 测试: 新增 8 项(T1-T5 跨Hop稳定 / C1-C2 collision / classify), 75/75 全绿" \
  "- IDENTITY_BRIDGE=IMPLEMENTED (PARTIAL: legacyRefExists 暂返 false, 待实机验证后启用)" \
  > /tmp/cmsg.txt
git add -A && git commit -F /tmp/cmsg.txt --quiet && git log --oneline -1 && git push origin master 2>&1 | tail -2