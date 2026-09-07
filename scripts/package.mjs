/**
 * 打包为 .toolpkg（ZIP：manifest.json + dist/main.js + ui/...）。
 * 纯 Node 实现，无需系统 zip。
 */

import { createWriteStream, readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// ---- 极简 ZIP（stored + deflate）----
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

async function collectFiles(dir, base) {
    const out = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await collectFiles(full, base)));
        else out.push({ rel: path.relative(base, full), full });
    }
    return out;
}

async function buildZip(entries, outFile) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const { rel, full } of entries) {
        const data = readFileSync(full);
        const nameBuf = Buffer.from(rel.replace(/\\/g, "/"), "utf8");
        const crc = crc32(data);
        const compressed = zlib.deflateRawSync(data);
        const useCompressed = compressed.length < data.length;
        const method = useCompressed ? 8 : 0;
        const stored = useCompressed ? compressed : data;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // flags: utf8
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(stored.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, nameBuf, stored);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(0x0800, 8);
        cen.writeUInt16LE(method, 10);
        cen.writeUInt16LE(0, 12);
        cen.writeUInt16LE(0, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(stored.length, 20);
        cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt16LE(0, 30);
        cen.writeUInt16LE(0, 32);
        cen.writeUInt16LE(0, 34);
        cen.writeUInt16LE(0, 36);
        cen.writeUInt32LE(0, 38);
        cen.writeUInt32LE(offset, 42);
        central.push(cen, nameBuf);
        offset += local.length + nameBuf.length + stored.length;
    }
    const cenStart = offset;
    const cenBuf = Buffer.concat(central.map((b) => (Buffer.isBuffer(b) ? b : b)));
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cenBuf.length, 12);
    eocd.writeUInt32LE(cenStart, 16);
    eocd.writeUInt16LE(0, 20);
    const all = Buffer.concat([...chunks, cenBuf, eocd]);
    mkdirSync(path.dirname(outFile), { recursive: true });
    const ws = createWriteStream(outFile);
    await new Promise((res, rej) => { ws.on("finish", res); ws.on("error", rej); ws.end(all); });
}

async function main() {
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    const version = manifest.version;
    const outFile = path.join(root, "dist", `${manifest.toolpkg_id}-v${version}.toolpkg`);

    // 收集打包文件：manifest.json + dist/main.js + dist/ui/**（UI 相对 dist/main.js 的 require 路径）
    const entries = [];
    const add = (rel) => {
        const full = path.join(root, rel);
        if (existsSync(full) && statSync(full).isFile()) entries.push({ rel, full });
    };
    add("manifest.json");
    add("dist/main.js");
    // subpackage 入口：dist/packages/**（manifest.subpackages[].entry 指向）。
    const pkgDir = path.join(root, "dist", "packages");
    if (existsSync(pkgDir)) {
        const pkgFiles = await collectFiles(pkgDir, path.join(root, "dist"));
        for (const f of pkgFiles) {
            // rel 形如 packages/acp_tools.js（相对 dist）→ zip 内 dist/packages/acp_tools.js
            entries.push({ rel: `dist/${f.rel}`, full: f.full });
        }
    }
    // UI 目录：源在 <root>/ui/**，打包到 zip 内 dist/ui/**（与 main.js 同根，require("./ui/...") 成立）
    const uiDir = path.join(root, "ui");
    if (existsSync(uiDir)) {
        const uiFiles = await collectFiles(uiDir, root);
        for (const f of uiFiles) {
            // rel 形如 ui/settings/index.ui.js → zip 内 dist/ui/settings/index.ui.js
            entries.push({ rel: `dist/${f.rel}`, full: f.full });
        }
    }

    await buildZip(entries, outFile);
    console.log(`packaged -> ${outFile} (${entries.length} files)`);
}

main().catch((e) => { console.error(e); process.exit(1); });