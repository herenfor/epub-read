import { describe, expect, it } from "vitest";
import { getContextMenuPlacement, isUsableSelection } from "./ReaderContextMenu";

describe("ReaderContextMenu helpers", () => {
  it("rejects empty selections", () => {
    expect(isUsableSelection(null)).toBe(false);
    expect(isUsableSelection({ text: " \n" })).toBe(false);
    expect(isUsableSelection({ text: "原文" })).toBe(true);
  });

  it("clamps to the viewport and flips at the lower-right edge", () => {
    const placement = getContextMenuPlacement(
      { x: 790, y: 590 },
      { width: 800, height: 600 },
      { width: 176, height: 48 },
    );
    expect(placement.x).toBe(614);
    expect(placement.y).toBe(542);
    expect(placement.horizontal).toBe("left");
    expect(placement.vertical).toBe("above");
  });

  it("keeps a popup usable when it is larger than the viewport", () => {
    const placement = getContextMenuPlacement(
      { x: 0, y: 0 },
      { width: 100, height: 60 },
      { width: 500, height: 500 },
    );
    expect(placement.x).toBe(8);
    expect(placement.y).toBe(8);
  });
});
