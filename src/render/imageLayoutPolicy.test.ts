import { describe, expect, it } from "vitest";
import { imageLayoutPolicy, scrollMediaDefaultsCss } from "./imageLayoutPolicy";

describe("imageLayoutPolicy", () => {
  it("分页 + 整页判定：沿用 fullpage-image 与原有媒体默认值", () => {
    const policy = imageLayoutPolicy({ readingMode: "paginated", paginatedFillEligible: true });
    expect(policy).toEqual({
      viewerClass: "fullpage-image",
      usePaginatedMediaDefaults: true,
      fillPage: true,
    });
  });

  it("分页 + 非整页判定：不加类名，但媒体默认值不变（分页回归基线）", () => {
    const policy = imageLayoutPolicy({ readingMode: "paginated", paginatedFillEligible: false });
    expect(policy).toEqual({
      viewerClass: null,
      usePaginatedMediaDefaults: true,
      fillPage: false,
    });
  });

  it("滚动 + 整页判定：保留 pure-image-page 类名供运行时使用，但不填页、不写分页默认值", () => {
    const policy = imageLayoutPolicy({ readingMode: "scroll", paginatedFillEligible: true });
    expect(policy).toEqual({
      viewerClass: "pure-image-page",
      usePaginatedMediaDefaults: false,
      fillPage: false,
    });
  });

  it("滚动 + 非整页判定：不加类名，也不写分页默认值", () => {
    const policy = imageLayoutPolicy({ readingMode: "scroll", paginatedFillEligible: false });
    expect(policy).toEqual({
      viewerClass: null,
      usePaginatedMediaDefaults: false,
      fillPage: false,
    });
  });

  it("readingMode 缺省时按分页处理", () => {
    const policy = imageLayoutPolicy({ readingMode: undefined, paginatedFillEligible: true });
    expect(policy.viewerClass).toBe("fullpage-image");
    expect(policy.usePaginatedMediaDefaults).toBe(true);
    expect(policy.fillPage).toBe(true);
  });

  it("策略不再扩大识别范围：fillPage 恒等于分页 + 整页判定", () => {
    for (const readingMode of ["paginated", "scroll", undefined] as const) {
      for (const eligible of [true, false]) {
        const policy = imageLayoutPolicy({ readingMode, paginatedFillEligible: eligible });
        expect(policy.fillPage).toBe(readingMode !== "scroll" && eligible);
        expect(policy.viewerClass === null).toBe(!eligible);
      }
    }
  });
});

describe("scrollMediaDefaultsCss", () => {
  const css = scrollMediaDefaultsCss("epub-viewer");

  it("不是空规则，且覆盖 img/svg/video 与 img 的 object-fit", () => {
    expect(css).toContain(":where(#epub-viewer img, #epub-viewer svg, #epub-viewer video)");
    expect(css).toContain("max-width: 100%;");
    expect(css).toContain("object-fit: contain;");
  });

  it("不携带 !important，也不写 width/height/max-height/min-height", () => {
    expect(css).not.toContain("!important");
    expect(css).not.toMatch(/(?<![\w-])width\s*:/);
    expect(css).not.toMatch(/(?<![\w-])height\s*:/);
    expect(css).not.toMatch(/max-height|min-height|min-width/);
  });

  it("整个选择器都在 :where 内（零特异性），不改祖先盒子", () => {
    const selectors = css
      .split("\n")
      .filter((line) => line.includes("{"))
      .map((line) => line.slice(0, line.indexOf("{")).trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.startsWith(":where(")).toBe(true);
      expect(selector).not.toContain(">");
      expect(selector).not.toContain("*");
    }
  });
});
