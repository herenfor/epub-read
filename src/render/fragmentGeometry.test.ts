import { describe, expect, it } from "vitest";
import { columnAtPoint, containingFragmentAtPoint, type FragmentSpace } from "./fragmentGeometry";

const geometry = { columnWidth: 100, columnStep: 120 };
const baseSpace: FragmentSpace = { geometry, originClientX: 0, scrollLeft: 0 };

describe("fragment geometry keeps physical columns and 2D coordinates", () => {
  it("maps a point to its physical column and rejects the inter-column gap", () => {
    expect(columnAtPoint({ x: 5, y: 20 }, baseSpace)).toBe(0);
    expect(columnAtPoint({ x: 95, y: 20 }, baseSpace)).toBe(0);
    expect(columnAtPoint({ x: 105, y: 20 }, baseSpace)).toBeNull();
    expect(columnAtPoint({ x: 125, y: 20 }, baseSpace)).toBe(1);
  });

  it("picks the right-column fragment at the same height as a left fragment", () => {
    const fragments = [
      { left: 0, right: 100, top: 10, bottom: 80 },
      { left: 120, right: 220, top: 10, bottom: 80 },
    ];
    expect(containingFragmentAtPoint(fragments, { x: 150, y: 40 }, baseSpace)).toBe(1);
  });

  it("rejects a parent union that spans two columns", () => {
    const union = [{ left: 0, right: 220, top: 10, bottom: 80 }];
    expect(containingFragmentAtPoint(union, { x: 150, y: 40 }, baseSpace)).toBeNull();
  });

  it("keeps the physical column mapping stable with origin and scrollLeft", () => {
    const scrolled: FragmentSpace = {
      geometry,
      originClientX: 40,
      scrollLeft: 80,
    };
    expect(columnAtPoint({ x: 130, y: 20 }, baseSpace)).toBe(1);
    expect(columnAtPoint({ x: 90, y: 20 }, scrolled)).toBe(1);
  });
});
