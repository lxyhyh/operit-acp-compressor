import fs from "node:fs";
const D = "/sdcard/Download/Operit/plugins/com.operit.acp_compressor/acp-state";
const raw = JSON.parse(fs.readFileSync(`${D}/state_d2572685-4a46-4fa0-9cad-eb24e63ccbeb_b1a397618c66.raw.json`, "utf8"));
const callTags = [], resultTags = [];
for (const t of raw) {
  const c = String(t.content ?? "");
  if (t.kind === "TOOL_CALL") { const m = /<tool_([a-zA-Z0-9_]+)\s/.exec(c); if (m) callTags.push(m[1]); }
  else if (t.kind === "TOOL_RESULT") { const m = /<tool_result_([a-zA-Z0-9_]+)\s/.exec(c); if (m) resultTags.push(m[1]); }
}
const callSet = new Set(callTags);
const overlap = resultTags.filter((r) => callSet.has(r));
console.log("CALL:", callTags.length, "RESULT:", resultTags.length, "overlap:", overlap.length);
console.log("RESULT含tool_call_id:", raw.filter((t) => t.kind === "TOOL_RESULT" && String(t.content??"").includes("tool_call_id")).length);
