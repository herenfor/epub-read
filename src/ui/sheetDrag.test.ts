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

  it("lets a content drag expand first at half height and collapse only from the top", () => {
    const halfTop = { expanded: false, atTop: true };
    const fullTop = { expanded: true, atTop: true };
    const fullScrolled = { expanded: true, atTop: false };
    // Below the slop or mostly sideways: undecided, the browser keeps the gesture.
    expect(claimContentDrag(0, -(CONTENT_DRAG_SLOP_PX - 1), halfTop)).toBeNull();
    expect(claimContentDrag(30, -20, halfTop)).toBeNull();
    // Half height: up expands before any scrolling; down is left alone.
    expect(claimContentDrag(2, -20, halfTop)).toBe("expand");
    expect(claimContentDrag(0, 40, halfTop)).toBeNull();
    // Expanded: up scrolls; down collapses only with the content at its top.
    expect(claimContentDrag(0, -40, fullTop)).toBeNull();
    expect(claimContentDrag(0, 40, fullTop)).toBe("collapse");
    expect(claimContentDrag(0, 40, fullScrolled)).toBeNull();
  });
});

describe("content drag lifecycle (real hook)", () => {
  function Sheet(props: { disabled?: boolean; onExpandedChange(expanded: boolean): void }) {
    const sheetRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    useSheetDrag({ sheetRef, contentRef, disabled: props.disabled, expanded: false, onExpandedChange: props.onExpandedChange, onDismiss: () => {} });
    return createElement("div", { ref: sheetRef, id: "sheet" },
      createElement("div", { ref: contentRef, id: "content" }, createElement("span", { id: "row" }, "row")));
  }

  async function setup() {
    const dom = createReactDomHarness();
    const onExpandedChange = vi.fn();
    const render = (disabled = false) => dom.render(createElement(Sheet, { disabled, onExpandedChange }));
    await render();
    const doc = dom.container.ownerDocument;
    const row = doc.getElementById("row")!;
    const sheet = doc.getElementById("sheet") as HTMLElement;
    let at = 0;
    const touch = (type: string, y?: number) => {
      const event = new (doc.defaultView as unknown as typeof globalThis).Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: y === undefined ? [] : [{ clientX: 10, clientY: y }] });
      Object.defineProperty(event, "timeStamp", { value: (at += 16) });
      return dom.dispatch(row, event);
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
    return { dom, onExpandedChange, render, sheet, touch, setVisibility, upSwipe };
  }

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
