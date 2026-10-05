import { describe, expect, it } from "vitest";
import { createSpreadLayout, spreadStart } from "./pagedSpread";
import { foldSpreadIntoPages, resolveSpreadReadingArea, spreadReadingAreaStyles } from "./spreadReadingArea";

const area = (availableWidth: number, extra: Record<string, number> = {}) =>
  resolveSpreadReadingArea({
    availableWidth,
    fontSizePx: 16,
    viewerInsetLeft: 0,
    viewerInsetRight: 0,
    ...extra,
  });

const near = (actual: number, expected: number) => {
  expect(Math.abs(actual - expected)).toBeLessThan(0.001);
};

describe("comfortable spread reading area", () => {
  it("uses proportional outer space and a real two-column gap on tablet widths", () => {
    const ipad = area(1024);
    expect(ipad).not.toBeNull();
    near(ipad!.marginLeftPx, 51.2);
    near(ipad!.marginRightPx, 51.2);
    near(ipad!.geometry.gap, 61.44);
    near(ipad!.geometry.columnWidth, 430.08);

    const android = area(1280);
    near(android!.geometry.columnWidth, 512);
    near(android!.geometry.gap, 76.8);
    near(android!.marginLeftPx, 89.6);
  });

  it("caps the real column width and gives extra width back to the outer margins", () => {
    const full = area(1920);
    const wide = area(3440);
    near(full!.geometry.columnWidth, 512);
    near(wide!.geometry.columnWidth, 512);
    near(full!.geometry.gap, 96);
    near(full!.marginLeftPx, 400);
    near(wide!.marginLeftPx, 1160);
    expect(spreadReadingAreaStyles(full!)["column-gap"]).toBe("96px");
    expect(spreadReadingAreaStyles(full!)["width"]).toBe("1120px");
  });

  it("keeps explicit asymmetric margins and explicit zero gap", () => {
    const manual = area(1000, { leftPx: 0, rightPx: 80, gapPx: 0 });
    near(manual!.marginLeftPx, 0);
    near(manual!.marginRightPx, 80);
    near(manual!.geometry.columnWidth, 460);
    near(manual!.geometry.gap, 0);
    near(manual!.contentOriginX, 0);
  });

  it("returns null for narrow or large-font budgets instead of forcing tiny columns", () => {
    expect(area(640)).toBeNull();
    expect(area(1024, { fontSizePx: 30 })).toBeNull();
    expect(area(1024, { fontSizePx: 24 })).not.toBeNull();
  });

  it("deducts body width and viewer insets exactly once", () => {
    const value = area(1000, { viewerInsetLeft: 10, viewerInsetRight: 14 });
    near(value!.marginLeftPx + value!.viewerBorderBoxWidth + value!.marginRightPx, 1000);
    near(value!.viewerBorderBoxWidth - 24, value!.geometry.viewportWidth);
    near(value!.contentOriginX, value!.marginLeftPx + 10);
    near(2 * value!.geometry.columnWidth + value!.geometry.gap, value!.geometry.viewportWidth);
  });

  it("keeps existing spread step and last-spread reachability", () => {
    const value = area(1180)!;
    const layout = createSpreadLayout(value.geometry, { first: 0, last: 4 });
    near(value.geometry.spreadStep, value.geometry.viewportWidth + value.geometry.gap);
    expect(layout.pageCount).toBe(3);
    near(spreadStart(layout, 2), 4 * value.geometry.columnStep);
    near(layout.requiredScrollWidth, spreadStart(layout, 2) + value.geometry.viewportWidth);
  });
});

describe("spread folded into pages (full-width turns)", () => {
  const fold = (width: number, fontSizePx = 16, extra: { leftPx?: number; rightPx?: number; author?: number } = {}) => {
    const author = extra.author ?? 0;
    const area = resolveSpreadReadingArea({
      availableWidth: width - 2 * author,
      fontSizePx,
      viewerInsetLeft: 0,
      viewerInsetRight: 0,
      leftPx: extra.leftPx,
      rightPx: extra.rightPx,
    });
    if (!area) return { area, result: null };
    return {
      area,
      result: foldSpreadIntoPages(area, { fullWidth: width, fontSizePx, authorInsetLeft: author, authorInsetRight: author }),
    };
  };

  it.each([1205, 1280, 1536, 1920, 2560])("one spread advances exactly the full width at %ipx", (width) => {
    const { area, result } = fold(width);
    expect(result).not.toBeNull();
    const g = result!.geometry;
    expect(g.columns).toBe(2);
    expect(g.spreadStep).toBeCloseTo(width, 6);
    expect(g.gap).toBeCloseTo(result!.paddingLeftPx + result!.paddingRightPx, 6);
    expect(g.columnWidth).toBeLessThanOrEqual(area!.maxColumnWidth + 1e-6);
    // 每页 [左 | 正文 | 右] 恰好半屏。
    expect(result!.paddingLeftPx + g.columnWidth + result!.paddingRightPx).toBeCloseTo(width / 2, 6);
  });

  it("keeps the auto margins on a tablet and folds the book body padding in", () => {
    const { area, result } = fold(1205, 16, { author: 8 });
    expect(result!.paddingLeftPx).toBeCloseTo(area!.baseLeftPx + 8, 6);
    expect(result!.geometry.columnWidth).toBeLessThan(area!.maxColumnWidth);
  });

  it("widens page margins instead of lines on wide desktop windows", () => {
    const { area, result } = fold(1920);
    expect(result!.geometry.columnWidth).toBeCloseTo(area!.maxColumnWidth, 6);
    expect(result!.paddingLeftPx).toBeCloseTo(224, 6);
    expect(result!.geometry.gap).toBeCloseTo(448, 6);
  });

  it("keeps explicit asymmetric margins in proportion", () => {
    const { result } = fold(1280, 16, { leftPx: 40, rightPx: 80 });
    expect(result!.paddingRightPx / result!.paddingLeftPx).toBeCloseTo(2, 6);
  });

  it("does not fold when two pages no longer fit", () => {
    const { area } = fold(800);
    if (!area) return;
    expect(foldSpreadIntoPages(area, { fullWidth: 640, fontSizePx: 16 })).toBeNull();
  });
});
