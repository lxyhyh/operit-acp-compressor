// V0.8 九-C v2：对指定请求体文件用插件算法计 token，与同会话 trace 对比
import { readFileSync } from 'node:fs';
import { countTokensCjk } from '../src/acp/token.ts';
const body = readFileSync('/tmp/req1533.json', 'utf-8');
// 请求体是 JSON messages 数组的拼接（宿主日志 Part 拼接后即完整 JSON）。
// 提取每个 message 的 text/content 字符串计数（与 estimateProjectionTokens 同口径：只数消息文本）。
let tok = 0;
try {
  const arr = JSON.parse(body);
  const msgs = Array.isArray(arr) ? arr : (arr.messages ?? []);
  for (const m of msgs) {
    const c = m.content ?? m.text ?? '';
    const text = typeof c === 'string' ? c : Array.isArray(c)
      ? c.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('')
      : '';
    tok += countTokensCjk(text);
  }
  console.log('messages:', msgs.length, 'requestHistory token:', tok);
} catch (e) {
  console.log('JSON parse failed, fallback raw text count:', countTokensCjk(body));
}
