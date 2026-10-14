import { describe, expect, it } from "vitest";
import { buildVerticalPageModel, verticalPageAt, verticalPageScrollLeft } from "./pageModel";

describe("vertical page edges", () => {
  it("leaves a gap instead of cutting a text/ruby group; edges select the following page", () => {
    const model = buildVerticalPageModel([{ start: 95, end: 115 }, { start: 0, end: 20 }, { start: 90, end: 110 }], 100);
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    expect(model.pages).toEqual([{ start: 0, end: 90, blankAfter: 10 }, { start: 90, end: 115, blankAfter: 75 }]);
    expect(verticalPageAt(model, 89.99)).toBe(0);
    expect(verticalPageAt(model, 90)).toBe(1);
    expect(verticalPageAt(model, 115)).toBe(1);
    expect(verticalPageAt(model, 116)).toBeNull();
    expect(verticalPageScrollLeft(model, 1)).toBe(-90);
  });

  it("keeps columns separated, includes meaningful gaps, and has no padded phantom leaf", () => {
    const model = buildVerticalPageModel([{ start: 0, end: 20 }, { start: 100, end: 120 }, { start: 200, end: 220 }], 100);
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    expect(model.pages.map(p => [p.start, p.end])).toEqual([[0, 100], [100, 200], [200, 220]]);
    expect(model.groups).toHaveLength(3);
  });

  it("reports empty and oversize/overlapping atoms without a zero-step loop", () => {
    expect(buildVerticalPageModel([], 100).kind).toBe("empty");
    expect(verticalPageAt(buildVerticalPageModel([], 100), 0)).toBeNull();
    expect(buildVerticalPageModel([{ start: 10, end: 111 }], 100)).toMatchObject({ kind: "unsupported", reason: "wide-group" });
    expect(buildVerticalPageModel([{ start: 0, end: 80 }, { start: 75, end: 160 }], 100).kind).toBe("unsupported");
    expect(() => buildVerticalPageModel([], 0)).toThrow(RangeError);
    expect(() => buildVerticalPageModel([{ start: 5, end: 4 }], 100)).toThrow(RangeError);
  });

  it("advances strictly on a long fractional layout, never splits any merged column", () => {
    const intervals = Array.from({ length: 6000 }, (_, n) => ({ start: n * 29.75, end: n * 29.75 + 21.5 }));
    const model = buildVerticalPageModel(intervals, 383.25);
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") return;
    for (let n = 0; n < model.pages.length; n++) {
      const page = model.pages[n];
      expect(page.end).toBeGreaterThan(page.start);
      expect(page.end - page.start).toBeLessThanOrEqual(383.25);
      expect(page.start).toBe(n === 0 ? 0 : model.pages[n - 1].end);
      expect(intervals.some(i => i.start < page.end && i.end > page.end)).toBe(false);
    }
    expect(model.pages.at(-1)?.end).toBe(intervals.at(-1)?.end);
  });
});
