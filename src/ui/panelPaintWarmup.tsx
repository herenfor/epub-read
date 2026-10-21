import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./panelPaintWarmup.css";

/**
 * The first time a panel is drawn in an app run, the GPU prepares what it
 * needs to draw it (phone traces: a 30-50 ms raster/compositor stall and
 * 4-14 dropped frames); later opens reuse that work. Each panel is drawn
 * once, practically invisible and inert, so its first real opening is a
 * second one.
 *
 * Mounting a panel hidden is not enough: a `visibility: hidden` or
 * `opacity: 0` subtree is never drawn. Small batches keep each GPU burst
 * short: the most used panels are drawn while the opening veil still covers
 * the first book of a run (and hold it), the rest one by one once reading
 * is quiet, giving way to any reading input.
 */
export type PanelWarmStage =
  | "aa" | "aa-detailed" | "toc" | "more" | "search" | "reading" | "display" | "fonts" | "bookmark-pages"
  /** Shelf settings: its home page, then every section page (ShelfView). */
  | "shelf-settings" | "shelf-settings-pages";
export type PanelWarmBatch = readonly PanelWarmStage[];

/**
 * How long a batch stays drawn after its first two frames; the GPU needs
 * longer for more panels (shorter holds were measured to lose part of it).
 */
export const PANEL_WARM_HOLD_MS = 150;
export const PANEL_WARM_HOLD_PER_PANEL_MS = 50;
export const panelWarmHold = (batch: PanelWarmBatch): number =>
  Math.max(PANEL_WARM_HOLD_MS, PANEL_WARM_HOLD_PER_PANEL_MS * batch.length);
/** Quiet reading time before the after-veil batches start or resume. */
export const PANEL_WARM_IDLE_DELAY_MS = 500;
/** Pause between two after-veil batches. */
export const PANEL_WARM_IDLE_GAP_MS = 250;

const warmedThisRun = new Set<PanelWarmStage>();

export function nextPanelWarmBatch(
  batches: readonly PanelWarmBatch[],
  warmed: ReadonlySet<PanelWarmStage>,
): PanelWarmBatch | null {
  return batches.find((batch) => batch.some((stage) => !warmed.has(stage))) ?? null;
}

/**
 * `ready`: the first page is shown and nothing is open. `pending` holds the
 * veil while veil batches remain in this run; it is never true while `ready`
 * is false, so the veil cannot wait on a stopped warm-up. `interrupt` is fed
 * reading input: it ends an after-veil batch unfinished and waits for quiet.
 */
export function usePanelPaintWarmup(
  ready: boolean,
  veilBatches: readonly PanelWarmBatch[],
  idleBatches: readonly PanelWarmBatch[],
  /**
   * Q5: reading is still busy (a page turn in flight or just settled). A GPU
   * first draw during a turn's release animation drops frames, so after-veil
   * batches wait until this is false; read when a batch would start.
   */
  isBusy?: () => boolean,
) {
  const [batch, setBatch] = useState<PanelWarmBatch | null>(null);
  const restartRef = useRef<() => void>(() => {});
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;
  const key = [veilBatches, idleBatches].map((list) => list.map((b) => b.join("+")).join(",")).join("|");
  useEffect(() => {
    setBatch(null);
    if (!ready) return;
    let timer = 0;
    let frame = 0;
    const draw = (next: PanelWarmBatch, after: () => void): void => {
      setBatch(next);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          timer = window.setTimeout(() => {
            for (const stage of next) warmedThisRun.add(stage);
            setBatch(null);
            after();
          }, panelWarmHold(next));
        });
      });
    };
    const scheduleIdle = (delay: number): void => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      timer = window.setTimeout(runIdle, delay);
    };
    const runIdle = (): void => {
      if (isBusyRef.current?.()) {
        scheduleIdle(PANEL_WARM_IDLE_DELAY_MS);
        return;
      }
      const next = nextPanelWarmBatch(idleBatches, warmedThisRun);
      if (next) draw(next, () => scheduleIdle(PANEL_WARM_IDLE_GAP_MS));
    };
    const runVeil = (): void => {
      const next = nextPanelWarmBatch(veilBatches, warmedThisRun);
      if (next) draw(next, () => { timer = window.setTimeout(runVeil, 0); });
      else scheduleIdle(PANEL_WARM_IDLE_DELAY_MS);
    };
    restartRef.current = () => {
      // The veil covers its batches; input only defers the after-veil ones.
      if (nextPanelWarmBatch(veilBatches, warmedThisRun)) return;
      setBatch(null);
      scheduleIdle(PANEL_WARM_IDLE_DELAY_MS);
    };
    runVeil();
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      restartRef.current = () => {};
    };
    // The batch lists are read through their key: callers may pass fresh arrays.
  }, [ready, key]);
  const interrupt = useCallback(() => restartRef.current(), []);
  return {
    warming: (stage: PanelWarmStage): boolean => batch?.includes(stage) ?? false,
    pending: ready && nextPanelWarmBatch(veilBatches, warmedThisRun) !== null,
    interrupt,
  };
}

/**
 * Hosts a panel instance mounted only to be drawn once: practically
 * invisible, inert (no focus, no keyboard, no hits), above the opening veil
 * and without entrance motion. Inactive, it adds nothing around its children.
 */
export function PanelPaintWarmup({ active, children }: { active: boolean; children: ReactNode }) {
  if (!active) return <>{children}</>;
  // React 18 has no typed `inert`; the attribute must exist before children
  // run their mount effects (search focuses its input on mount).
  return <div className="panel-paint-warmup" aria-hidden="true" {...{ inert: "" }}>{children}</div>;
}
