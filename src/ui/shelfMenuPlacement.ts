import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
    left: clamp(anchor.right - width, leftEdge, rightEdge - width),
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

/** Legacy signature for backwards compatibility with existing unit tests. */
export function chooseShelfMenuPlacement(
  triggerRect: { top: number; bottom: number },
  viewportHeight: number,
  menuHeight: number = 240,
): "up" | "down" {
  const gap = 4;
  const edge = 12;
  const spaceBelow = viewportHeight - triggerRect.bottom - gap - edge;
  const spaceAbove = triggerRect.top - gap - edge;
  if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
    return "up";
  }
  return "down";
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

/**
 * Hook providing position calculation, outside-click detection, and scroll-to-dismiss
 * for portaled shelf card/row popover menus.
 */
export function useShelfMenuPopover(
  menuOpen: boolean,
  setMenuOpen: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const [menuClosing, setMenuClosing] = useState(false);
  const [menuCoords, setMenuCoords] = useState<ShelfMenuPlacementResult | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setMenuClosing(true);
    window.setTimeout(() => {
      setMenuOpen(false);
      setMenuClosing(false);
      setMenuCoords(null);
    }, 140);
  }, [setMenuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen || !triggerRef.current || !menuPanelRef.current) {
      if (!menuOpen) setMenuCoords(null);
      return;
    }
    const btnRect = triggerRef.current.getBoundingClientRect();
    const menuEl = menuPanelRef.current;
    const vv = window.visualViewport;
    const viewport: ShelfMenuViewport = {
      left: vv ? vv.offsetLeft : 0,
      top: vv ? vv.offsetTop : 0,
      width: vv ? vv.width : window.innerWidth,
      height: vv ? vv.height : window.innerHeight,
    };
    const menuSize: ShelfMenuSize = {
      width: menuEl.offsetWidth || 200,
      height: menuEl.offsetHeight || 240,
    };
    setMenuCoords(placeShelfMenu(btnRect, menuSize, viewport));
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuPanelRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeMenu();
    };
    const onScroll = (e: Event): void => {
      if (
        menuPanelRef.current &&
        (e.target === menuPanelRef.current || menuPanelRef.current.contains(e.target as Node))
      ) {
        return;
      }
      closeMenu();
    };
    const onResize = (): void => {
      closeMenu();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, [menuOpen, closeMenu]);

  return {
    menuClosing,
    menuCoords,
    triggerRef,
    menuPanelRef,
    closeMenu,
  };
}
