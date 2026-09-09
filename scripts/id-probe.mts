// 离线决定性实验：发送链路映射出的 id 集合 vs block.effectiveMessageIds
import { readFileSync } from 'node:fs';
const st = JSON.parse(readFileSync('/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state/state_6f88d3fa-2faf-4646-b6c8-10b66935ac0a_72534ccafbde.json','utf8'));
const covered = new Set<string>();
for (const b of st.kernelState.blocks) if (b.active) for (const id of b.effectiveMessageIds ?? []) covered.add(id);
console.log('covered ids 总数:', covered.size);
console.log('样例:', [...covered].slice(0,3));
// identity-bridge 状态（发送链路 tool seq 的真值）
const ib = st.hostMetadata.identityBridge;
console.log('identityBridge 存在:', !!ib, 'toolAlignments 数:', ib?.toolAlignments ? Object.keys(ib.toolAlignments).length : 0);
