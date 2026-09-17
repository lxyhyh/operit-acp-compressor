/**
 * 构建：TS 源码 → 单文件 main.js（QuickJS 可执行）。
 *
 * - platform: "neutral"：不注入 node builtin
 * - format: "cjs"：产物为 CommonJS 单文件（宿主 QuickJS 经 module 加载）
 * - 把 `module` 与 `crypto` 重定向到本地 shim（acp-kernel 的 node 绑定点）
 * - banner 预置 process / Intl shim
 * - acp-kernel 是纯 ESM 且用 tsup chunk 分块，esbuild bundle 会内联全部依赖
 *
 * 容器 sandbox 适配（V0.11-A）：esbuild 二进制子进程在 workspace 目录
 * （/root/work/4/operit-acp-compressor）内的 read_dir 被容器策略拒绝，且绝对
 * 路径解析要逐级向上 walk 到根目录（/ 的 read_dir 也被拒）——任何文件系统解析
 * 都会 "Could not resolve"。绕过方案：
 *   1) stdin 入口 + 绝对路径导出（stdin 内容不经过文件系统）；
 *   2) acp-fs-bridge 插件：全部 onResolve/onLoad 由插件接管，用 Node fs
 *      （node 进程权限完整）完成相对/裸包/package.json main 解析并读取文件内容，
 *      esbuild 自身完全不碰文件系统；
 *   3) write: false，产物由 node 进程写回 dist/。
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** 从 TS 源码提取文件头 /* METADATA ... *​/ 块（subpackage 工具声明）。 */
function extractMetadata(sourcePath) {
    const src = readFileSync(sourcePath, "utf8");
    const m = src.match(/\/\* METADATA\n[\s\S]*?\n\}\*\//);
    return m ? m[0] : null;
}

// 公共 banner（main 与 subpackage 共用）：
// - V0.10-B1-M 修复（M11）：banner 先于 esbuild 生成的 "use strict" 执行
//   （banner 恒在输出最顶部），banner 代码实际运行在非严格模式；
//   在 banner 首行显式 "use strict"，保证 shim 代码与产物同处严格模式
//   （对齐原版产物 "use strict" 紧跟顶部的形态）。
const SHIM_BANNER = [
    '"use strict";',
    'var __g = (typeof globalThis !== "undefined") ? globalThis : this;',
    'if (typeof __g.process === "undefined") { __g.process = { env: { ACP_REASONING_KEEP: "0" } }; }',
    'var process = __g.process;',
    'if (typeof __g.Intl === "undefined") { __g.Intl = {}; }',
    'if (typeof __g.Intl.Segmenter === "undefined") {',
    '  var SegmenterShimImpl = function(_locale, options) { this.g = (options && options.granularity) || "grapheme"; };',
    '  SegmenterShimImpl.prototype.segment = function(input) {',
    '    var text = String(input == null ? "" : input);',
    '    var out = [];',
    '    if (this.g === "word") {',
    '      var re = /[A-Za-z0-9_\']+/g; var m; var last = 0;',
    '      while ((m = re.exec(text)) !== null) {',
    '        for (var i = last; i < m.index; i++) out.push({ segment: text[i], index: i, input: text, isWordLike: false });',
    '        out.push({ segment: m[0], index: m.index, input: text, isWordLike: true });',
    '        last = m.index + m[0].length;',
    '      }',
    '      for (var j = last; j < text.length; j++) out.push({ segment: text[j], index: j, input: text, isWordLike: false });',
    '    } else {',
    '      for (var k = 0; k < text.length; k++) out.push({ segment: text[k], index: k, input: text, isWordLike: false });',
    '    }',
    '    return out[Symbol.iterator]();',
    '  };',
    '  __g.Intl.Segmenter = SegmenterShimImpl;',
    '}',
    '',
].join("\n");

/** 把裸 node 内置模块（fs/module/crypto/path）重定向到 src/shims 的本地 shim。 */
function makeShimBridge() {
    const SHIMS = ["fs", "module", "crypto", "path"];
    return {
        name: "acp-fs-bridge",
        setup(build) {
            for (const name of SHIMS) {
                build.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({ path: name, namespace: "shim" }));
                build.onLoad({ filter: new RegExp(`^${name}$`), namespace: "shim" }, () => ({
                    contents: readFileSync(path.join(root, "src/shims", `${name}-shim.ts`), "utf8"),
                    loader: "ts",
                    resolveDir: path.join(root, "src/shims"),
                }));
            }
            // 其余 import 全部由插件用 Node fs 解析（相对路径 / 裸包 / package.json main），
            // esbuild 自身不触碰文件系统（容器 sandbox 限制其 read_dir）。
            build.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind === "entry-point") return null;
                const resolved = resolveByNode(args.path, args.resolveDir);
                if (resolved) return { path: resolved, namespace: "file" };
                return null; // 交给 esbuild 默认解析（external 等）
            });
            build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
                const content = readFileSync(args.path, "utf8");
                return {
                    contents: content,
                    loader: args.path.endsWith(".ts") ? "ts" : "js",
                    resolveDir: path.dirname(args.path),
                };
            });
        },
    };
}

/** 解析一个文件候选：文件本身 / +ext / 目录（package.json main 或 index.js）。 */
function tryFile(cand) {
    if (existsSync(cand)) {
        const st = statSync(cand);
        if (st.isFile()) return cand;
        if (st.isDirectory()) {
            const pj = path.join(cand, "package.json");
            if (existsSync(pj)) {
                try {
                    const main = JSON.parse(readFileSync(pj, "utf8")).main;
                    if (main) {
                        const r = tryFile(path.resolve(cand, main));
                        if (r) return r;
                    }
                } catch { /* 忽略坏 package.json */ }
            }
            const idx = tryFile(path.join(cand, "index.js"));
            if (idx) return idx;
            return undefined;
        }
        return undefined;
    }
    for (const ext of [".ts", ".tsx", ".js", ".json"]) {
        if (existsSync(cand + ext)) return cand + ext;
    }
    return undefined;
}

/** Node 侧路径解析：相对/绝对/裸包（沿目录向上找 node_modules）。 */
function resolveByNode(p, resolveDir) {
    if (p.startsWith("./") || p.startsWith("../")) return tryFile(path.resolve(resolveDir, p));
    if (p.startsWith("/")) return tryFile(p);
    let dir = resolveDir;
    for (;;) {
        const cand = tryFile(path.join(dir, "node_modules", p));
        if (cand) return cand;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** 用 stdin 入口 + 桥接插件构建一个 bundle，产物由 node 写回 outReal。 */
async function buildBundle(entryAbsPath, outReal, entryLabel) {
    const result = await build({
        stdin: {
            contents: `export * from ${JSON.stringify(entryAbsPath)};`,
            sourcefile: `${entryLabel}-entry.ts`,
            loader: "ts",
        },
        bundle: true,
        platform: "neutral",
        format: "cjs",
        target: "es2020",
        write: false,
        plugins: [makeShimBridge()],
        // UI 文件独立打包（Compose DSL 模块），main bundle 保留外部 require
        external: ["./ui/*"],
        banner: {
            js: SHIM_BANNER,
        },
        // main.ts 通过命名空间引用保证内核被内联；tree-shaking 保留被调用符号即可
        treeShaking: true,
        legalComments: "none",
        logLevel: "info",
    });
    const out = result.outputFiles[0];
    if (!out) throw new Error(`buildBundle: no output for ${entryAbsPath}`);
    mkdirSync(path.dirname(outReal), { recursive: true });
    writeFileSync(outReal, out.text, "utf8");
    return out.text;
}

// main bundle
const mainSrc = path.join(root, "src/main.ts");
const mainOut = path.join(root, "dist/main.js");
await buildBundle(mainSrc, mainOut, "main");

// subpackage 工具入口（独立加载：manifest.subpackages[].entry）。
// acp-kernel 为无状态 core，各入口内联一份无副作用（共享 /sdcard 数据目录）。
const pkgOut = path.join(root, "dist/packages/acp_tools.js");
const pkgSrc = path.join(root, "src/packages/acp_tools.ts");
await buildBundle(pkgSrc, pkgOut, "acp_tools");

// 宿主按文件头 /* METADATA ... */ 解析 subpackage 工具声明。
// METADATA 前置到产物最顶部（在 "use strict" 之前；宿主按文件头解析）。
// 构建完成后把源文件 METADATA 块重新写到产物最顶部。
const metadata = extractMetadata(pkgSrc);
if (metadata) {
    const built = readFileSync(pkgOut, "utf8");
    // 避免重复前置（幂等）：产物头部已含 METADATA 则跳过。
    if (!built.startsWith(metadata)) {
        writeFileSync(pkgOut, `${metadata}\n${built}`, "utf8");
    }
} else {
    console.warn("[acp] WARNING: METADATA not found in src/packages/acp_tools.ts");
}

console.log("build done -> dist/main.js + dist/packages/acp_tools.js");
