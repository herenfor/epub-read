import { describe, expect, it } from "vitest";
import { breakLines, breakParagraphs, breakUnits, ellipsize, fitText, fittedBlockSize, verticalGlyph, type Measure } from "./shareLayout";
import { formatShareCitation, splitSentences, takeSentences, tidyPassage } from "./shareText";
import { canUseVertical, resolveAccent, shareCardPalette, shareCardSize } from "./shareCardModel";
import { contrast, coverToneFromPixels, readableTone } from "./coverTone";

/** Wide characters are 1em, everything else half an em. */
const measure: Measure = (text, px) => [...text].reduce((w, ch) => w + (/[\u0000-ɏ]/.test(ch) ? px / 2 : px), 0);

describe("share card line breaking", () => {
  it("never starts a line with closing punctuation or ends one with an opening quote", () => {
    expect(breakUnits("路。「走」")).toEqual(["路。", "「走」"]);
    // 5 characters per line at 10px over 50px.
    const lines = breakLines("其实地上本没有路，走的人多了，也便成了路。", 50, 10, measure);
    for (const line of lines.slice(1)) expect("，。、；：？！）」』".includes(line[0])).toBe(false);
    expect(lines.join("")).toBe("其实地上本没有路，走的人多了，也便成了路。");
    const quoted = breakLines("一二三四「五六」", 40, 10, measure);
    for (const line of quoted) expect(line.endsWith("「")).toBe(false);
  });

  it("keeps Latin words whole, punctuation inside words, and splits only an over-long word", () => {
    const lines = breakLines("don’t split e.g. words", 60, 10, measure);
    expect(lines).toEqual(["don’t split", "e.g. words"]);
    expect(breakLines("abcdefghijklmnop", 40, 10, measure)).toEqual(["abcdefgh", "ijklmnop"]);
    expect(breakLines("第一段\n第二段", 100, 10, measure)).toEqual(["第一段", "第二段"]);
  });

  it("fits the largest size that holds the passage and cuts at the minimum with an ellipsis", () => {
    const short = fitText({ text: "希望是本无所谓有", lineLength: 100, blockSize: 100, lineHeight: 1.5, maxPx: 20, minPx: 10, measure, ellipsis: "……" });
    expect(short).toMatchObject({ fontPx: 20, truncated: false });
    const long = fitText({ text: "我冒了严寒，回到相隔二千余里，别了二十余年的故乡去。".repeat(4), lineLength: 100, blockSize: 45, lineHeight: 1.5, maxPx: 20, minPx: 10, measure, ellipsis: "……" });
    expect(long.truncated).toBe(true);
    expect(long.fontPx).toBe(10);
    expect(long.lines.length).toBe(3);
    expect(long.lines.at(-1)!.endsWith("……")).toBe(true);
    expect(long.lines.at(-1)!).not.toMatch(/[，、]……$/);
    expect(ellipsize("Pride and Prejudice", 55, 10, measure)).toBe("Pride and…");
    expect(ellipsize("Pride", 55, 10, measure)).toBe("Pride");
  });

  it("reports where paragraphs begin and leaves room between them when asked", () => {
    expect(breakParagraphs("第一段很长要换行\n第二段", 50, 10, measure)).toEqual({ lines: ["第一段很长", "要换行", "第二段"], paragraphStarts: [2] });
    const request = { text: "第一段\n第二段\n第三段", lineLength: 100, lineHeight: 1.5, maxPx: 10, minPx: 10, measure, ellipsis: "……" };
    // Three lines of 15 fit in 45; with two paragraph gaps of 5 they need 55.
    expect(fitText({ ...request, blockSize: 45 }).truncated).toBe(false);
    expect(fitText({ ...request, blockSize: 45, paragraphGap: 0.5 }).truncated).toBe(true);
    const roomy = fitText({ ...request, blockSize: 55, paragraphGap: 0.5 });
    expect(roomy).toMatchObject({ truncated: false, paragraphStarts: [1, 2] });
    expect(fittedBlockSize(roomy, 1.5, 0.5)).toBe(55);
  });

  it("draws vertical punctuation with its vertical form", () => {
    expect(["，", "。", "「", "」", "《"].map(verticalGlyph).join("")).toBe("︐︒﹁﹂︽");
    expect(verticalGlyph("路")).toBe("路");
  });
});

describe("share text", () => {
  it("steps by whole sentences and gives back the passage when joined", () => {
    const text = "希望是本无所谓有，无所谓无的。这正如地上的路；其实地上本没有路，走的人多了，也便成了路。";
    expect(splitSentences(text)).toEqual(["希望是本无所谓有，无所谓无的。", "这正如地上的路；", "其实地上本没有路，走的人多了，也便成了路。"]);
    expect(takeSentences(text, 1)).toBe("希望是本无所谓有，无所谓无的。");
    expect(takeSentences(text, 0)).toBe("希望是本无所谓有，无所谓无的。");
    const en = "I declare after all there is no enjoyment like reading! How much sooner one tires of any thing than of a book!";
    expect(splitSentences(en)).toHaveLength(2);
    expect(splitSentences("他说：「走吧。」然后走了。")).toEqual(["他说：「走吧。」", "然后走了。"]);
    expect(tidyPassage("  一  二\n\n 三 ")).toBe("一 二\n三");
  });

  it("formats the citation per language, steps inner quotes down and never names the app", () => {
    const zh = formatShareCitation({ quote: "他说「走吧」。", bookTitle: "呐喊", author: "鲁迅", chapter: "故乡" }, { showChapter: true });
    expect(zh).toBe("「他说『走吧』。」\n—— 鲁迅《呐喊 · 故乡》");
    expect(formatShareCitation({ quote: "路。", bookTitle: "呐喊", chapter: "故乡" }, { showChapter: false })).toBe("「路。」\n—— 《呐喊》");
    const en = formatShareCitation({ quote: "She said “go”.", bookTitle: "Pride and Prejudice", author: "Jane Austen", chapter: "Chapter XI" }, { showChapter: true });
    expect(en).toBe("“She said ‘go’.”\n— Jane Austen, Pride and Prejudice, Chapter XI");
    expect(`${zh}${en}`).not.toMatch(/SeLis/i);
  });
});

describe("share card model and cover tone", () => {
  it("sizes cards at 1080 wide and resolves accents per page tone", () => {
    expect(shareCardSize("3:4")).toEqual({ width: 1080, height: 1440 });
    expect(shareCardSize("9:16").height).toBe(1920);
    expect(resolveAccent("green", false)).toBe("#2f9e5b");
    expect(resolveAccent("green", true)).toBe("#6fd49a");
    expect(resolveAccent("#d9691f", false)).toBe("#d9691f");
    expect(resolveAccent("#000000", true)).toBe("#595959");
    expect(resolveAccent(undefined, false)).toBe("#c29200");
    expect(shareCardPalette("cover", "red", "#2f4a46").bg).toBe("#2f4a46");
    expect(shareCardPalette("cover", "red", null).bg).toBe("#3b3a36");
    expect(canUseVertical("I declare")).toBe(false);
    expect(canUseVertical("希望")).toBe(true);
  });

  it("takes the most common cover colour, skips paper white, and keeps light text readable", () => {
    const px = (r: number, g: number, b: number, n: number) => Array.from({ length: n }, () => [r, g, b, 255]).flat();
    const tone = coverToneFromPixels([...px(250, 250, 250, 50), ...px(80, 130, 120, 30), ...px(200, 40, 40, 10)]);
    expect(tone).not.toBeNull();
    expect(contrast(tone!, "#f4f0e7")).toBeGreaterThanOrEqual(6);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(tone!.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThanOrEqual(b);
    expect(coverToneFromPixels(px(255, 255, 255, 10))).toBeNull();
    expect(contrast(readableTone([255, 230, 0]), "#f4f0e7")).toBeGreaterThanOrEqual(6);
  });
});
