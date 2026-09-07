/**
 * 构建：TS 源码 → 单文件 main.js（QuickJS 可执行）。
 *
 * - platform: "neutral"：不注入 node builtin
 * - format: "iife"：注册入口暴露到 globalThis
 * - 把 `module` 与 `crypto` 重定向到本地 shim（acp-kernel 的 node 绑定点）
 * - banner 预置 process / Intl shim
 * - acp-kernel 是纯 ESM 且用 tsup chunk 分块，esbuild bundle 会内联全部依赖
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** 从 TS 源码提取文件头 /* METADATA ... *​/ 块（subpackage 工具声明）。 */
function extractMetadata(sourcePath) {
    const src = readFileSync(sourcePath, "utf8");
    const m = src.match(/\/\* METADATA\n[\s\S]*?\n\}\*\//);
    return m ? m[0] : null;
}

await build({
    entryPoints: [path.join(root, "src/main.ts")],
    bundle: true,
    platform: "neutral",
    format: "cjs",
    target: "es2020",
    outfile: path.join(root, "dist/main.js"),
    absWorkingDir: root,
    // acp-kernel 顶层 `import { createRequire } from "module"`：重定向到 shim
    alias: {
        module: path.join(root, "src/shims/module-shim.ts"),
        crypto: path.join(root, "src/shims/crypto-shim.ts"),
    },
    // neutral 平台下 import.meta.url 无意义，createRequire 调用会抛错（仅懒加载 tokenizer 用）
    // UI 文件独立打包（Compose DSL 模块），main bundle 保留外部 require
    external: ["./ui/*"],
    banner: {
        js: [
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
        ].join("\n"),
    },
    // main.ts 通过命名空间引用保证内核被内联；tree-shaking 保留被调用符号即可
    treeShaking: true,
    legalComments: "none",
    logLevel: "info",
});

// subpackage 工具入口（独立加载：manifest.subpackages[].entry）。
// acp-kernel 为无状态 core，各入口内联一份无副作用（共享 /sdcard 数据目录）。
const pkgOut = path.join(root, "dist/packages/acp_tools.js");
const pkgSrc = path.join(root, "src/packages/acp_tools.ts");
await build({
    entryPoints: [pkgSrc],
    bundle: true,
    platform: "neutral",
    format: "cjs",
    target: "es2020",
    outfile: pkgOut,
    absWorkingDir: root,
    alias: {
        module: path.join(root, "src/shims/module-shim.ts"),
        crypto: path.join(root, "src/shims/crypto-shim.ts"),
    },
    external: ["./ui/*"],
    banner: {
        js: [
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
        ].join("\n"),
    },
    treeShaking: true,
    // METADATA 是文件头注释，esbuild 会删除；构建后由下方 extractMetadata 重新前置。
    legalComments: "none",
    logLevel: "info",
});

// 宿主按文件头 /* METADATA ... */ 解析 subpackage 工具声明（对齐原版产物：
// "use strict"; 之后紧跟 METADATA）。esbuild banner/legalComments 会移除注释，
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