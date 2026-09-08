#!/bin/bash
cd /data/user/0/com.ai.assistance.operit/files/workspace/3f6381da-999a-4511-86b2-bb3837be16c3/operit-acp-plugin
printf '%s\n' \
  "V0.7.9: compress/absorb 工具路径接入 identity-bridge（跨 VM 共享）" \
  "" \
  "- persistence.ts: hostMetadata 增加 identityBridge 字段(可序列化 toolAlignments+seq)" \
  "- adapter.ts: project/applyCompression/absorb 三路径从持久化恢复 identityState 并在保存时写回" \
  "- 修复: 工具路径(独立 runtime)也能复用 project 路径累积的 tool alignments，压缩块 covered id 稳定" \
  > /tmp/cmsg.txt
git add -A && git commit -F /tmp/cmsg.txt --quiet && git log --oneline -1 && git push origin master 2>&1 | tail -2