/** An in-place zoom of one comic screen: scale, then offset of its top-left corner, in CSS px. */
export interface ComicZoomView { scale: number; x: number; y: number }
export interface ZoomPoint { x: number; y: number }

export const COMIC_ZOOM_MAX = 4;
/** A pinch may squeeze a little under 1 before it springs back. */
const SQUEEZE_MIN = 0.85;
/** Released at or under this, the screen returns to its normal size. */
export const COMIC_ZOOM_RELEASE = 1.03;

export const COMIC_ZOOM_NONE: ComicZoomView = { scale: 1, x: 0, y: 0 };

/** Keeps the zoomed screen covering its box, so no empty edge shows. */
export function clampComicZoom(view: ComicZoomView, width: number, height: number): ComicZoomView {
  const scale = Math.min(COMIC_ZOOM_MAX, Math.max(SQUEEZE_MIN, view.scale));
  if (scale < 1) return { scale, x: width * (1 - scale) / 2, y: height * (1 - scale) / 2 };
  return {
    scale,
    x: Math.min(0, Math.max(width * (1 - scale), view.x)),
    y: Math.min(0, Math.max(height * (1 - scale), view.y)),
  };
}

/**
 * The view during a pinch. Points are relative to the screen's unzoomed box;
 * the content first under the fingers' midpoint follows it.
 */
export function pinchComicZoom(start: ComicZoomView, startMid: ZoomPoint, startDistance: number,
  mid: ZoomPoint, distance: number, width: number, height: number): ComicZoomView {
  const scale = start.scale * distance / Math.max(1, startDistance);
  const contentX = (startMid.x - start.x) / start.scale, contentY = (startMid.y - start.y) / start.scale;
  return clampComicZoom({ scale, x: mid.x - contentX * scale, y: mid.y - contentY * scale }, width, height);
}

/** Zooms by `factor` around a fixed point (a mouse wheel). */
export function zoomComicAt(view: ComicZoomView, point: ZoomPoint, factor: number, width: number, height: number): ComicZoomView {
  return pinchComicZoom(view, point, 1, point, factor, width, height);
}

export function panComicZoom(view: ComicZoomView, dx: number, dy: number, width: number, height: number): ComicZoomView {
  return clampComicZoom({ ...view, x: view.x + dx, y: view.y + dy }, width, height);
}
