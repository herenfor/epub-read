import { describe, expect, it } from "vitest";
import {
  mediaFitCssSize,
  planMediaFit,
  planTableWidth,
  resolveAvailableInlineWidth,
  tableFitCssWidth,
  tableFitsInlineBounds,
} from "./contentFit";

describe("page content fitting", () => {
  it("caps an oversized nested parent at its leaf and respects narrower ancestors", () => {
    const leaf = { left: 24, right: 360 };
    expect(resolveAvailableInlineWidth(leaf, [{ left: 24, right: 728 }])).toBe(336);
    expect(resolveAvailableInlineWidth(leaf, [
      { left: 64, right: 300 }, { left: 24, right: 728 },
    ], 12)).toBe(224);
    expect(resolveAvailableInlineWidth(leaf, [{ left: 400, right: 704 }])).toBe(0);
  });

  it("uses one physical RTL/spread leaf, not the two-page viewport", () => {
    expect(resolveAvailableInlineWidth({ left: 512, right: 848 }, [
      { left: 0, right: 1200 },
    ])).toBe(336);
  });

  it("preserves author em scaling until the page limit, then preserves image aspect", () => {
    const fit = (font: number) => planMediaFit({
      authored: { width: 16 * font, height: 6 * font },
      availableWidth: 336, pageHeight: 696,
    });
    expect(fit(16)).toMatchObject({ width: 256, height: 96, scale: 1 });
    expect(fit(44)).toMatchObject({ width: 336, height: 126 });
    expect(fit(60)?.width).toBe(336);
    expect(fit(60)?.height).toBeCloseTo(126);
    expect(fit(16)).toMatchObject({ width: 256, height: 96 });
  });

  it("caps tall paginated images but leaves a long scroll image's height intact", () => {
    const input = { authored: { width: 320, height: 1600 }, availableWidth: 336 };
    expect(planMediaFit({ ...input, pageHeight: 640 })).toMatchObject({ width: 128, height: 640 });
    expect(planMediaFit({ ...input, pageHeight: null })).toMatchObject({ width: 320, height: 1600 });
  });

  it("moves a fitting image to the next page instead of shrinking it to leftover space", () => {
    expect(planMediaFit({
      authored: { width: 300, height: 400 }, availableWidth: 336,
      pageHeight: 696, remainingHeight: 30,
    })).toMatchObject({ width: 300, height: 400, scale: 1, startOnNextPage: true });
  });

  it("defers unloaded images or an empty content area rather than writing zero sizes", () => {
    expect(planMediaFit({ authored: { width: 0, height: 0 }, availableWidth: 336, pageHeight: 696 })).toBeNull();
    expect(planMediaFit({ authored: { width: 300, height: 100 }, availableWidth: 0, pageHeight: 696 })).toBeNull();
  });

  it("keeps fixed border/padding outside the proportional image content", () => {
    const fitted = { width: 336, height: 126 }, insets = { width: 12, height: 8 };
    expect(mediaFitCssSize(fitted, insets, "content-box")).toEqual(fitted);
    expect(mediaFitCssSize(fitted, insets, "border-box")).toEqual({ width: 348, height: 134 });
  });

  it("proposes a narrower table without claiming its cells have already fitted", () => {
    expect(planTableWidth(640, 336)).toEqual({ kind: "constrain", borderBoxWidth: 336 });
    expect(planTableWidth(200, 336)).toEqual({ kind: "preserve" });
    expect(planTableWidth(640, 0)).toEqual({ kind: "defer" });
    expect(tableFitCssWidth(336, 12, "content-box")).toBe(324);
    expect(tableFitCssWidth(336, 12, "border-box")).toBe(336);
    const available = { left: 24, right: 360 };
    expect(tableFitsInlineBounds(available, [available, { left: 136, right: 359.5 }])).toBe(true);
    // The table box fits, but a fixed-width/no-wrap cell still spills out.
    expect(tableFitsInlineBounds(available, [available, { left: 136, right: 500 }])).toBe(false);
    expect(tableFitsInlineBounds(available, [])).toBe(false);
  });
});
