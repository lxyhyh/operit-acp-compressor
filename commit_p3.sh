#!/bin/bash
cd /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin
git add -A
git commit -q -m "feat: Phase3 替代 — nudge 检测巨型工具输出并建议 absorb（宿主无 ToolLifecycleHook）

- findHugeToolResults: 扫描 turns 里 >=6k 字符的 TOOL_RESULT
- nudge 注入时若存在巨型输出, 追加 absorb 建议(列出工具名)
- 模型可见后可主动 absorb 已消费的大段工具结果省 token
- 不依赖宿主 ToolLifecycleHook(该 hook 实测不支持)
- 25/25 测试全绿"
git push origin master 2>&1 | tail -2
git log --oneline | head -2
exit 0