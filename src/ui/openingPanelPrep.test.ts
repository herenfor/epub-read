import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createReactDomHarness } from "../test/reactDomHarness";
import { panelPrepReducer, PANEL_PREP_BUDGET_MS, useOpeningPanelPrep } from "./openingPanelPrep";
import { AaPopover, type AaPopoverProps } from "./AaPopover";
import { SidebarDrawer, type SidebarDrawerProps } from "./SidebarDrawer";
import { createSidebarNavigationMemory } from "./sidebarSwipe";
import type { TocNode } from "../core/types";

describe("opening panel preparation session", () => {
  it("lets no late or stale completion advance another book's preparation", () => {
    let state = panelPrepReducer(null, { type: "start", key: "old" });
    expect(state).toEqual({ key: "old", stage: "aa" });
    // A newer book replaces the session; the old book's completions are ignored.
    state = panelPrepReducer(state, { type: "start", key: "new" });
    expect(panelPrepReducer(state, { type: "prepared", key: "old", stage: "aa" })).toBe(state);
    expect(panelPrepReducer(state, { type: "expire", key: "old" })).toBe(state);
    // A stage already passed does not skip the next one.
    expect(panelPrepReducer(state, { type: "prepared", key: "new", stage: "toc" })).toBe(state);
    state = panelPrepReducer(state, { type: "prepared", key: "new", stage: "aa" });
    expect(state).toEqual({ key: "new", stage: "toc" });
    state = panelPrepReducer(state, { type: "prepared", key: "new", stage: "toc" });
    expect(state).toEqual({ key: "new", stage: "done" });
    expect(panelPrepReducer(state, { type: "release" })).toBeNull();
  });

  it("lifts the veil at the budget even if a panel never reports, and releases on leaving", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    let api!: ReturnType<typeof useOpeningPanelPrep>;
    const Probe = (props: { session: string | null }) => { api = useOpeningPanelPrep(props.session); return null; };
    try {
      await dom.render(createElement(Probe, { session: "book-a" }));
      expect(api).toMatchObject({ aa: true, toc: false, pending: true });
      // book-a reports late, after the reader moved on to book-b.
      api.prepared("book-a", "aa");
      await dom.render(createElement(Probe, { session: "book-b" }));
      await dom.run(() => { vi.advanceTimersByTime(20); });
      expect(api).toMatchObject({ aa: true, toc: false, pending: true });
      await dom.run(() => { vi.advanceTimersByTime(PANEL_PREP_BUDGET_MS); });
      expect(api).toMatchObject({ aa: true, toc: true, pending: false });
      await dom.render(createElement(Probe, { session: null }));
      expect(api).toMatchObject({ aa: false, toc: false, pending: false });
    } finally {
      await dom.dispose();
      vi.useRealTimers();
    }
  });
  it("a late old visit cannot cancel the current visit's prepared frame, even for the same book", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    let api!: ReturnType<typeof useOpeningPanelPrep>;
    const Probe = (props: { session: string | null }) => { api = useOpeningPanelPrep(props.session); return null; };
    try {
      await dom.render(createElement(Probe, { session: "same-book" }));
      const oldPrepared = api.prepared;
      await dom.render(createElement(Probe, { session: null }));
      await dom.render(createElement(Probe, { session: "same-book" }));
      api.prepared("same-book", "aa");
      oldPrepared("same-book", "aa");
      await dom.run(() => { vi.advanceTimersByTime(20); });
      expect(api).toMatchObject({ aa: true, toc: true, pending: true });
      api.prepared("same-book", "toc");
      oldPrepared("same-book", "aa");
      await dom.run(() => { vi.advanceTimersByTime(20); });
      expect(api.pending).toBe(false);
    } finally {
      await dom.dispose();
      vi.useRealTimers();
    }
  });

});

// linkedom has no layout observers or frames; the panels only need them to exist.
function stubLayoutApis() {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  const computed = () => ({ height: "32px", boxSizing: "border-box", paddingTop: "0", paddingBottom: "0",
    borderTopWidth: "0", borderBottomWidth: "0", transform: "none", getPropertyValue: () => "" });
  vi.stubGlobal("getComputedStyle", computed);
  (window as unknown as { getComputedStyle: unknown }).getComputedStyle = computed;
  (window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m41 = 0; };
  // Reduced motion: tab switches land at once (linkedom has no Web Animations).
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  // A 600px-tall pane at the top of its drawer, so the TOC can center.
  for (const [name, value] of [["clientHeight", 600], ["offsetTop", 0]] as const) {
    Object.defineProperty(window.HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
}

describe("prepared panels are reused by the first real opening", () => {
  const aaProps = (over: Partial<AaPopoverProps>): AaPopoverProps => ({
    fontSize: 18, onFontSizeChange: vi.fn(), onFontDec: vi.fn(), onFontInc: vi.fn(),
    theme: "light", onThemeChange: vi.fn(), onOpenFontSettings: vi.fn(),
    lineHeight: 1.7, onLineHeightChange: vi.fn(), pageMargins: {}, onPageMarginsChange: vi.fn(),
    readingMode: "paginated", onReadingModeChange: vi.fn(), onTurnAnimationChange: vi.fn(),
    onCustomCssChange: vi.fn(), onResetDefaults: vi.fn(), onToggleLog: vi.fn(), onClose: vi.fn(),
    ...over,
  });

  it("Aa: the detailed warm-up draws a real tab selection and every opening still starts at the quick tab", async () => {
    const dom = createReactDomHarness();
    stubLayoutApis();
    const props = aaProps({ open: false });
    const selected = () => [...dom.container.querySelectorAll(".aa-tab-btn")].findIndex((b) => b.getAttribute("aria-selected") === "true");
    try {
      await dom.render(createElement(AaPopover, { ...props, paintWarm: "detailed" }));
      const dialog = dom.container.querySelector(".aa-popover") as HTMLElement;
      expect(dialog.className).toContain("is-paint-warm");
      expect(dialog.hasAttribute("inert")).toBe(true);
      expect(selected()).toBe(1);
      for (const [name, value] of Object.entries(props)) {
        if (typeof value === "function") expect(value, name).not.toHaveBeenCalled();
      }
      // The stage ends while closed: back to quick.
      await dom.render(createElement(AaPopover, props));
      expect(dialog.className).not.toContain("is-paint-warm");
      expect(selected()).toBe(0);
      // Opened in the middle of the stage: opens at quick, not as a warm-up.
      await dom.render(createElement(AaPopover, { ...props, paintWarm: "detailed" }));
      expect(selected()).toBe(1);
      await dom.render(createElement(AaPopover, { ...props, open: true, paintWarm: "detailed" }));
      expect(dialog.className).not.toContain("is-paint-warm");
      expect(selected()).toBe(0);
    } finally {
      await dom.dispose();
    }
  });

  it("Aa: a sub-page suspends it in place; returning keeps its page and skips the entrance, a real close resets", async () => {
    const dom = createReactDomHarness();
    stubLayoutApis();
    const props = aaProps({ open: true });
    const selected = () => [...dom.container.querySelectorAll(".aa-tab-btn")].findIndex((b) => b.getAttribute("aria-selected") === "true");
    try {
      await dom.render(createElement(AaPopover, props));
      await dom.click(dom.container.querySelectorAll(".aa-tab-btn")[1]);
      const detailed = dom.container.querySelectorAll(".aa-popover-body")[1] as HTMLElement;
      detailed.scrollTop = 90;
      // Into a sub-page and back: same page, same scroll, no entrance.
      await dom.render(createElement(AaPopover, { ...props, open: false, suspended: true }));
      await dom.render(createElement(AaPopover, { ...props, open: true }));
      const dialog = dom.container.querySelector(".aa-popover") as HTMLElement;
      expect(dialog.className).toContain("is-resumed");
      expect(selected()).toBe(1);
      expect(detailed.scrollTop).toBe(90);
      // A sub-page closed for good (menu closed from it) resets like any close.
      await dom.render(createElement(AaPopover, { ...props, open: false, suspended: true }));
      await dom.render(createElement(AaPopover, { ...props, open: false, suspended: false }));
      await dom.render(createElement(AaPopover, { ...props, open: true }));
      expect(dialog.className).not.toContain("is-resumed");
      expect(selected()).toBe(0);
      expect(detailed.scrollTop).toBe(0);
    } finally {
      await dom.dispose();
    }
  });

  it("Aa: prepared hidden without user callbacks or focus, then opened in place at the quick tab", async () => {
    const dom = createReactDomHarness();
    stubLayoutApis();
    const onPrepared = vi.fn();
    const props = aaProps({ open: false, onPrepared });
    try {
      await dom.render(createElement(AaPopover, props));
      const dialog = dom.container.querySelector(".aa-popover") as HTMLElement;
      const focus = vi.fn();
      dialog.focus = focus;
      expect(onPrepared).toHaveBeenCalledTimes(1);
      expect(dialog.className).toContain("is-warm");
      expect(dialog.getAttribute("aria-hidden")).toBe("true");
      expect(dialog.hasAttribute("inert")).toBe(true);
      expect(dom.container.querySelector(".aa-popover-backdrop")).toBeNull();
      for (const [name, value] of Object.entries(props)) {
        if (name !== "onPrepared" && typeof value === "function") expect(value, name).not.toHaveBeenCalled();
      }

      await dom.render(createElement(AaPopover, { ...props, open: true }));
      expect(dom.container.querySelector(".aa-popover")).toBe(dialog);
      expect(dialog.className).not.toContain("is-warm");
      expect(dialog.hasAttribute("inert")).toBe(false);
      expect(dom.container.querySelector(".aa-popover-backdrop")).not.toBeNull();
      expect(focus).toHaveBeenCalledTimes(1);

      // Switch tabs and scroll, close: the next opening starts at the quick tab top.
      await dom.click(dom.container.querySelectorAll(".aa-tab-btn")[1]);
      const quick = dom.container.querySelector(".aa-popover-body") as HTMLElement;
      quick.scrollTop = 120;
      await dom.render(createElement(AaPopover, { ...props, open: false }));
      await dom.render(createElement(AaPopover, { ...props, open: true }));
      expect(dom.container.querySelector(".aa-popover")).toBe(dialog);
      expect(dom.container.querySelectorAll(".aa-tab-btn")[0].getAttribute("aria-selected")).toBe("true");
      expect(quick.scrollTop).toBe(0);
      expect(onPrepared).toHaveBeenCalledTimes(1);
    } finally {
      await dom.dispose();
    }
  });

  it("TOC: prepared without centering or remembering a position; the real opening does", async () => {
    const dom = createReactDomHarness();
    stubLayoutApis();
    const toc: TocNode[] = Array.from({ length: 200 }, (_, i) => ({ label: `Chapter ${i + 1}`, href: `c${i}.xhtml`, children: [] }));
    const memory = createSidebarNavigationMemory();
    const onPrepared = vi.fn();
    const props: SidebarDrawerProps = {
      open: false, warm: true, onPrepared, navigationMemory: memory, activeTab: "toc", onTabChange: vi.fn(),
      mode: "overlay", onModeChange: vi.fn(), onClose: vi.fn(), toc, activeHref: "c150.xhtml", onNavigateToc: vi.fn(),
      bookmarks: [], onSelectBookmark: vi.fn(), notes: [], onNavigateNote: vi.fn(),
    };
    try {
      await dom.render(createElement(SidebarDrawer, props));
      const drawer = dom.container.querySelector(".sidebar-drawer") as HTMLElement;
      expect(onPrepared).toHaveBeenCalledTimes(1);
      expect(drawer.className).toContain("is-warm");
      expect(drawer.hasAttribute("inert")).toBe(true);
      expect(dom.container.querySelector(".sidebar-backdrop")).toBeNull();
      // A window of rows, not the whole TOC; nothing remembered or navigated yet.
      expect(drawer.querySelectorAll("[data-toc-key]").length).toBeLessThan(80);
      expect(memory.scrollTop.toc).toBeUndefined();
      expect(props.onTabChange).not.toHaveBeenCalled();
      expect(props.onNavigateToc).not.toHaveBeenCalled();

      await dom.render(createElement(SidebarDrawer, { ...props, open: true }));
      expect(dom.container.querySelector(".sidebar-drawer")).toBe(drawer);
      expect(drawer.className).not.toContain("is-warm");
      expect(memory.scrollTop.toc).toBeDefined();
      expect(drawer.querySelector('[aria-current="location"]')?.textContent).toContain("Chapter 151");
    } finally {
      await dom.dispose();
    }
  });
});
