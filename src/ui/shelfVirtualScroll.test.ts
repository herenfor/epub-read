import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { emptyOrganization } from "./libraryOrganization";
import { ShelfView, measureShelfGridGeometry, type ShelfViewProps } from "./ShelfView";
import { FontSettingsPanel } from "./FontSettingsPanel";
import type { ShelfEntry } from "./shelf";

const entries: ShelfEntry[] = Array.from({ length: 180 }, (_, i) => ({
  id: `book-${i}`, contentHash: `book-${i}`, title: `合成书 ${i}`, creator: "作者",
  fileName: `${i}.epub`, fileSize: 1024, coverMime: "image/jpeg", addedAtMs: 180 - i, lastReadAtMs: 0,
  spineIndex: 0, page: 0, progressPct: 0, anchorIndex: null, anchorRatio: null, isNew: false,
}));
const props: ShelfViewProps = {
  entries, organization: emptyOrganization(), busy: false, theme: "light",
  onThemeChange() {}, onOpen() {}, onImport() {}, onImportArchive() {},
  onExportArchive() {}, onDelete() {}, onDeleteMany() {},
};
afterEach(() => vi.unstubAllGlobals());

function shelfHarness() {
  const dom = createReactDomHarness({
    animationFrames: 0,
    computedStyle: el => el.classList.contains("shelf-book-grid")
      ? { gridTemplateColumns: "120px 120px", rowGap: "20px" } : { zoom: "1" },
  });
  const observers: Array<{ targets: Set<Element>; fire(): void }> = [];
  vi.stubGlobal("ResizeObserver", class {
    targets = new Set<Element>();
    constructor(private callback: () => void) { observers.push(this); }
    observe(el: Element) { this.targets.add(el); }
    unobserve(el: Element) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); }
    fire() { this.callback(); }
  });
  let origin = 260.25;
  dom.define(dom.window.HTMLElement.prototype, "scrollTop", {
    get(this: HTMLElement & { _top?: number }) { return this._top ?? 0; },
    set(this: HTMLElement & { _top?: number }, n: number) { this._top = n; },
  });
  dom.metrics(dom.window.HTMLElement.prototype, { clientHeight: 400 });
  dom.rect(dom.window.HTMLElement.prototype, el => {
    const scroller = dom.container.querySelector<HTMLElement>(".shelf-view");
    const top = origin - (scroller?.scrollTop ?? 0);
    if (el.classList.contains("shelf-view")) return { top: 0, height: 400, width: 300 };
    if (el.classList.contains("shelf-book-prefix")) return { top, height: 2000, width: 300 };
    if (el.classList.contains("shelf-card") && el.closest(".shelf-book-grid")) {
      const cards = [...el.parentElement!.children];
      const i = cards.indexOf(el);
      const padding = parseFloat(el.closest<HTMLElement>(".shelf-book-prefix")!.style.paddingTop) || 0;
      return { top: top + padding + Math.floor(i / 2) * 100.5, height: 80.5, width: 120 };
    }
    return { top: 0, height: 0, width: 0 };
  });
  return { dom, observers, movePrefix: (n: number) => { origin = n; },
    settle: () => dom.run(() => new Promise<void>(resolve => setTimeout(resolve, 35))) };
}

describe("virtual list geometry stays stable", () => {
  it("retains fractional grid pitch and origin instead of accumulating rounding per row", async () => {
    const h = shelfHarness();
    try {
      await h.dom.render(createElement(ShelfView, props));
      await h.settle();
      expect(measureShelfGridGeometry(h.dom.container.querySelector(".shelf-view")!))
        .toEqual({ columns: 2, rowStep: 100.5, contentTop: 260.25 });
    } finally { await h.dom.dispose(); }
  });

  it("rebinds replaced nodes at the same count and follows a resized prefix without scrolling", async () => {
    const h = shelfHarness();
    try {
      await h.dom.render(createElement(ShelfView, props));
      await h.settle();
      const old = h.dom.container.querySelector(".shelf-book-prefix")!;
      await h.dom.render(createElement(ShelfView, { ...props, libraryState: { kind: "loading" } }));
      await h.settle();
      await h.dom.render(createElement(ShelfView, props));
      await h.settle();
      const current = h.dom.container.querySelector<HTMLElement>(".shelf-book-prefix")!;
      expect(current).not.toBe(old);
      expect(h.observers.some(o => o.targets.has(old))).toBe(false);
      expect(h.observers.some(o => o.targets.has(current))).toBe(true);
      const scroller = h.dom.container.querySelector<HTMLElement>(".shelf-view")!;
      scroller.scrollTop = 2000;
      await h.dom.dispatch(scroller, new h.dom.window.Event("scroll"));
      await h.settle();
      expect(parseFloat(current.style.paddingTop)).toBe(1507.5);
      h.movePrefix(460.25);
      await h.dom.run(() => h.observers.forEach(o => o.fire()));
      await h.settle();
      expect(parseFloat(current.style.paddingTop)).toBe(1306.5);
      const stable = current.style.paddingTop;
      await h.settle();
      expect(current.style.paddingTop).toBe(stable);
    } finally { await h.dom.dispose(); }
  });

  it("keeps a nonempty window when a deep-scrolled result shrinks but still exceeds the threshold", async () => {
    const h = shelfHarness();
    try {
      await h.dom.render(createElement(ShelfView, props));
      await h.settle();
      const scroller = h.dom.container.querySelector<HTMLElement>(".shelf-view")!;
      scroller.scrollTop = 8000;
      await h.dom.dispatch(scroller, new h.dom.window.Event("scroll"));
      await h.settle();
      await h.dom.render(createElement(ShelfView, { ...props, entries: entries.slice(0, 50) }));
      expect(h.dom.container.querySelectorAll(".shelf-book-grid .shelf-card").length).toBeGreaterThan(0);
      await h.settle();
      expect(h.dom.container.querySelector('[data-book-id="book-49"]')).not.toBeNull();
    } finally { await h.dom.dispose(); }
  });

  it("uses the touch font row's actual 48px pitch for both spacers and the final item", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0, computedStyle: () => ({ height: "48px" }) });
    dom.metrics(dom.window.HTMLElement.prototype, { clientHeight: 480 });
    try {
      await dom.render(createElement(FontSettingsPanel, {
        systemFonts: Array.from({ length: 100 }, (_, i) => ({ family: `Font-${i}`, localizedNames: [] })),
        userFonts: [], busy: false, systemFontsStatus: "ready",
        onSelectSystem() {}, onSelectBook() {}, onSelectImported() {}, onDelete() {}, onImport() {}, onClose() {},
      }));
      const scroller = dom.container.querySelector<HTMLElement>(".font-settings-scroll")!;
      expect((scroller.lastElementChild as HTMLElement).style.height).toBe("4800px");
      dom.define(scroller, "scrollTop", { value: 4320 });
      await dom.dispatch(scroller, new dom.window.Event("scroll", { bubbles: true }));
      const wrapper = scroller.lastElementChild as HTMLElement;
      expect((wrapper.firstElementChild as HTMLElement).style.height).toBe("4128px");
      expect(wrapper.textContent).toContain("Font-99");
    } finally { await dom.dispose(); }
  });
});
