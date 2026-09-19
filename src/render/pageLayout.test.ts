import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_GAP_PX,
  autoPageMarginsPx,
  computePagedGeometry,
  normalizePageOptions,
} from "./pageLayout";

describe("normalizePageOptions", () => {
  it("returns the gap default for empty input and leaves optional fields unset", () => {
    const value = normalizePageOptions(undefined);
    expect(value).toEqual({ gapPx: DEFAULT_PAGE_GAP_PX });
    expect("pageMarginsPx" in value).toBe(false);
    expect("columnsPerView" in value).toBe(false);
    expect("readingMode" in value).toBe(false);
  });

  it("keeps legal zero margins, gap zero and both column preferences", () => {
    expect(normalizePageOptions({ gapPx: 0, pageMarginsPx: { top: 0, left: 0 }, columnsPerView: 2 }))
      .toEqual({ gapPx: 0, pageMarginsPx: { top: 0, left: 0 }, columnsPerView: 2 });
  });

  it("drops out-of-range and non-finite values instead of clamping", () => {
    const value = normalizePageOptions({
      gapPx: 200,
      readingMode: "scroll",
      pageMarginsPx: { top: 161, bottom: -2, left: 160, right: Number.NaN },
      columnsPerView: 3,
    });
    expect(value.gapPx).toBe(DEFAULT_PAGE_GAP_PX);
    expect(value.pageMarginsPx).toEqual({ left: 160 });
    expect(value.readingMode).toBe("scroll");
    expect(value.columnsPerView).toBeUndefined();
  });

  it("keeps inclusive upper bounds and finite decimals", () => {
    expect(normalizePageOptions({ gapPx: 96, pageMarginsPx: { top: 160, right: 12.5 } }))
      .toEqual({ gapPx: 96, pageMarginsPx: { top: 160, right: 12.5 } });
  });

  it("ignores non-object input and non-number fields", () => {
    expect(normalizePageOptions("2")).toEqual({ gapPx: DEFAULT_PAGE_GAP_PX });
    expect(normalizePageOptions({
      gapPx: "24",
      pageMarginsPx: { top: "44" },
      columnsPerView: "2",
      readingMode: "paged",
    })).toEqual({ gapPx: DEFAULT_PAGE_GAP_PX });
  });

  it("reports the legacy em auto margins used by the panel display", () => {
    expect(autoPageMarginsPx(20)).toEqual({ top: 44, bottom: 32 });
    expect(autoPageMarginsPx(16)).toEqual({ top: 35, bottom: 26 });
  });
});

describe("computePagedGeometry", () => {
  it("keeps the old single-column page step", () => {
    expect(computePagedGeometry(1000, 24, 1))
      .toEqual({ columns: 1, columnWidth: 1000, columnStep: 1024, viewStep: 1024 });
  });

  it("splits two columns and advances one view per screen", () => {
    expect(computePagedGeometry(1000, 24, 2))
      .toEqual({ columns: 2, columnWidth: 488, columnStep: 512, viewStep: 1024 });
  });

  it("falls back to one column below the minimum column width", () => {
    expect(computePagedGeometry(583, 24, 2)).toEqual({ columns: 1, columnWidth: 583, columnStep: 607, viewStep: 607 });
    expect(computePagedGeometry(584, 24, 2).columns).toBe(2);
  });

  it("handles a zero gap without changing the formulas", () => {
    expect(computePagedGeometry(800, 0, 2))
      .toEqual({ columns: 2, columnWidth: 400, columnStep: 400, viewStep: 800 });
  });

  it("does not round each column or step to integer pixels", () => {
    const geometry = computePagedGeometry(1000.5, 24, 2);
    expect(geometry.columnWidth).toBe(488.25);
    expect(geometry.columnStep).toBe(512.25);
    expect(geometry.viewStep).toBe(1024.5);
    expect(geometry.columnWidth * 2 + 24).toBe(1000.5);
    expect(geometry.viewStep).toBe(geometry.columnStep * 2);
  });

  it("keeps the last screen of five content columns reachable", () => {
    const geometry = computePagedGeometry(1000, 24, 2);
    const screens = Math.ceil(5 / geometry.columns);
    expect(screens).toBe(3);
    // 末屏起点（最后一屏的 viewStep 偏移）：2 * 1024
    expect(geometry.viewStep * (screens - 1)).toBe(2048);
  });
});
