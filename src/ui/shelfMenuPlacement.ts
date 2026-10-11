/**
 * Viewport placement calculation for shelf popover menus.
 * Inputs and outputs are in CSS viewport coordinates (matching visualViewport).
 */
export interface ShelfMenuAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ShelfMenuSize {
  width: number;
  height: number;
}

export interface ShelfMenuViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ShelfMenuPlacementResult {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "up" | "down";
}

export function placeShelfMenu(
  anchor: ShelfMenuAnchorRect,
  menu: ShelfMenuSize,
  viewport: ShelfMenuViewport,
  /** "end" lines the menu's right edge up with a button; "start" opens rightwards from a cursor. */
  align: "end" | "start" = "end",
): ShelfMenuPlacementResult {
  const edge = 12;
  const gap = 4;
  const leftEdge = viewport.left + edge;
  const topEdge = viewport.top + edge;
  const rightEdge = viewport.left + viewport.width - edge;
  const bottomEdge = viewport.top + viewport.height - edge;
  const maxWidth = Math.max(0, rightEdge - leftEdge);
  const maxHeight = Math.max(0, bottomEdge - topEdge);
  const width = Math.min(menu.width, maxWidth);
  const height = Math.min(menu.height, maxHeight);
  const below = bottomEdge - anchor.bottom - gap;
  const above = anchor.top - gap - topEdge;
  const up = height > below && above > below;
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));
  return {
    left: clamp(align === "start" ? anchor.left : anchor.right - width, leftEdge, rightEdge - width),
    top: clamp(
      up ? anchor.top - gap - height : anchor.bottom + gap,
      topEdge,
      bottomEdge - height,
    ),
    width,
    maxHeight,
    placement: up ? "up" : "down",
  };
}

/**
 * Returns the shared portal host element for shelf popovers.
 * Always prefers the .app container so CSS variables and selectors inherit cleanly.
 */
export function getShelfMenuPortalHost(fallbackContainer?: Element | null): HTMLElement {
  let host = document.getElementById("shelf-menu-portal-host");
  if (host && document.contains(host)) return host;
  const container = (document.querySelector(".app") as HTMLElement | null) ||
    (fallbackContainer?.closest?.(".shelf-view") as HTMLElement | null) ||
    (fallbackContainer as HTMLElement | null) ||
    document.body;
  host = document.createElement("div");
  host.id = "shelf-menu-portal-host";
  host.className = "shelf-menu-portal-host";
  container.appendChild(host);
  return host;
}
