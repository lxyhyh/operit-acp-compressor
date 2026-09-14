// path shim：acp-kernel 0.0.66 的 packs.ts 引用 `path`（拼接 file: pack 路径）。
// QuickJS 无 node:path；仅提供空桩避免 esbuild neutral 平台解析失败。
export function join(..._parts: string[]): string {
    return "";
}
export function resolve(..._parts: string[]): string {
    return "";
}
export const sep = "/";
export default { join, resolve, sep };
