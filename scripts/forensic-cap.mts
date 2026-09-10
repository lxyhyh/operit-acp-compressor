// V0.8 二阶段任务一取证：真实请求体逐条分类（cap 截断 vs 摘要 vs 正常）
import { readFileSync } from 'node:fs';
const raw = readFileSync('/tmp/req1533.json', 'utf-8');
// 请求体提取时已含完整 JSON（从第一个 { 到结尾）。找到 messages 数组起止。
const start = raw.indexOf('{');
let body: any = null;
try { body = JSON.parse(raw.slice(start)); } catch { /* 可能尾部有日志残余，逐字符回退 */ }
if (!body) {
  // 回退：宽松提取 "messages": [ ... ] 段
  const ms = raw.indexOf('"messages"');
  console.log('strict parse failed, messages idx =', ms);
  process.exit(0);
}
const msgs = body.messages ?? [];
let truncated = 0, summary = 0, normal = 0, tool = 0, charsTrunc = 0, charsAll = 0;
const samples: string[] = [];
for (const m of msgs) {
  const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  charsAll += c.length;
  if (/\.\.\.\[truncated for context space \(/.test(c)) {
    truncated++; charsTrunc += c.length;
    if (samples.length < 3) samples.push(`${m.role}:${c.slice(0, 60).replace(/\n/g, ' ')}`);
  } else if (/Compressed conversation section/.test(c)) summary++;
  else normal++;
  if (m.role === 'tool') tool++;
}
console.log(JSON.stringify({ totalMsgs: msgs.length, truncated, summary, normal, tool }, null, 1));
console.log('chars all:', charsAll, 'chars in truncated msgs:', charsTrunc, `(${Math.round(charsTrunc / charsAll * 100)}%)`);
console.log('truncated samples:', samples);
