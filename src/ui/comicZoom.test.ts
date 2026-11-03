import { describe, expect, it } from "vitest";
import { COMIC_ZOOM_MAX, COMIC_ZOOM_NONE, clampComicZoom, panComicZoom, pinchComicZoom, zoomComicAt } from "./comicZoom";

describe("comic in-place zoom", () => {
  it("keeps the content under the fingers while pinching", () => {
    const view = pinchComicZoom(COMIC_ZOOM_NONE, { x: 300, y: 200 }, 100, { x: 300, y: 200 }, 300, 1000, 800);
    expect(view.scale).toBe(3);
    // The point at (300, 200) stays at (300, 200): 300 - 300 * 3.
    expect(view).toEqual({ scale: 3, x: -600, y: -400 });
  });

  it("keeps the content under the fingers when the pinch goes past the cap", () => {
    // 80 px apart to 580 px asks for 7.25x; at the 4x cap (602, 540) still stays put.
    const view = pinchComicZoom(COMIC_ZOOM_NONE, { x: 602, y: 540 }, 80, { x: 602, y: 540 }, 580, 1204, 753);
    expect(view).toEqual({ scale: COMIC_ZOOM_MAX, x: 602 - 602 * COMIC_ZOOM_MAX, y: 540 - 540 * COMIC_ZOOM_MAX });
    expect(zoomComicAt(COMIC_ZOOM_NONE, { x: 550, y: 560 }, 4.2, 1100, 780)).toEqual({ scale: COMIC_ZOOM_MAX, x: -1650, y: -1680 });
  });

  it("never shows an empty edge and caps the scale", () => {
    expect(panComicZoom({ scale: 2, x: -100, y: -100 }, 500, 500, 1000, 800)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(panComicZoom({ scale: 2, x: -100, y: -100 }, -5000, -5000, 1000, 800)).toEqual({ scale: 2, x: -1000, y: -800 });
    expect(zoomComicAt(COMIC_ZOOM_NONE, { x: 0, y: 0 }, 50, 1000, 800).scale).toBe(COMIC_ZOOM_MAX);
  });

  it("squeezes a little under 1 around the center, to spring back on release", () => {
    const view = clampComicZoom({ scale: 0.5, x: 0, y: 0 }, 1000, 800);
    expect(view.scale).toBe(0.85);
    expect(view.x).toBeCloseTo(75);
    expect(view.y).toBeCloseTo(60);
  });
});
