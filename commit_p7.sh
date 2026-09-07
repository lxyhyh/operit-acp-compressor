#!/bin/bash
cd /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin
git add -A
git commit -q -m "feat: Phase7 增量投影 — 工具循环高频 Hop 免全量重算(O(n^2)->O(delta))

- stateVersion 未变 + 本次 turns 是上次尾部超集(新增<=incrementalMaxNewTurns=8)
  时，复用上次投影 + 追加新增尾部，跳过全量 processTurn/capProjectionSize
- 前缀 stableKey 逐条校验保证正确性；失败回退全量
- 配置 incrementalMaxNewTurns(默认8) 可调
- 解决文档指出的 20-50 Hop 工具循环每 Hop 全量重投影性能问题
- 25/25 测试全绿"
git push origin master 2>&1 | tail -2
git log --oneline | head -2
exit 0