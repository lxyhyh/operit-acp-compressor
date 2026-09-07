/**
 * QuickJS 环境 shim。
 *
 * acp-kernel 0.0.54 在浏览器无关环境运行时有少量 Node 绑定点：
 *  - chunk 顶层 `import { createRequire } from "module"` + `createRequire(import.meta.url)`
 *    （仅用于可选 tokenizer 懒加载，非核心路径；QuickJS 无 module，需剥离/垫空）
 *  - wire/persist 子路径使用 `crypto`（createHash sha256/sha1）与 `process.env`
 *    （本项目主路径不引入 wire/persist，但保留 shim 以备后续需要）
 *
 * 本文件在 esbuild banner 中注入，先于业务代码执行。
 */

// 1) module shim（esbuild platform:"neutral" 不会自动 polyfill node:module，
//    这里在 bundle 外部先定义 createRequire 抛错的替身；esbuild 会把
//    `import { createRequire } from "module"` 保留为 require("module")，
//    因此通过 banner 里的全局变量 + esbuild alias 处理 —— 见 build.mjs）
(globalThis as any).__acp_module_shim = true;

// 2) process.env（部分 acp 代码读 process.env.ACP_REASONING_KEEP）
if (typeof (globalThis as any).process === "undefined") {
    (globalThis as any).process = { env: {} };
}
(globalThis as any).process = (globalThis as any).process || {};
(globalThis as any).process.env = (globalThis as any).process.env || {};
if (!(globalThis as any).process.env.ACP_REASONING_KEEP) {
    (globalThis as any).process.env.ACP_REASONING_KEEP = "0";
}

// 3) import.meta.url（esbuild neutral 产物在 QuickJS 内无 import.meta，
//    createRequire 用法会被 build.mjs 的注入垫掉，无需 url）
export {};
