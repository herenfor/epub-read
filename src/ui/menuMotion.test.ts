import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { MENU_CLOSE_MS, menuCloseMs, useExitPresence, useMenuClose } from "./menuMotion";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function mockDuration(duration: string) {
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    value: () => ({ getPropertyValue: () => duration }),
  });
}

function ClosePanel({ onClose, open = true }: { onClose: () => void; open?: boolean }) {
  const { isClosing, requestClose, cancelClose } = useMenuClose(onClose, open);
  return createElement("div", {},
    createElement("button", { onClick: requestClose }, isClosing ? "closing" : "open"),
    createElement("button", { onClick: cancelClose, "data-cancel": true }, "cancel"));
}

function PresencePanel({ open }: { open: boolean }) {
  const { present, closing } = useExitPresence(open);
  return present ? createElement("div", {}, closing ? "closing" : "open") : null;
}

describe("menu exit lifetime", () => {
  it("reads CSS milliseconds, seconds and instant reduced motion, with an SSR fallback", () => {
    expect(menuCloseMs()).toBe(MENU_CLOSE_MS);
    vi.stubGlobal("window", {});
    for (const [css, ms] of [["200ms", 200], ["120ms", 120], ["0.2s", 200], ["0ms", 0], ["", 200]] as const) {
      mockDuration(css);
      vi.stubGlobal("document", { documentElement: {} });
      expect(menuCloseMs()).toBe(ms);
    }
  });

  it("finishes one exit at the CSS deadline even if close is requested twice", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    const onClose = vi.fn();
    try {
      mockDuration("120ms");
      await dom.render(createElement(ClosePanel, { onClose }));
      await dom.click(dom.container.querySelector("button")!);
      await dom.run(() => { vi.advanceTimersByTime(60); });
      await dom.click(dom.container.querySelector("button")!);
      await dom.run(() => { vi.advanceTimersByTime(59); });
      expect(onClose).not.toHaveBeenCalled();
      await dom.run(() => { vi.advanceTimersByTime(1); });
      expect(onClose).toHaveBeenCalledTimes(1);
      await dom.run(() => { vi.advanceTimersByTime(200); });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally { await dom.dispose(); }
  });

  it("cancels stale close callbacks after external dismissal and reopening", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    const onClose = vi.fn();
    try {
      mockDuration("200ms");
      await dom.render(createElement(ClosePanel, { onClose }));
      await dom.click(dom.container.querySelector("button")!);
      await dom.run(() => { vi.advanceTimersByTime(80); });
      await dom.render(createElement(ClosePanel, { onClose, open: false }));
      await dom.render(createElement(ClosePanel, { onClose, open: true }));
      await dom.run(() => { vi.advanceTimersByTime(200); });
      expect(onClose).not.toHaveBeenCalled();
      expect(dom.container.querySelector("button")?.textContent).toBe("open");
    } finally { await dom.dispose(); }
  });

  it("does not let an unmounted panel close a later panel", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    const onClose = vi.fn();
    try {
      mockDuration("200ms");
      await dom.render(createElement(ClosePanel, { onClose }));
      await dom.click(dom.container.querySelector("button")!);
    } finally { await dom.dispose(); }
    vi.advanceTimersByTime(200);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a tab selection can interrupt closing without a late dismissal", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    const onClose = vi.fn();
    try {
      mockDuration("200ms");
      await dom.render(createElement(ClosePanel, { onClose }));
      await dom.click(dom.container.querySelector("button")!);
      await dom.run(() => { vi.advanceTimersByTime(80); });
      await dom.click(dom.container.querySelector("[data-cancel]")!);
      await dom.run(() => { vi.advanceTimersByTime(200); });
      expect(onClose).not.toHaveBeenCalled();
      expect(dom.container.querySelector("button")?.textContent).toBe("open");
    } finally { await dom.dispose(); }
  });

  it("reopening interrupts presence exit and a later exit uses the new duration", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    try {
      mockDuration("200ms");
      await dom.render(createElement(PresencePanel, { open: true }));
      await dom.render(createElement(PresencePanel, { open: false }));
      await dom.run(() => { vi.advanceTimersByTime(80); });
      await dom.render(createElement(PresencePanel, { open: true }));
      await dom.run(() => { vi.advanceTimersByTime(200); });
      expect(dom.container.textContent).toBe("open");
      mockDuration("0ms");
      await dom.render(createElement(PresencePanel, { open: false }));
      await dom.run(() => { vi.advanceTimersByTime(0); });
      expect(dom.container.textContent).toBe("");
    } finally { await dom.dispose(); }
  });
});
