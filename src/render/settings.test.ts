import { describe, expect, it } from "vitest";
import { arrowKeyDirection, DEFAULT_SETTINGS, effectivePageProgression, normalizePageDirection } from "./settings";

describe("reader settings", () => {
  it("默认关闭下一章预加载", () => {
    expect(DEFAULT_SETTINGS.preloadNextChapter).toBe(false);
  });

  it("翻页方向默认跟随书籍；关闭跟随或强制横排时按从左往右", () => {
    expect(normalizePageDirection(undefined)).toBe("book");
    expect(normalizePageDirection("rtl")).toBe("book");
    const follow = { pageDirection: "book" as const, forceHorizontal: false };
    expect(effectivePageProgression("rtl", follow)).toBe("rtl");
    expect(effectivePageProgression("ltr", follow)).toBe("ltr");
    expect(effectivePageProgression(undefined, follow)).toBe("ltr");
    expect(effectivePageProgression("rtl", { ...follow, pageDirection: "ltr" })).toBe("ltr");
    expect(effectivePageProgression("rtl", { ...follow, forceHorizontal: true })).toBe("ltr");
    // 固定版式不受强制横排影响，仍按书的方向。
    expect(effectivePageProgression("rtl", { ...follow, forceHorizontal: true }, true)).toBe("rtl");
  });

  it("从右到左时只对调左右方向键", () => {
    expect(arrowKeyDirection(1, "ArrowRight", "rtl")).toBe(-1);
    expect(arrowKeyDirection(-1, "ArrowLeft", "rtl")).toBe(1);
    expect(arrowKeyDirection(1, "PageDown", "rtl")).toBe(1);
    expect(arrowKeyDirection(1, " ", "rtl")).toBe(1);
    expect(arrowKeyDirection(1, "ArrowRight", "ltr")).toBe(1);
  });
});
