import { describe, expect, it } from "vitest";
import { ChapterPaginator } from "./paginator";

function element(left: number, right: number, children: object[] = []) {
  return {
    getBoundingClientRect: () => ({ left, right, width: right - left, height: 20 }),
    querySelectorAll: () => children,
  };
}
const contentExtent = (ChapterPaginator.prototype as unknown as {
  contentExtent(this: unknown): { minX: number; maxX: number };
}).contentExtent;

describe("pagination of clipped trailing inline whitespace", () => {
  it("does not invent a second column from invisible whitespace after the first", () => {
    const span = element(550, 780);
    const line = element(5, 635, [span]);
    const viewer = { scrollLeft: 0, querySelectorAll: () => [line, span] };
    expect(contentExtent.call({ viewer, inlineClipFixes: [{ el: line }] })).toEqual({ minX: 5, maxX: 635 });
    expect(contentExtent.call({ viewer, inlineClipFixes: [] })).toEqual({ minX: 5, maxX: 780 });
  });
  it("keeps real later columns and restores content coordinates when scrolled", () => {
    const span = element(-100, 120);
    const line = element(-650, -20, [span]);
    const next = element(10, 640);
    const viewer = { scrollLeft: 664, querySelectorAll: () => [line, span, next] };
    expect(contentExtent.call({ viewer, inlineClipFixes: [{ el: line }] })).toEqual({ minX: 14, maxX: 1304 });
  });
});
