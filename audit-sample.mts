import fs from "node:fs";

const D = "/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state";
const raw = JSON.parse(fs.readFileSync(`${D}/state_d2572685-4a46-4fa0-9cad-eb24e63ccbeb_b1a397618c66.raw.json`, "utf8"));

const calls = raw.filter((t: any) => t.kind === "TOOL_CALL").slice(0, 3);
const results = raw.filter((t: any) => t.kind === "TOOL_RESULT").slice(0, 3);

console.log("=== TOOL_CALL 样例 ===");
for (const c of calls) {
  console.log("toolName:", c.toolName);
  console.log("content:", String(c.content ?? "").slice(0, 500));
  console.log("---");
}
console.log("=== TOOL_RESULT 样例 ===");
for (const r of results) {
  console.log("toolName:", r.toolName);
  console.log("content:", String(r.content ?? "").slice(0, 500));
  console.log("---");
}
