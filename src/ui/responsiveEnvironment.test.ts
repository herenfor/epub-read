import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { classifyViewport, useResponsiveEnvironment } from "./responsiveEnvironment";

describe("responsive viewport classification", () => {
  it("classifies phone, tablet and wide windows by available CSS pixels", () => {
    expect(classifyViewport(390, 844)).toEqual({ layout: "compact", shortViewport: false });
    expect(classifyViewport(600, 800)).toEqual({ layout: "medium", shortViewport: false });
    expect(classifyViewport(839, 800)).toEqual({ layout: "medium", shortViewport: false });
    expect(classifyViewport(840, 800)).toEqual({ layout: "wide", shortViewport: false });
  });

  it("marks short landscape/input windows for full-height panels", () => {
    expect(classifyViewport(800, 420)).toEqual({ layout: "medium", shortViewport: true });
    expect(classifyViewport(1024, 479)).toEqual({ layout: "wide", shortViewport: true });
  });

  it("falls back to a usable desktop viewport for invalid measurements", () => {
    expect(classifyViewport(Number.NaN, 0)).toEqual({ layout: "wide", shortViewport: false });
  });
});

describe("mobile visual viewport", () => {
  it("updates a panned viewport even when its visible height stays the same", async () => {
    const dom = createReactDomHarness();
    const viewport = new window.EventTarget() as EventTarget & { height: number; offsetTop: number };
    viewport.height = 473;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    window.innerHeight = 832;
    function Snapshot() {
      const environment = useResponsiveEnvironment();
      return createElement("output", null,
        `${environment.visualViewportOffsetTop}/${environment.visualViewportHeight}/${environment.imeBottom}`);
    }
    try {
      await dom.render(createElement(Snapshot));
      expect(dom.container.textContent).toBe("0/473/359");
      await dom.run(() => {
        viewport.offsetTop = 359;
        viewport.dispatchEvent(new window.Event("scroll"));
      });
      expect(dom.container.textContent).toBe("359/473/0");
      await dom.run(() => {
        viewport.height = 832;
        viewport.offsetTop = 0;
        viewport.dispatchEvent(new window.Event("resize"));
      });
      expect(dom.container.textContent).toBe("0/832/0");
    } finally {
      delete (window as unknown as { visualViewport?: unknown }).visualViewport;
      await dom.dispose();
    }
  });
});
