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
 */
export function useScrollEdgeFade(ref: RefObject<HTMLElement>, enabled = true): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
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
  }, [ref, enabled]);
}
