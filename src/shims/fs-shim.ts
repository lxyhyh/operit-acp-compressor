// fs shim：acp-kernel 0.0.66 的 packs.ts 引用 `fs`（读 file:/ pack 源）。
// QuickJS（Operit 沙盒）无 node:fs，且 file: pack 源在插件场景用不上。
// 垫一个调用即抛错的桩；模块顶层引用（readFileSync/readdirSync 解构）给空函数。
export function readFileSync(): never {
    throw new Error("[acp] fs.readFileSync 不可用（QuickJS）：file: pack 源不受支持");
}
export function readdirSync(): never {
    throw new Error("[acp] fs.readdirSync 不可用（QuickJS）：file: pack 源不受支持");
}
