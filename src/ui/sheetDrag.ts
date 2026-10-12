import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** Sheet drag distance or fling speed (px/ms) that closes or collapses it. */
export const SHEET_CLOSE_DISTANCE_PX = 72;
export const SHEET_CLOSE_VELOCITY = 0.5;
/** Upward pull that expands a half-height sheet. */
export const SHEET_EXPAND_DISTANCE_PX = 48;

export type SheetDragOutcome = "dismiss" | "collapse" | "expand" | "stay";

/**
 * What a released drag does. `dy` and `velocity` are positive downward.
 * Expandable sheets collapse from full height before they can be dismissed.
 */
export function resolveSheetDrag(
  dy: number,
  velocity: number,
  sheet: { expandable: boolean; expanded: boolean },
): SheetDragOutcome {
  const down = dy > SHEET_CLOSE_DISTANCE_PX || (dy > 16 && velocity > SHEET_CLOSE_VELOCITY);
  const up = dy < -SHEET_EXPAND_DISTANCE_PX || (dy < -16 && velocity < -SHEET_CLOSE_VELOCITY);
  if (down) return sheet.expandable && sheet.expanded ? "collapse" : "dismiss";
  if (up && sheet.expandable && !sheet.expanded) return "expand";
  return "stay";
}

export interface SheetDragOptions {
  sheetRef: RefObject<HTMLElement>;
  disabled?: boolean;
  onDismiss(): void;
  /** Half-height sheets: pull up to expand, pull down from full height to collapse. */
  expanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
}

/**
 * Bottom-sheet grip: the sheet follows a downward drag, resists an upward
 * one, and on release closes, collapses, expands or springs back. Spread
 * `grip` on the grip and header elements.
 */
export function useSheetDrag(options: SheetDragOptions) {
  const drag = useRef<{ pointerId: number; startY: number; lastY: number; lastAt: number; velocity: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(options);
  latest.current = options;

  const endDrag = (outcome: SheetDragOutcome) => {
    const { sheetRef, onDismiss, onExpandedChange } = latest.current;
    drag.current = null;
    setDragging(false);
    if (sheetRef.current) sheetRef.current.style.transform = "";
    if (outcome === "dismiss") onDismiss();
    else if (outcome === "expand") onExpandedChange?.(true);
    else if (outcome === "collapse") onExpandedChange?.(false);
  };

  // Backgrounding drops a half-finished drag; the sheet itself stays open.
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;
  useEffect(() => {
    if (!dragging) return;
    const onHidden = () => { if (document.visibilityState === "hidden") endDragRef.current("stay"); };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [dragging]);

  const grip = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (latest.current.disabled || event.button !== 0 || !event.isPrimary) return;
      drag.current = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, lastAt: event.timeStamp, velocity: 0 };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
      setDragging(true);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const state = drag.current;
      const sheet = latest.current.sheetRef.current;
      if (!state || !sheet || state.pointerId !== event.pointerId) return;
      const dt = Math.max(1, event.timeStamp - state.lastAt);
      state.velocity = (event.clientY - state.lastY) / dt;
      state.lastY = event.clientY;
      state.lastAt = event.timeStamp;
      const dy = event.clientY - state.startY;
      // Upward pull only gives a little; the sheet never detaches from the bottom.
      sheet.style.transform = `translateY(${dy >= 0 ? dy : dy / 4}px)`;
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const { expanded = false, onExpandedChange } = latest.current;
      endDrag(resolveSheetDrag(event.clientY - state.startY, state.velocity, { expandable: Boolean(onExpandedChange), expanded }));
    },
    onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
      if (drag.current?.pointerId === event.pointerId) endDrag("stay");
    },
  };

  return { dragging, grip };
}
