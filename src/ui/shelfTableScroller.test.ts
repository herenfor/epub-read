import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { ShelfTableScroller } from "./ShelfView";

it("列表横向入口：只在表格比可视区宽时出现，和表格共用 scrollLeft；变窄后撤掉", async () => {
  const dom = createReactDomHarness();
  let resized: (() => void) | null = null;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  try {
    await dom.render(createElement(ShelfTableScroller, null, createElement("table", { className: "shelf-table" })));
    const view = dom.container.querySelector<HTMLElement>(".shelf-table-view")!;
    const bar = () => dom.container.querySelector<HTMLElement>(".shelf-table-hscroll");
    expect(bar()).toBeNull();

    const size = (scrollWidth: number) => {
      Object.defineProperty(view, "scrollWidth", { configurable: true, value: scrollWidth });
      Object.defineProperty(view, "clientWidth", { configurable: true, value: 858 });
    };
    size(960);
    await dom.run(() => { resized!(); });
    expect(view.classList.contains("has-hscroll")).toBe(true);
    expect((bar()!.firstElementChild as HTMLElement).style.width).toBe("960px");

    const scroll = (element: HTMLElement, left: number) => dom.run(() => {
      element.scrollLeft = left;
      element.dispatchEvent(new window.Event("scroll"));
    });
    await scroll(bar()!, 102);
    expect(view.scrollLeft).toBe(102);
    await scroll(view, 30);
    expect(bar()!.scrollLeft).toBe(30);

    size(858);
    await dom.run(() => { resized!(); });
    expect(bar()).toBeNull();
    expect(view.classList.contains("has-hscroll")).toBe(false);
  } finally {
    await dom.dispose();
    vi.unstubAllGlobals();
  }
});
