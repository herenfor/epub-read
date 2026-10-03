import { describe, expect, it } from "vitest";
import { ChapterPaginator } from "./paginator";

class FakeStyle {
  private values = new Map<string, string>();
  private priorities = new Map<string, string>();

  setProperty(property: string, value: string, priority = ""): void {
    this.values.set(property, value);
    if (priority) this.priorities.set(property, priority);
    else this.priorities.delete(property);
  }

  getPropertyValue(property: string): string {
    return this.values.get(property) ?? "";
  }

  getPropertyPriority(property: string): string {
    return this.priorities.get(property) ?? "";
  }

  removeProperty(property: string): void {
    this.values.delete(property);
    this.priorities.delete(property);
  }
}

const internals = ChapterPaginator.prototype as unknown as {
  applyCompositedPagedScroll(this: unknown): void;
  restoreCompositedPagedScroll(this: unknown): void;
};

function context(options: { coarse?: boolean; scrollMode?: boolean; swipe?: boolean } = {}) {
  const style = new FakeStyle();
  const viewer = { style, scrollLeft: 1200 };
  const ctx = Object.create(ChapterPaginator.prototype) as Record<string, unknown>;
  ctx.viewer = viewer;
  ctx.settings = { readingMode: options.scrollMode ? "scroll" : "paged" };
  ctx.pagedSwipe = options.swipe === false ? undefined : { onNext() {}, onPrev() {}, shouldIgnore: () => false };
  ctx.contentDoc = {
    defaultView: { matchMedia: () => ({ matches: options.coarse ?? true }) },
  };
  ctx.compositedPagedScrollRestore = null;
  ctx.compositedPagedScrollViewer = null;
  return { ctx, viewer, style };
}

describe("touch paged viewer composited scrolling", () => {
  it("switches the viewer to a hidden-scrollbar, pan-y scroller without moving the page", () => {
    const { ctx, viewer, style } = context();
    internals.applyCompositedPagedScroll.call(ctx);
    expect(style.getPropertyValue("overflow-x")).toBe("scroll");
    expect(style.getPropertyPriority("overflow-x")).toBe("important");
    expect(style.getPropertyValue("scrollbar-width")).toBe("none");
    expect(style.getPropertyValue("touch-action")).toBe("pan-y pinch-zoom");
    expect(viewer.scrollLeft).toBe(1200);
  });

  it("leaves mouse-first desktops, scroll mode and swipe-less readers untouched", () => {
    for (const options of [{ coarse: false }, { scrollMode: true }, { swipe: false }]) {
      const { ctx, style } = context(options);
      internals.applyCompositedPagedScroll.call(ctx);
      expect(style.getPropertyValue("overflow-x")).toBe("");
      expect(style.getPropertyValue("touch-action")).toBe("");
    }
  });

  it("restores the original inline values and keeps the current page offset", () => {
    const { ctx, viewer, style } = context();
    style.setProperty("touch-action", "manipulation");
    internals.applyCompositedPagedScroll.call(ctx);
    viewer.scrollLeft = 2400;
    internals.restoreCompositedPagedScroll.call(ctx);
    expect(style.getPropertyValue("overflow-x")).toBe("");
    expect(style.getPropertyValue("scrollbar-width")).toBe("");
    expect(style.getPropertyValue("touch-action")).toBe("manipulation");
    expect(viewer.scrollLeft).toBe(2400);
  });

  it("re-applies to a new chapter viewer instead of reusing the old snapshot", () => {
    const { ctx } = context();
    internals.applyCompositedPagedScroll.call(ctx);
    const next = { style: new FakeStyle(), scrollLeft: 0 };
    ctx.viewer = next;
    internals.applyCompositedPagedScroll.call(ctx);
    expect(next.style.getPropertyValue("overflow-x")).toBe("scroll");
  });
});
