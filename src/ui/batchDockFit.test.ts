import { describe, expect, it } from "vitest";
import { createElement, useRef } from "react";
import { createReactDomHarness } from "../test/reactDomHarness";
import { fitBatchDock, useBatchDockFit, type BatchDockFit } from "./batchDockFit";

/** A dock whose width follows its data-fit, as the stylesheet makes it. */
function dock(widths: Record<BatchDockFit, number>): HTMLElement {
  const dataset: DOMStringMap = {};
  return {
    dataset,
    get offsetWidth() {
      return widths[(dataset.fit ?? "full") as BatchDockFit];
    },
  } as unknown as HTMLElement;
}

// Measured on native Linux, Chinese labels, nine actions.
const ZH = { full: 1043, "no-info": 931, compact: 576 };

describe("fitBatchDock", () => {
  it("keeps the full row when it fits inside the gutters", () => {
    const el = dock(ZH);
    expect(fitBatchDock(el, 1080)).toBe("full");
    expect(el.dataset.fit).toBe("full");
  });

  it("drops the count first, then goes compact", () => {
    expect(fitBatchDock(dock(ZH), 1000)).toBe("no-info");
    expect(fitBatchDock(dock(ZH), 963)).toBe("no-info");
    const el = dock(ZH);
    expect(fitBatchDock(el, 962)).toBe("compact");
    expect(el.dataset.fit).toBe("compact");
    expect(fitBatchDock(dock(ZH), 640)).toBe("compact");
  });

  it("goes back up when the window widens again", () => {
    const el = dock(ZH);
    fitBatchDock(el, 640);
    expect(fitBatchDock(el, 1280)).toBe("full");
  });

  it("releases its fit when the layout becomes inactive or unmounts", async () => {
    function Dock({ active }: { active: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useBatchDockFit(ref, active, "actions");
      return createElement("div", { ref });
    }
    const dom = createReactDomHarness();
    let element: HTMLElement | null = null;
    try {
      await dom.render(createElement(Dock, { active: true }));
      element = dom.container.firstElementChild as HTMLElement;
      expect(element.hasAttribute("data-fit")).toBe(true);
      await dom.render(createElement(Dock, { active: false }));
      expect(dom.container.firstElementChild).toBe(element);
      expect(element.hasAttribute("data-fit")).toBe(false);
      await dom.render(createElement(Dock, { active: true }));
      expect(element.hasAttribute("data-fit")).toBe(true);
    } finally {
      await dom.dispose();
    }
    expect(element?.hasAttribute("data-fit")).toBe(false);
  });
});
