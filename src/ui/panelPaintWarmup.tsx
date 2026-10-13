import { useEffect, useState, type ReactNode } from "react";
import "./panelPaintWarmup.css";

/**
 * The first time a panel is drawn in an app run, the GPU prepares what it
 * needs to draw it (phone traces: a 30-50 ms raster/compositor stall and
 * 4-14 dropped frames); later opens reuse that work. While the opening veil
 * still covers the first book of a run, every panel is drawn once, almost
 * transparent and inert, so each first real opening is a second one.
 *
 * Mounting a panel hidden is not enough: a `visibility: hidden` or
 * `opacity: 0` subtree is never drawn. Panels that can share the screen are
 * drawn together in one batch; a batch stays up long enough for the GPU to
 * finish (shorter holds were measured to lose part of the gain).
 */
export type PanelWarmStage = "aa" | "aa-detailed" | "toc" | "more" | "search" | "reading" | "display" | "fonts";
export type PanelWarmBatch = readonly PanelWarmStage[];

/**
 * How long a batch stays drawn after its first two frames. Phone traces show
 * the GPU saturated while a batch is up (six panels: about 250 ms), so the
 * hold grows with its panels.
 */
export const PANEL_WARM_HOLD_MS = 200;
export const PANEL_WARM_HOLD_PER_PANEL_MS = 50;
export const panelWarmHold = (batch: PanelWarmBatch): number =>
  Math.max(PANEL_WARM_HOLD_MS, PANEL_WARM_HOLD_PER_PANEL_MS * batch.length);

const warmedThisRun = new Set<PanelWarmStage>();

export function nextPanelWarmBatch(
  batches: readonly PanelWarmBatch[],
  warmed: ReadonlySet<PanelWarmStage>,
): PanelWarmBatch | null {
  return batches.find((batch) => batch.some((stage) => !warmed.has(stage))) ?? null;
}

/**
 * `ready`: the first page is shown under the veil and nothing is open.
 * `pending` holds the veil while batches remain in this run; it is never
 * true while `ready` is false, so the veil cannot wait on a stopped warm-up.
 */
export function usePanelPaintWarmup(ready: boolean, batches: readonly PanelWarmBatch[]) {
  const [batch, setBatch] = useState<PanelWarmBatch | null>(null);
  const batchesKey = batches.map((b) => b.join("+")).join(",");
  useEffect(() => {
    setBatch(null);
    if (!ready) return;
    let timer = 0;
    let frame = 0;
    const run = (): void => {
      const next = nextPanelWarmBatch(batches, warmedThisRun);
      if (!next) return;
      setBatch(next);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          timer = window.setTimeout(() => {
            for (const stage of next) warmedThisRun.add(stage);
            setBatch(null);
            timer = window.setTimeout(run, 0);
          }, panelWarmHold(next));
        });
      });
    };
    run();
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
    // `batches` is read through its key: callers may pass a fresh array each render.
  }, [ready, batchesKey]);
  return {
    warming: (stage: PanelWarmStage): boolean => batch?.includes(stage) ?? false,
    pending: ready && nextPanelWarmBatch(batches, warmedThisRun) !== null,
  };
}

/**
 * Hosts a panel instance mounted only to be drawn once: almost transparent,
 * inert (no focus, no keyboard, no hits), above the opening veil and without
 * entrance motion. Inactive, it adds nothing around its children.
 */
export function PanelPaintWarmup({ active, children }: { active: boolean; children: ReactNode }) {
  if (!active) return <>{children}</>;
  // React 18 has no typed `inert`; the attribute must exist before children
  // run their mount effects (search focuses its input on mount).
  return <div className="panel-paint-warmup" aria-hidden="true" {...{ inert: "" }}>{children}</div>;
}
