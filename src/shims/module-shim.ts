// module shim：acp-kernel chunk 顶层 `createRequire(import.meta.url)` 仅用于
// 可选 BPE tokenizer 懒加载。QuickJS 无 node:module，垫一个调用即抛的桩。
export function createRequire(): (id: string) => unknown {
    return function requireStub(id: string): never {
        throw new Error(`[acp] module.createRequire 不可用（QuickJS）：无法加载 ${id}`);
    };
}
