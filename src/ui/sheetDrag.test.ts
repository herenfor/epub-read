import { describe, expect, it } from "vitest";
import { claimContentDrag, CONTENT_DRAG_SLOP_PX, resolveSheetDrag, SHEET_CLOSE_DISTANCE_PX, SHEET_EXPAND_DISTANCE_PX } from "./sheetDrag";

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
