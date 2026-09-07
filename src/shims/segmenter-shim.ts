/**
 * Intl.Segmenter shim —— QuickJS（Operit 沙盒）无 Intl 全局。
 * acp-kernel 0.0.54 的 search tokenizer 在模块顶层执行
 * `new Intl.Segmenter("zh", { granularity: "word" })`，无 shim 则加载即抛错。
 *
 * 仅实现本项目需要的最小面：granularity "word"/"grapheme" 的分段。
 * CJK 按字符粒度切分（acp-kernel 的 cjkRunTokens 会自行做 bigram 组合），
 * 拉丁词按正则切分。segment() 返回可迭代对象，元素含 { segment, index }。
 */

type SegmenterGranularity = "grapheme" | "word" | "sentence";

interface SegmentData {
    segment: string;
    index: number;
    input: string;
    isWordLike: boolean;
}

class SegmenterShim {
    private granularity: SegmenterGranularity;
    constructor(_locale?: string, options?: { granularity?: SegmenterGranularity }) {
        this.granularity = options?.granularity ?? "grapheme";
    }

    segment(input: string): IterableIterator<SegmentData> {
        const text = String(input ?? "");
        const granularity = this.granularity;
        const out: SegmentData[] = [];
        if (granularity === "word") {
            // 拉丁词与数字：连续 [A-Za-z0-9_'] 为一个词；其余按字符（CJK 每个字一段）
            const re = /[A-Za-z0-9_']+/g;
            let m: RegExpExecArray | null;
            let last = 0;
            while ((m = re.exec(text)) !== null) {
                if (m.index > last) {
                    for (let i = last; i < m.index; i++) {
                        out.push({ segment: text[i], index: i, input: text, isWordLike: false });
                    }
                }
                out.push({ segment: m[0], index: m.index, input: text, isWordLike: true });
                last = m.index + m[0].length;
            }
            for (let i = last; i < text.length; i++) {
                out.push({ segment: text[i], index: i, input: text, isWordLike: false });
            }
        } else {
            // grapheme/sentence 简化：按 Unicode 码点切
            for (const ch of text) {
                out.push({ segment: ch, index: out.length, input: text, isWordLike: false });
            }
        }
        return out[Symbol.iterator]();
    }
}

export function installIntlSegmenter(): void {
    const g = globalThis as any;
    if (typeof g.Intl === "undefined") g.Intl = {};
    if (typeof g.Intl.Segmenter === "undefined") {
        g.Intl.Segmenter = SegmenterShim;
    }
}