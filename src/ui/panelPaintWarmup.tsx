import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./panelPaintWarmup.css";

/**
 * The first time a panel is drawn in an app run, the GPU prepares what it
 * needs to draw it (phone traces: a 30-50 ms raster/compositor stall and
 * 4-14 dropped frames); later opens reuse that work. While the reader sits
 * idle after its first page, each panel is drawn once, almost transparent
 * and inert, so the first real opening costs what a second one does.
 *
 * Mounting a panel hidden is not enough: a `visibility: hidden` or
 * `opacity: 0` subtree is never drawn. The stages run one at a time and
 * once per app run, because what they prepare is shared by the whole run.
 */
export type PanelWarmStage = "aa" | "aa-detailed" | "toc" | "more" | "search" | "reading" | "display" | "fonts";

/** Quiet reading time before a stage starts (and after any reading input). */
export const PANEL_WARM_DELAY_MS = 1200;
/** How long a stage stays drawn after its first two frames. */
export const PANEL_WARM_HOLD_MS = 200;

const warmedThisRun = new Set<PanelWarmStage>();

export function nextPanelWarmStage(
  stages: readonly PanelWarmStage[],
  warmed: ReadonlySet<PanelWarmStage>,
): PanelWarmStage | null {
  return stages.find((stage) => !warmed.has(stage)) ?? null;
}

/**
 * `ready`: the reader shows text and nothing is open or loading. Any change
 * of `ready`, and any reading input reported through `interrupt`, ends the
 * current stage unfinished and restarts the quiet delay.
 */
export function usePanelPaintWarmup(ready: boolean, stages: readonly PanelWarmStage[]) {
  const [stage, setStage] = useState<PanelWarmStage | null>(null);
  const restartRef = useRef<() => void>(() => {});
  const stagesKey = stages.join(",");
  useEffect(() => {
    setStage(null);
    if (!ready) return;
    let timer = 0;
    let frame = 0;
    const schedule = (): void => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      timer = window.setTimeout(run, PANEL_WARM_DELAY_MS);
    };
    const run = (): void => {
      const next = nextPanelWarmStage(stages, warmedThisRun);
      if (!next) return;
      setStage(next);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          timer = window.setTimeout(() => {
            warmedThisRun.add(next);
            setStage(null);
            schedule();
          }, PANEL_WARM_HOLD_MS);
        });
      });
    };
    restartRef.current = () => {
      setStage(null);
      schedule();
    };
    schedule();
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      restartRef.current = () => {};
    };
    // `stages` is read through its key: callers may pass a fresh array each render.
  }, [ready, stagesKey]);
  const interrupt = useCallback(() => restartRef.current(), []);
  return { stage, interrupt };
}

/**
 * Hosts a panel instance mounted only to be drawn once: almost transparent,
 * inert (no focus, no keyboard, no hits) and without entrance motion.
 * Inactive, it adds nothing around its children.
 */
export function PanelPaintWarmup({ active, children }: { active: boolean; children: ReactNode }) {
  if (!active) return <>{children}</>;
  // React 18 has no typed `inert`; the attribute must exist before children
  // run their mount effects (search focuses its input on mount).
  return <div className="panel-paint-warmup" aria-hidden="true" {...{ inert: "" }}>{children}</div>;
}
