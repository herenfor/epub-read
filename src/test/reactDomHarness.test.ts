import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "./reactDomHarness";

afterEach(() => { vi.useRealTimers(); });

describe("react DOM harness layout stubs", () => {
  it("undoes prototype layout on dispose, so the next harness starts unmeasured", async () => {
    const first = createReactDomHarness();
    const proto = first.window.HTMLElement.prototype;
    const ownRect = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
    first.metrics(proto, { clientWidth: 1000 });
    first.rect(proto, { left: 10, width: 400, height: 300 });
    expect(first.container.clientWidth).toBe(1000);
    expect(first.container.getBoundingClientRect()).toMatchObject({ left: 10, right: 410, bottom: 300, x: 10, y: 0 });
    await first.dispose();

    const next = createReactDomHarness();
    try {
      // linkedom shares element classes between windows.
      expect(next.window.HTMLElement.prototype).toBe(proto);
      expect(Object.getOwnPropertyDescriptor(proto, "clientWidth")).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect")).toEqual(ownRect);
    } finally {
      await next.dispose();
    }
  });

  it("drives frames from timers on both spellings and removes them on dispose", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness({ animationFrames: 16, resizeObserver: true });
    const seen: string[] = [];
    requestAnimationFrame(() => seen.push("global"));
    window.requestAnimationFrame(() => seen.push("window"));
    cancelAnimationFrame(requestAnimationFrame(() => seen.push("cancelled")));
    vi.advanceTimersByTime(15);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["global", "window"]);
    expect(() => new ResizeObserver(() => {}).observe(dom.container)).not.toThrow();
    const win = dom.window;
    await dom.dispose();
    expect("requestAnimationFrame" in globalThis).toBe(false);
    expect("ResizeObserver" in globalThis).toBe(false);
    expect(Object.getOwnPropertyDescriptor(win, "requestAnimationFrame")).toBeUndefined();
  });

  it("answers computed style and media queries like a browser", async () => {
    const dom = createReactDomHarness({
      computedStyle: () => ({ transitionDuration: "0.2s", zoom: "1.5" }),
      matchMedia: (query) => query.includes("coarse"),
    });
    try {
      const style = getComputedStyle(dom.container);
      expect(style.zoom).toBe("1.5");
      expect(style.getPropertyValue("transition-duration")).toBe("0.2s");
      expect(style.getPropertyValue("height")).toBe("");
      expect(window.getComputedStyle(dom.container).zoom).toBe("1.5");
      expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
      expect(window.matchMedia("(hover: hover)").matches).toBe(false);
    } finally {
      await dom.dispose();
    }
  });
});
