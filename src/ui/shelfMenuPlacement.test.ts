import { describe, expect, it } from "vitest";
import { placeShelfMenu } from "./shelfMenuPlacement";

describe("placeShelfMenu geometry", () => {
  it("places menu downwards when enough space below", () => {
    const anchor = { left: 100, right: 148, top: 100, bottom: 148 };
    const menu = { width: 120, height: 160 };
    const viewport = { left: 0, top: 0, width: 384, height: 832 };

    const result = placeShelfMenu(anchor, menu, viewport);
    expect(result.placement).toBe("down");
    expect(result.top).toBe(148 + 4); // bottom + gap
    expect(result.left).toBe(148 - 120); // anchor.right - width
    expect(result.width).toBe(120);
    expect(result.maxHeight).toBe(832 - 12 - 12);
  });

  it("places menu upwards when bottom space is tight and top space is larger", () => {
    const anchor = { left: 100, right: 148, top: 750, bottom: 798 };
    const menu = { width: 120, height: 160 };
    const viewport = { left: 0, top: 0, width: 384, height: 832 };

    const result = placeShelfMenu(anchor, menu, viewport);
    expect(result.placement).toBe("up");
    expect(result.top).toBe(750 - 4 - 160); // top - gap - height
  });

  it("clamps within viewport safe margins", () => {
    // Anchor close to left edge
    const anchor = { left: 5, right: 53, top: 100, bottom: 148 };
    const menu = { width: 200, height: 160 };
    const viewport = { left: 0, top: 0, width: 384, height: 832 };

    const result = placeShelfMenu(anchor, menu, viewport);
    expect(result.left).toBe(12); // clamped to viewport.left + edge (12)
  });
});
