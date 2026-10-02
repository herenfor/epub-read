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
  setExternalScroll(this: unknown, adapter?: unknown): void;
  applyScrollViewerStyles(this: unknown, viewportHeight: number): void;
};

function contextWithViewer() {
  const style = new FakeStyle();
  style.setProperty("overflow-y", "scroll", "important");
  const viewer = { style };
  const context = Object.create(ChapterPaginator.prototype) as Record<string, unknown>;
  context.viewer = viewer;
  context.externalScroll = undefined;
  context.externalScrollOwnershipRestore = null;
  context.scrollStyleRestore = null;
  return { context, viewer, style };
}

describe("continuous external scroll viewer ownership", () => {
  it("hides user overflow on the viewer while the host owns vertical pan", () => {
    const { context, style } = contextWithViewer();
    internals.setExternalScroll.call(context, { onWheelPixels() {}, onViewportStep() {} });
    expect(style.getPropertyValue("overflow-y")).toBe("hidden");
    expect(style.getPropertyPriority("overflow-y")).toBe("important");
  });

  it("restores the original inline value and priority when ownership ends", () => {
    const { context, style } = contextWithViewer();
    internals.setExternalScroll.call(context, { onWheelPixels() {}, onViewportStep() {} });
    internals.setExternalScroll.call(context, undefined);
    expect(style.getPropertyValue("overflow-y")).toBe("scroll");
    expect(style.getPropertyPriority("overflow-y")).toBe("important");
  });

  it("re-applies ownership after the scroll viewer style transaction", () => {
    const { context, style } = contextWithViewer();
    internals.setExternalScroll.call(context, { onWheelPixels() {}, onViewportStep() {} });
    internals.applyScrollViewerStyles.call(context, 600);
    expect(style.getPropertyValue("overflow-y")).toBe("hidden");
    expect(style.getPropertyPriority("overflow-y")).toBe("important");
  });
});
