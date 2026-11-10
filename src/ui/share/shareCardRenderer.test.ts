import { describe, expect, it } from "vitest";
import { drawShareCard, shareCardHeight, type ShareCardContext } from "./shareCardRenderer";
import { WORDMARK_PATH } from "./brandMark";
import { DEFAULT_SHARE_OPTIONS, SHARE_LONG_MAX_HEIGHT, SHARE_LONG_MIN_HEIGHT, type ShareCardContent } from "./shareCardModel";

/** Records what was drawn; text measures 1em per wide character, half for others. */
function recorder() {
  const texts: string[] = [];
  const paths: string[] = [];
  let images = 0;
  let font = "10px serif";
  const px = () => Number(/([\d.]+)px/.exec(font)?.[1] ?? 10);
  const ctx = {
    save() {}, restore() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, clip() {},
    translate() {}, scale() {},
    fill(path?: unknown) { if (path && typeof path === "object") paths.push((path as { d: string }).d); },
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: [...text].reduce((w, ch) => w + (/[\u0000-ɏ]/.test(ch) ? px() / 2 : px()), 0) } as TextMetrics; },
    drawImage() { images++; },
    get font() { return font; }, set font(v: string) { font = v; },
    fillStyle: "", textAlign: "left", textBaseline: "middle", shadowColor: "", shadowBlur: 0, shadowOffsetY: 0,
  };
  const makePath = (d: string) => ({ d }) as unknown as Path2D;
  return { ctx: ctx as unknown as ShareCardContext, makePath, texts, paths, images: () => images };
}

const content: ShareCardContent = {
  quote: "其实地上本没有路，走的人多了，也便成了路。", note: "小时候背过。", bookTitle: "呐喊", author: "鲁迅", chapter: "故乡", accent: "yellow",
};
const cover = { naturalWidth: 200, naturalHeight: 300 } as unknown as HTMLImageElement;

describe("share card renderer", () => {
  it("draws passage, note, book line, cover and brand by default", () => {
    const r = recorder();
    const result = drawShareCard(r.ctx, content, DEFAULT_SHARE_OPTIONS, { cover }, r.makePath);
    expect(result).toMatchObject({ width: 1080, height: 1440, truncated: false, template: "paper" });
    const all = r.texts.join("");
    expect(all).toContain("其实地上本没有路");
    expect(r.texts).toContain("小时候背过。");
    expect(r.texts).toContain("《呐喊》");
    expect(r.texts).toContain("鲁迅 · 故乡");
    expect(r.images()).toBe(1);
    expect(r.paths).toContain(WORDMARK_PATH);
  });

  it("honours every switch", () => {
    const r = recorder();
    drawShareCard(r.ctx, content, { ...DEFAULT_SHARE_OPTIONS, showNote: false, showCover: false, showChapter: false, showBrand: false }, { cover }, r.makePath);
    expect(r.texts).not.toContain("小时候背过。");
    expect(r.texts).toContain("鲁迅");
    expect(r.images()).toBe(0);
    expect(r.paths).not.toContain(WORDMARK_PATH);
  });

  it("falls back from vertical to paper for Latin text and reports a cut passage", () => {
    const r = recorder();
    const en = drawShareCard(r.ctx, { ...content, quote: "I declare after all there is no enjoyment like reading!", bookTitle: "Pride and Prejudice" },
      { ...DEFAULT_SHARE_OPTIONS, template: "vertical" }, {}, r.makePath);
    expect(en.template).toBe("paper");
    expect(r.texts).toContain("Pride and Prejudice");

    const v = recorder();
    const vertical = drawShareCard(v.ctx, content, { ...DEFAULT_SHARE_OPTIONS, template: "vertical" }, {}, v.makePath);
    expect(vertical.template).toBe("vertical");
    expect(v.texts).toContain("︐");

    const long = recorder();
    const cut = drawShareCard(long.ctx, { ...content, quote: "我冒了严寒，回到相隔二千余里，别了二十余年的故乡去。".repeat(30) },
      { ...DEFAULT_SHARE_OPTIONS, ratio: "1:1" }, {}, long.makePath);
    expect(cut.truncated).toBe(true);
    expect(long.texts.join("")).toContain("……");
  });

  it("grows a long card with its text instead of cutting it (ER-0162)", () => {
    const sentence = "我冒了严寒，回到相隔二千余里，别了二十余年的故乡去。";
    const passage = `${sentence.repeat(20)}\n${sentence.repeat(20)}`;
    const note = "这一段我想全部留下来。".repeat(12);
    const options = { ...DEFAULT_SHARE_OPTIONS, ratio: "long" as const };

    // The same passage is cut on the tallest fixed card.
    const fixed = recorder();
    expect(drawShareCard(fixed.ctx, { ...content, quote: passage }, { ...DEFAULT_SHARE_OPTIONS, ratio: "9:16" }, {}, fixed.makePath).truncated).toBe(true);

    const r = recorder();
    const height = shareCardHeight(r.ctx, { ...content, quote: passage, note }, options);
    const drawn = drawShareCard(r.ctx, { ...content, quote: passage, note }, options, {}, r.makePath);
    expect(drawn).toMatchObject({ width: 1080, height, truncated: false });
    expect(height).toBeGreaterThan(1920);
    const all = r.texts.join("");
    expect(all).not.toContain("……");
    expect(all.split("故乡去。").length - 1).toBe(40);
    // The whole note is on the card, not just three lines of it.
    expect(all.split("这一段我想全部留下来。").length - 1).toBe(12);

    // A short passage still gets a card of a sensible size.
    expect(shareCardHeight(r.ctx, content, options)).toBe(SHARE_LONG_MIN_HEIGHT);
    // Fixed cards report their fixed height.
    expect(shareCardHeight(r.ctx, { ...content, quote: passage }, DEFAULT_SHARE_OPTIONS)).toBe(1440);
  });

  it("stops a long card at its height limit and says the passage was cut", () => {
    const r = recorder();
    const endless = { ...content, quote: "我冒了严寒，回到相隔二千余里，别了二十余年的故乡去。".repeat(200) };
    const drawn = drawShareCard(r.ctx, endless, { ...DEFAULT_SHARE_OPTIONS, ratio: "long" }, {}, r.makePath);
    expect(drawn.height).toBe(SHARE_LONG_MAX_HEIGHT);
    expect(drawn.truncated).toBe(true);
    expect(r.texts.join("")).toContain("……");
  });

  it("draws a long card horizontally even when the vertical look is chosen", () => {
    const r = recorder();
    const drawn = drawShareCard(r.ctx, content, { ...DEFAULT_SHARE_OPTIONS, template: "vertical", ratio: "long" }, {}, r.makePath);
    expect(drawn.template).toBe("paper");
    expect(r.texts).not.toContain("︐");
  });
});
