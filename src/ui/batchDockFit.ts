import { useLayoutEffect, type RefObject } from "react";

/** Clear space kept on each side of the window. */
export const BATCH_DOCK_GUTTER = 16;

export type BatchDockFit = "full" | "no-info" | "compact";

const STAGES: readonly BatchDockFit[] = ["full", "no-info", "compact"];

/**
 * The desktop batch dock is one centred row as wide as its buttons. When the
 * window is narrower, it first drops the "N selected" count (the top bar
 * already shows it), then switches to the tablet's icon-over-label buttons.
 * Measured rather than set by breakpoints: label widths depend on the
 * language and on which actions this build offers. Writes `data-fit` and
 * returns the stage it chose.
 */
export function fitBatchDock(dock: HTMLElement, viewportWidth: number): BatchDockFit {
  const room = viewportWidth - 2 * BATCH_DOCK_GUTTER;
  for (const stage of STAGES) {
    dock.dataset.fit = stage;
    if (stage === "compact" || dock.offsetWidth <= room) return stage;
  }
  return "compact";
}

/**
 * Re-fits while the dock is shown: on mount, whenever `contentKey` changes
 * (count, language, action set), and on window resize (once per frame).
 */
export function useBatchDockFit(ref: RefObject<HTMLElement | null>, active: boolean, contentKey: string): void {
  useLayoutEffect(() => {
    const dock = ref.current;
    if (!active || !dock) return;
    let frame = 0;
    const fit = (): void => {
      frame = 0;
      fitBatchDock(dock, window.innerWidth);
    };
    const onResize = (): void => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    fit();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, active, contentKey]);
}
