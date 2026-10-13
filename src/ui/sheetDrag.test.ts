import { createElement, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { claimContentDrag, CONTENT_DRAG_SLOP_PX, resolveSheetDrag, SHEET_CLOSE_DISTANCE_PX, SHEET_EXPAND_DISTANCE_PX, useSheetDrag } from "./sheetDrag";

describe("bottom sheet drag", () => {
  const plain = { expandable: false, expanded: false };
  const half = { expandable: true, expanded: false };
  const full = { expandable: true, expanded: true };

  it("closes a plain sheet on a long or fast downward pull and springs back otherwise", () => {
    expect(resolveSheetDrag(SHEET_CLOSE_DISTANCE_PX + 1, 0, plain)).toBe("dismiss");
    expect(resolveSheetDrag(20, 0.8, plain)).toBe("dismiss");
    expect(resolveSheetDrag(40, 0.1, plain)).toBe("stay");
    expect(resolveSheetDrag(-120, -1, plain)).toBe("stay");
  });

  it("expands a half-height sheet upward, collapses it before closing", () => {
    expect(resolveSheetDrag(-(SHEET_EXPAND_DISTANCE_PX + 1), 0, half)).toBe("expand");
    expect(resolveSheetDrag(-20, -0.8, half)).toBe("expand");
    expect(resolveSheetDrag(SHEET_CLOSE_DISTANCE_PX + 1, 0, half)).toBe("dismiss");
    expect(resolveSheetDrag(SHEET_CLOSE_DISTANCE_PX + 1, 0, full)).toBe("collapse");
    expect(resolveSheetDrag(-200, -2, full)).toBe("stay");
  });

  it("lets a content drag expand first at half height and collapse or close only from the top", () => {
    const halfTop = { expanded: false, atTop: true };
    const halfScrolled = { expanded: false, atTop: false };
    const fullTop = { expanded: true, atTop: true };
    const fullScrolled = { expanded: true, atTop: false };
    // Below the slop or mostly sideways: undecided, the browser keeps the gesture.
    expect(claimContentDrag(0, -(CONTENT_DRAG_SLOP_PX - 1), halfTop)).toBeNull();
    expect(claimContentDrag(30, -20, halfTop)).toBeNull();
    // Half height: up expands before any scrolling; down from the top closes.
    expect(claimContentDrag(2, -20, halfTop)).toBe("expand");
    expect(claimContentDrag(0, 40, halfTop)).toBe("dismiss");
    expect(claimContentDrag(0, 40, halfScrolled)).toBeNull();
    // Expanded: up scrolls; down collapses only with the content at its top.
    expect(claimContentDrag(0, -40, fullTop)).toBeNull();
    expect(claimContentDrag(0, 40, fullTop)).toBe("collapse");
    expect(claimContentDrag(0, 40, fullScrolled)).toBeNull();
  });

  it("lets a content drag only close a sheet that cannot expand", () => {
    const top = { expanded: false, atTop: true, expandable: false };
    const scrolled = { expanded: false, atTop: false, expandable: false };
    expect(claimContentDrag(0, -40, top)).toBeNull();
    expect(claimContentDrag(0, 40, top)).toBe("dismiss");
    expect(claimContentDrag(0, 40, scrolled)).toBeNull();
  });
});

describe("content drag lifecycle (real hook)", () => {
  function Sheet(props: { disabled?: boolean; onExpandedChange(expanded: boolean): void; onDismiss(): void }) {
    const sheetRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    useSheetDrag({ sheetRef, contentRef, disabled: props.disabled, expanded: false, onExpandedChange: props.onExpandedChange, onDismiss: props.onDismiss });
    return createElement("div", { ref: sheetRef, id: "sheet" },
      createElement("div", { id: "header" }, "header"),
      createElement("div", { ref: contentRef, id: "content" }, createElement("span", { id: "row" }, "row")));
  }

  async function setup() {
    const dom = createReactDomHarness();
    const onExpandedChange = vi.fn();
    const onDismiss = vi.fn();
    const render = (disabled = false) => dom.render(createElement(Sheet, { disabled, onExpandedChange, onDismiss }));
    await render();
    const doc = dom.container.ownerDocument;
    const row = doc.getElementById("row")!;
    const sheet = doc.getElementById("sheet") as HTMLElement;
    const content = doc.getElementById("content") as HTMLElement;
    Object.defineProperty(content, "scrollTop", { configurable: true, value: 0 });
    let at = 0;
    const touchOn = (target: Element, type: string, y?: number) => {
      const event = new (doc.defaultView as unknown as typeof globalThis).Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: y === undefined ? [] : [{ clientX: 10, clientY: y }] });
      Object.defineProperty(event, "timeStamp", { value: (at += 16) });
      return dom.dispatch(target, event);
    };
    const touch = (type: string, y?: number) => touchOn(row, type, y);
    const downSwipe = async (target: Element = row) => {
      await touchOn(target, "touchstart", 100);
      await touchOn(target, "touchmove", 150);
      await touchOn(target, "touchmove", 220);
      await touchOn(target, "touchend");
    };
    let visibility = "visible";
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => visibility });
    const setVisibility = (next: string) => dom.run(() => {
      visibility = next;
      doc.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event("visibilitychange"));
    });
    const upSwipe = async () => {
      await touch("touchstart", 200);
      await touch("touchmove", 150);
      await touch("touchmove", 100);
      await touch("touchend");
    };
    return { dom, onExpandedChange, onDismiss, render, sheet, content, doc, touch, downSwipe, setVisibility, upSwipe };
  }

  it("closes a half-height sheet on a downward drag from the content top or the header", async () => {
    const t = await setup();
    try {
      await t.downSwipe();
      expect(t.onDismiss).toHaveBeenCalledTimes(1);
      expect(t.onExpandedChange).not.toHaveBeenCalled();
    } finally { await t.dom.dispose(); }
    const h = await setup();
    try {
      // Content scrolled down: the content drag scrolls, the header drag still closes.
      Object.defineProperty(h.content, "scrollTop", { configurable: true, value: 120 });
      await h.downSwipe();
      expect(h.onDismiss).not.toHaveBeenCalled();
      await h.downSwipe(h.doc.getElementById("header")!);
      expect(h.onDismiss).toHaveBeenCalledTimes(1);
    } finally { await h.dom.dispose(); }
  });

  it("expands on an ordinary upward content drag", async () => {
    const t = await setup();
    try {
      await t.upSwipe();
      expect(t.onExpandedChange).toHaveBeenCalledTimes(1);
      expect(t.onExpandedChange).toHaveBeenCalledWith(true);
      expect(t.sheet.style.transform).toBe("");
    } finally { await t.dom.dispose(); }
  });

  it("drops a claimed drag on backgrounding: the late move and release commit nothing", async () => {
    const t = await setup();
    try {
      await t.touch("touchstart", 200);
      await t.touch("touchmove", 100);
      expect(t.sheet.style.transform).not.toBe("");
      await t.setVisibility("hidden");
      expect(t.sheet.style.transform).toBe("");
      await t.setVisibility("visible");
      await t.touch("touchmove", 60);
      expect(t.sheet.style.transform).toBe("");
      await t.touch("touchend");
      expect(t.onExpandedChange).not.toHaveBeenCalled();
      // A fresh drag afterwards works as usual.
      await t.upSwipe();
      expect(t.onExpandedChange).toHaveBeenCalledWith(true);
    } finally { await t.dom.dispose(); }
  });

  it("drops a touch still inside the slop on backgrounding", async () => {
    const t = await setup();
    try {
      await t.touch("touchstart", 200);
      await t.touch("touchmove", 197);
      await t.setVisibility("hidden");
      await t.setVisibility("visible");
      await t.touch("touchmove", 100);
      await t.touch("touchend");
      expect(t.onExpandedChange).not.toHaveBeenCalled();
      expect(t.sheet.style.transform).toBe("");
    } finally { await t.dom.dispose(); }
  });

  it("drops a drag when the sheet becomes disabled (closing)", async () => {
    const t = await setup();
    try {
      await t.touch("touchstart", 200);
      await t.touch("touchmove", 100);
      await t.render(true);
      expect(t.sheet.style.transform).toBe("");
      await t.render(false);
      await t.touch("touchend");
      expect(t.onExpandedChange).not.toHaveBeenCalled();
    } finally { await t.dom.dispose(); }
  });
});

describe("grip drag (real hook)", () => {
  function Sheet(props: { onDismiss(): void }) {
    const sheetRef = useRef<HTMLDivElement>(null);
    const { grip } = useSheetDrag({ sheetRef, onDismiss: props.onDismiss });
    return createElement("div", { ref: sheetRef, id: "sheet" }, createElement("div", { id: "grip", ...grip }));
  }

  async function setup() {
    const dom = createReactDomHarness();
    const onDismiss = vi.fn();
    await dom.render(createElement(Sheet, { onDismiss }));
    const doc = dom.container.ownerDocument;
    const win = doc.defaultView as unknown as typeof globalThis;
    const sheet = doc.getElementById("sheet") as HTMLElement;
    const grip = doc.getElementById("grip") as HTMLElement;
    // Every position the sheet is given, in order.
    const writes: string[] = [];
    const style = sheet.style;
    const logged = new Proxy(style, {
      get: (target, key) => Reflect.get(target, key),
      set: (target, key, value) => { if (key === "transform") writes.push(value); return Reflect.set(target, key, value); },
    });
    Object.defineProperty(sheet, "style", { configurable: true, get: () => logged });
    const captured = new Set<number>();
    Object.assign(grip, {
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    });
    let at = 0;
    const pointer = (type: string, y: number) => {
      const event = new win.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 7, clientY: y, button: 0, isPrimary: true });
      Object.defineProperty(event, "timeStamp", { value: (at += 16) });
      return dom.dispatch(grip, event);
    };
    return { dom, onDismiss, sheet, writes, captured, pointer };
  }

  it("a release that closes exits from the released position, not from 0, and frees only its own capture", async () => {
    const t = await setup();
    try {
      await t.pointer("pointerdown", 100);
      expect(t.captured.has(7)).toBe(true);
      await t.pointer("pointermove", 180);
      await t.pointer("pointermove", 260);
      t.writes.length = 0;
      await t.pointer("pointerup", 260);
      expect(t.onDismiss).toHaveBeenCalledTimes(1);
      expect(t.captured.size).toBe(0);
      // Pinned at 160px, then sent off-screen; never back to 0 or cleared first.
      expect(t.writes[0]).toBe("translateY(160px)");
      expect(t.writes).not.toContain("");
      expect(t.writes).not.toContain("translateY(0px)");
    } finally { await t.dom.dispose(); }
  });

  it("losing the capture mid-drag returns the sheet to rest and later moves do nothing", async () => {
    const t = await setup();
    try {
      await t.pointer("pointerdown", 100);
      await t.pointer("pointermove", 150);
      await t.pointer("lostpointercapture", 150);
      expect(t.sheet.style.transform).toBe("");
      await t.pointer("pointermove", 260);
      await t.pointer("pointerup", 260);
      expect(t.sheet.style.transform).toBe("");
      expect(t.onDismiss).not.toHaveBeenCalled();
    } finally { await t.dom.dispose(); }
  });
});
