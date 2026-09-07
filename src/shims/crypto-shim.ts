// crypto shim：acp-kernel 的 wire/persist 子路径依赖 node:crypto 的
// createHash(sha256/sha1)。本项目打包只引主入口，但保留纯 JS 实现，
// 避免意外引入子路径时残留 node builtin。
// 纯 JS SHA-256 / SHA-1（FIPS 180）对短字符串足够，仅用于指纹与文件名散列。

function toBytes(s: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
}

function rotr(x: number, n: number): number {
    return (x >>> n) | (x << (32 - n));
}

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Hex(s: string): string {
    const bytes = toBytes(s);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const high = Math.floor(bitLen / 0x100000000);
    for (let i = 3; i >= 0; i--) bytes.push((high >>> (i * 8)) & 0xff);
    for (let i = 7; i >= 0; i--) bytes.push((bitLen >>> (i * 8)) & 0xff);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
        h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let i = 0; i < bytes.length; i += 64) {
        for (let t = 0; t < 16; t++) {
            w[t] = ((bytes[i + t * 4] << 24) | (bytes[i + t * 4 + 1] << 16) |
                (bytes[i + t * 4 + 2] << 8) | bytes[i + t * 4 + 3]) >>> 0;
        }
        for (let t = 16; t < 64; t++) {
            const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
            const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let t = 0; t < 64; t++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    const hex = (v: number) => v.toString(16).padStart(8, "0");
    return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

// SHA-1（FIPS 180-1）——acp-kernel wire 层用 sha1 生成 8-hex 块 key
const SHA1_K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

function sha1Hex(s: string): string {
    const bytes = toBytes(s);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const high = Math.floor(bitLen / 0x100000000);
    for (let i = 3; i >= 0; i--) bytes.push((high >>> (i * 8)) & 0xff);
    for (let i = 7; i >= 0; i--) bytes.push((bitLen >>> (i * 8)) & 0xff);

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Uint32Array(80);

    for (let i = 0; i < bytes.length; i += 64) {
        for (let t = 0; t < 16; t++) {
            w[t] = ((bytes[i + t * 4] << 24) | (bytes[i + t * 4 + 1] << 16) |
                (bytes[i + t * 4 + 2] << 8) | bytes[i + t * 4 + 3]) >>> 0;
        }
        for (let t = 16; t < 80; t++) {
            w[t] = rotr(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let t = 0; t < 80; t++) {
            const f = t < 20 ? ((b & c) | (~b & d)) : t < 40 ? (b ^ c ^ d) : t < 60 ? ((b & c) | (b & d) | (c & d)) : (b ^ c ^ d);
            const temp = (rotr(a, 5) + f + e + SHA1_K[t < 20 ? 0 : t < 40 ? 1 : t < 60 ? 2 : 3] + w[t]) >>> 0;
            e = d; d = c; c = rotr(b, 30); b = a; a = temp;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const hex = (v: number) => v.toString(16).padStart(8, "0");
    return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

export function createHash(algorithm: string): {
    update(data: string | Uint8Array, encoding?: string): { digest(enc?: string): string };
} {
    return {
        update(data: string | Uint8Array, _encoding?: string) {
            const text = typeof data === "string" ? data : Array.from(data as Uint8Array, (b) => String.fromCharCode(b)).join("");
            const hexOut = algorithm.toLowerCase() === "sha1" ? sha1Hex(text) : sha256Hex(text);
            return {
                digest(enc?: string) {
                    return enc === "hex" ? hexOut : hexOut;
                },
            };
        },
    };
}
