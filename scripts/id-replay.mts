// 决定性实验2：用真实 mapTurnsWithIdentity 重放 estimate 链的 turns，量化 id 匹配率
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// 直接 import 编译产物里的 messages.ts 逻辑不可行（需要 ts），用 dist 产物测
// 简化：复刻 promptTurnsToCoreMessages 的 occurrence 后缀逻辑 + identityForTurn 的 content hash
import crypto from 'node:crypto';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const st = JSON.parse(readFileSync('/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state/state_6f88d3fa-2faf-4646-b6c8-10b66935ac0a_72534ccafbde.json','utf8'));
const covered = new Set<string>();
for (const b of st.kernelState.blocks) if (b.active) for (const id of b.effectiveMessageIds ?? []) covered.add(id);

// rawTurnsFile = 发送时 turns（落盘）
const rawPath = '/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state/state_6f88d3fa-2faf-4646-b6c8-10b66935ac0a_72534ccafbde.raw.json';
let turns: any[] = [];
try { const raw = JSON.parse(readFileSync(rawPath,'utf8')); turns = raw.turns ?? raw.lastRawTurns ?? (Array.isArray(raw) ? raw : []); } catch { turns = st.lastRawTurns ?? []; }
console.log('发送时 turns 条数:', turns.length, '(来源: turnsFile 或 lastRawTurns)');

// 复刻 identityForTurn 内容 hash 的 id 生成（user/assistant 路径）
function idOf(turn: any): string {
  const kind = turn.kind;
  if (kind === 'SYSTEM') return 'host:system:content:' + sha(turn.content ?? '');
  if (kind === 'USER') return 'host:user:content:' + sha(turn.content ?? '');
  if (kind === 'ASSISTANT') return 'host:assistant:content:' + sha(turn.content ?? '');
  return 'host:other:' + sha((turn.content ?? '') + (turn.toolName ?? ''));
}
const seen = new Map<string, number>();
let match = 0, miss = 0, missSample: string[] = [];
for (const t of turns) {
  const base = idOf(t);
  const occ = (seen.get(base) ?? 0) + 1;
  seen.set(base, occ);
  const id = occ === 1 ? base : base + '#' + occ;
  if (covered.has(id)) match++; else { miss++; if (missSample.length < 5) missSample.push(id); }
}
console.log('发送turns vs covered: match=', match, 'miss=', miss);
console.log('miss 样例:', missSample);
