// V0.8 九-C 验证：真实请求体 token vs ACP trace 记录
import { readFileSync, writeFileSync } from 'node:fs';
import { countTokensCjk } from '../src/acp/token.ts';

const LOG = '/data/data/com.ai.assistance.operit/files/logs/operit.log';
const lines = readFileSync(LOG, 'utf8').split('\n');

// 找最后一个真实请求块（行首锚定 D/AIService）
let lastStart = -1, M = 0;
for (let i = lines.length - 1; i >= 0; i--) {
  const m = lines[i].match(/^\d{4}-\d{2}-\d{2} [\d:.]+ D\/AIService: Request body:  Part 1\/(\d+): /);
  if (m) { lastStart = i; M = Number(m[1]); break; }
}
if (lastStart < 0) { console.log('NO_REQUEST_FOUND'); process.exit(0); }
const ts = lines[lastStart].slice(0, 23);
console.log('request ts:', ts, ' parts:', M);

// 提取该块所有 part，拼接成完整 JSON 文本（剔除日志前缀）
let body = '';
const re = /^\d{4}-\d{2}-\d{2} [\d:.]+ D\/AIService: Request body:  Part \d+\/\d+: /;
for (let i = lastStart; i < lines.length && body.split('\u0000').length <= M + 2; i++) {
  if (!re.test(lines[i])) continue;
  if (!lines[i].includes(`Part 1/${M}:`) && !lines[i].match(new RegExp(`Part \\d+\\/${M}:`))) continue;
  body += lines[i].replace(re, '');
}
console.log('body chars:', body.length);

// 用插件同款算法计算（countTokensCjk = CJK 1字/字 + 其他 /4）
const tok = countTokensCjk(body);
console.log('requestHistory token (plugin algo):', tok);

// 与 trace 同轮记录对比（找 ts 附近的 project 记录）
const trace = readFileSync('/sdcard/Download/Operit/plugins/com.operit.acp_compressor/logs/acp_trace.jsonl', 'utf8').trim().split('\n');
const tMs = Date.parse(ts.replace(' ', 'T') + '+08:00');
let best: any = null;
for (let i = trace.length - 1; i >= 0; i--) {
  const d = JSON.parse(trace[i]);
  if (d.type !== 'project' || !d.detail?.tok) continue;
  if (Math.abs(d.t - tMs) < 60000) { best = d; break; }
}
if (best) {
  console.log('ACP trace  :', JSON.stringify({hop: best.detail.hop, raw: best.detail.raw, proj: best.detail.proj, tok: best.detail.tok, credit: best.detail.credit, effective: best.detail.effective, source: best.detail.source}));
  console.log('delta(requestBody - ACP tok):', tok - best.detail.tok, `(${((tok - best.detail.tok) / best.detail.tok * 100).toFixed(1)}%)`);
} else {
  console.log('ACP trace: 同轮 project 记录未找到');
}
