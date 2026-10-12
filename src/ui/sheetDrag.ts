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

/** Movement before a content drag is classified as sheet drag or native scroll. */
export const CONTENT_DRAG_SLOP_PX = 8;

export type ContentDragClaim = "expand" | "collapse" | null;

/**
 * Whether a vertical drag that began inside the sheet's scrolling content
 * moves the sheet instead of scrolling. `dy` is positive downward.
 * Half height: any upward drag expands first, so content scrolls only once
 * the sheet is tall. Expanded: a downward drag with the content already at
 * its top collapses. Everything else is ordinary scrolling.
 */
export function claimContentDrag(
  dx: number,
  dy: number,
  sheet: { expanded: boolean; atTop: boolean },
): ContentDragClaim {
  if (Math.abs(dy) < CONTENT_DRAG_SLOP_PX || Math.abs(dy) <= Math.abs(dx)) return null;
  if (!sheet.expanded) return dy < 0 ? "expand" : null;
  return dy > 0 && sheet.atTop ? "collapse" : null;
}

/**
 * Controls that own their own drags (sliders, text fields). Buttons and
 * segmented pickers are taps, which a drag past the slop never fires, so
 * they move the sheet like the rest of the content.
 */
const CONTENT_DRAG_EXEMPT = "input, textarea, select, [contenteditable], [role='slider'], [data-sheet-drag='off']";

export interface SheetDragOptions {
  sheetRef: RefObject<HTMLElement>;
  disabled?: boolean;
  onDismiss(): void;
  /** Half-height sheets: pull up to expand, pull down from full height to collapse. */
  expanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
  /** Scrolling body of an expandable sheet: drags inside it can expand or collapse the sheet too. */
  contentRef?: RefObject<HTMLElement>;
  /** Content drags apply only while this returns true (e.g. phone bottom-sheet layout). */
  contentDragEnabled?(): boolean;
}

/**
 * Bottom-sheet grip: the sheet follows a downward drag, resists an upward
 * one, and on release closes, collapses, expands or springs back. Spread
 * `grip` on the grip and header elements. With `contentRef`, drags in the
 * scrolling body expand and collapse the sheet as `claimContentDrag` says.
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

  // Content drags use touch events: they must decide before the browser
  // starts scrolling, and cancel that scroll (non-passive) once claimed.
  const contentRef = options.contentRef;
  const contentExpandable = Boolean(options.onExpandedChange);
  useEffect(() => {
    const contentEl = contentRef?.current;
    if (!contentEl || !contentExpandable) return;
    let gesture: { startX: number; startY: number; lastY: number; lastAt: number; velocity: number; claim: ContentDragClaim | "scroll" } | null = null;
    const onStart = (event: TouchEvent) => {
      const opts = latest.current;
      gesture = null;
      if (opts.disabled || event.touches.length !== 1 || (opts.contentDragEnabled && !opts.contentDragEnabled())) return;
      const target = event.target as Element | null;
      if (target?.closest?.(CONTENT_DRAG_EXEMPT)) return;
      const touch = event.touches[0];
      gesture = { startX: touch.clientX, startY: touch.clientY, lastY: touch.clientY, lastAt: event.timeStamp, velocity: 0, claim: null };
    };
    const onMove = (event: TouchEvent) => {
      if (!gesture || gesture.claim === "scroll") return;
      const touch = event.touches[0];
      const dy = touch.clientY - gesture.startY;
      if (gesture.claim === null) {
        const dx = touch.clientX - gesture.startX;
        const sheetState = { expanded: latest.current.expanded ?? false, atTop: contentEl.scrollTop <= 0 };
        const claim = claimContentDrag(dx, dy, sheetState);
        if (claim === null) {
          if (Math.abs(dy) >= CONTENT_DRAG_SLOP_PX || Math.abs(dx) >= CONTENT_DRAG_SLOP_PX) {
            gesture.claim = "scroll";
          } else if (claimContentDrag(dx, Math.sign(dy) * CONTENT_DRAG_SLOP_PX, sheetState) !== null) {
            // Still inside the slop but heading the claimable way: hold the
            // native scroll now, since the browser stops letting us cancel it
            // once it has started.
            event.preventDefault();
          }
          return;
        }
        gesture.claim = claim;
        setDragging(true);
      }
      event.preventDefault();
      const dt = Math.max(1, event.timeStamp - gesture.lastAt);
      gesture.velocity = (touch.clientY - gesture.lastY) / dt;
      gesture.lastY = touch.clientY;
      gesture.lastAt = event.timeStamp;
      const sheet = latest.current.sheetRef.current;
      if (sheet) sheet.style.transform = `translateY(${gesture.claim === "collapse" ? Math.max(0, dy) : Math.min(0, dy) / 4}px)`;
    };
    const onEnd = (event: TouchEvent) => {
      const state = gesture;
      gesture = null;
      if (!state || (state.claim !== "expand" && state.claim !== "collapse")) return;
      if (event.type === "touchcancel") { endDragRef.current("stay"); return; }
      const outcome = resolveSheetDrag(state.lastY - state.startY, state.velocity, { expandable: true, expanded: state.claim === "collapse" });
      // A content drag only expands or collapses; closing stays on the grip.
      endDragRef.current(outcome === state.claim ? outcome : "stay");
    };
    contentEl.addEventListener("touchstart", onStart, { passive: true });
    contentEl.addEventListener("touchmove", onMove, { passive: false });
    contentEl.addEventListener("touchend", onEnd);
    contentEl.addEventListener("touchcancel", onEnd);
    return () => {
      contentEl.removeEventListener("touchstart", onStart);
      contentEl.removeEventListener("touchmove", onMove);
      contentEl.removeEventListener("touchend", onEnd);
      contentEl.removeEventListener("touchcancel", onEnd);
    };
  }, [contentRef, contentExpandable]);

  return { dragging, grip };
}
