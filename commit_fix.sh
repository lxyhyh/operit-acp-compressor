#!/bin/bash
cd /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin
git add -A
git commit -q -m "fix: 移除 ToolLifecycleHook 注册（宿主不支持导致全工具拦截崩溃）

- registerToolLifecycleHook 后宿主报 IllegalStateException 且不 catch，所有工具调用被拦
- 移除注册，onToolLifecycle 函数保留导出但不注册
- 教训: 宿主把该 hook 当 intercept 阶段调用，当前版本不可用"
git push origin master 2>&1 | tail -2
git log --oneline | head -2