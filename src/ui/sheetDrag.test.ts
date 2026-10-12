import { describe, expect, it } from "vitest";
import { resolveSheetDrag, SHEET_CLOSE_DISTANCE_PX, SHEET_EXPAND_DISTANCE_PX } from "./sheetDrag";

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
});
