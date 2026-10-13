import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

/**
 * Opening a book prepares two panels before the opening veil lifts: the Aa
 * panel first, then the contents drawer. Each is mounted closed (hidden,
 * inert, laid out) and kept until the reader is left, so the first real
 * opening reuses it. This is DOM/layout preparation only; a hidden panel is
 * not painted, so its first raster still happens when it opens.
 */
export type PanelPrepStage = "aa" | "toc" | "done";
export interface PanelPrep { key: string; stage: PanelPrepStage }
export type PanelPrepEvent =
  | { type: "start"; key: string }
  | { type: "prepared"; key: string; stage: "aa" | "toc" }
  | { type: "expire"; key: string }
  | { type: "release" };

/** Extra time the veil may wait for the panels; past it the text shows anyway. */
export const PANEL_PREP_BUDGET_MS = 300;

/** Events for another book session, or a stage already passed, change nothing. */
export function panelPrepReducer(state: PanelPrep | null, event: PanelPrepEvent): PanelPrep | null {
  switch (event.type) {
    case "start":
      return state?.key === event.key ? state : { key: event.key, stage: "aa" };
    case "prepared":
      if (!state || state.key !== event.key || state.stage !== event.stage) return state;
      return { key: event.key, stage: event.stage === "aa" ? "toc" : "done" };
    case "expire":
      return state && state.key === event.key && state.stage !== "done" ? { key: event.key, stage: "done" } : state;
    case "release":
      return null;
  }
}

/**
 * `session` is the book session key once its first page is displayed, null
 * otherwise (still loading, or the reader was left: that releases the panels).
 */
export function useOpeningPanelPrep(session: string | null) {
  const [state, dispatch] = useReducer(panelPrepReducer, null);
  // Each reader visit owns its queued work, including re-opening the same book.
  const owner = useMemo(() => ({ key: session }), [session]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const frame = useRef(0);
  useEffect(() => {
    if (!session) {
      dispatch({ type: "release" });
      return;
    }
    dispatch({ type: "start", key: session });
    const timer = setTimeout(() => {
      if (currentOwner.current === owner) dispatch({ type: "expire", key: session });
    }, PANEL_PREP_BUDGET_MS);
    return () => { clearTimeout(timer); cancelAnimationFrame(frame.current); };
  }, [owner]);
  // The next stage starts on the following frame, so the two panels are not
  // built in one task; the frame is a yield point, not a paint/GPU signal.
  const prepared = useCallback((key: string, stage: "aa" | "toc") => {
    if (currentOwner.current !== owner || key !== owner.key) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (currentOwner.current === owner) dispatch({ type: "prepared", key, stage });
    });
  }, [owner]);
  const current = session !== null && state?.key === session ? state : null;
  return {
    /** Aa is mounted (closed) for this session. */
    aa: current !== null,
    /** The contents drawer is mounted (closed) for this session. */
    toc: current !== null && current.stage !== "aa",
    /** The veil still waits for this session's panels. */
    pending: session !== null && current?.stage !== "done",
    prepared,
  };
}
