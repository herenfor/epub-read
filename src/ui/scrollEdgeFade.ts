import { useLayoutEffect, type RefObject } from "react";
import "./scrollEdgeFade.css";

/** Which ends of a scroller still hide content ("top", "bottom", both or neither). */
export function scrollEdgeState(element: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">): string {
  const top = element.scrollTop > 1;
  const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
  return [top ? "top" : "", bottom ? "bottom" : ""].filter(Boolean).join(" ");
}

/**
 * Keeps `data-edge-fade` on a scroller in step with its scroll position,
 * size and content (see scrollEdgeFade.css). The attribute is written
 * directly, at most once a frame, so scrolling never re-renders React.
 * Returns the detach function.
 */
export function attachScrollEdgeFade(element: HTMLElement): () => void {
  let frame = 0;
  const update = (): void => {
    frame = 0;
    const state = scrollEdgeState(element);
    if (element.getAttribute("data-edge-fade") !== state) element.setAttribute("data-edge-fade", state);
  };
  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(update);
  };
  update();
  element.addEventListener("scroll", schedule, { passive: true });
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  const observeChildren = (): void => {
    if (!resize) return;
    resize.disconnect();
    resize.observe(element);
    for (const child of Array.from(element.children)) resize.observe(child);
  };
  observeChildren();
  const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
    observeChildren();
    schedule();
  });
  mutation?.observe(element, { childList: true, subtree: true, characterData: true });
  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    element.removeEventListener("scroll", schedule);
    resize?.disconnect();
    mutation?.disconnect();
    element.removeAttribute("data-edge-fade");
  };
}

export function useScrollEdgeFade(ref: RefObject<HTMLElement>, enabled = true): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    return attachScrollEdgeFade(element);
  }, [ref, enabled]);
}

/**
 * Scrolling menus outside the Aa panels that take the edge fade (global menu
 * rule). One list, so adding a menu is one line here plus a look at it.
 */
export const EDGE_FADE_MENUS = [
  ".shelf-settings-scroll",
  ".shelf-filter-body",
  ".sidebar-pane",
  ".search-results",
  ".shelf-move-list",
  ".shelf-folder-modal-body",
  ".shelf-action-sheet-list",
  ".folder-import-issues",
  ".lan-body",
] as const;

/**
 * Attaches the edge fade to every element under `root` that matches
 * `selectors`, now and as menus mount, and detaches when they unmount.
 */
export function installMenuEdgeFades(root: HTMLElement, selectors: readonly string[] = EDGE_FADE_MENUS): () => void {
  const selector = selectors.join(",");
  const attached = new Map<HTMLElement, () => void>();
  const scan = (): void => {
    for (const [element, detach] of attached) {
      if (!element.isConnected) {
        detach();
        attached.delete(element);
      }
    }
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      if (!attached.has(element)) attached.set(element, attachScrollEdgeFade(element));
    }
  };
  let frame = 0;
  const observer = new MutationObserver((records) => {
    // Only element mounts and unmounts matter (text updates while reading do
    // not); the per-element observers follow each menu's own content.
    const elementChanged = (nodes: NodeList) => Array.from(nodes).some((node) => node.nodeType === 1);
    if (frame !== 0 || !records.some((record) => elementChanged(record.addedNodes) || elementChanged(record.removedNodes))) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      scan();
    });
  });
  scan();
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (frame !== 0) cancelAnimationFrame(frame);
    for (const detach of attached.values()) detach();
    attached.clear();
  };
}
