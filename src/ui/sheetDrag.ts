import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { menuCloseMs } from "./menuMotion";
import { uiMotionReduced } from "./motionPreference";
import { SheetMotion, type SheetDriver, type SheetSettle } from "./sheetMotion";

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

export type ContentDragClaim = "expand" | "collapse" | "dismiss" | null;

/**
 * Whether a vertical drag that began inside the sheet (outside the grip)
 * moves the sheet instead of scrolling. `dy` is positive downward; `atTop`
 * is true when the content is scrolled to its top or the touch began
 * outside it (the header).
 * Half height: any upward drag expands first, so content scrolls only once
 * the sheet is tall; a downward drag from the top closes. Expanded: a
 * downward drag from the top collapses. A sheet that cannot expand
 * (`expandable: false`) only closes on a downward drag from the top.
 * Everything else is ordinary scrolling.
 */
export function claimContentDrag(
  dx: number,
  dy: number,
  sheet: { expanded: boolean; atTop: boolean; expandable?: boolean },
): ContentDragClaim {
  const expandable = sheet.expandable ?? true;
  if (Math.abs(dy) < CONTENT_DRAG_SLOP_PX || Math.abs(dy) <= Math.abs(dx)) return null;
  if (dy < 0) return sheet.expanded || !expandable ? null : "expand";
  if (!sheet.atTop) return null;
  return expandable && sheet.expanded ? "collapse" : "dismiss";
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
  /** Class that gives the sheet its expanded height (measured once per collapse). */
  expandedClassName?: string;
  /**
   * Scrolling body of the sheet. Drags anywhere in the sheet but the grip
   * then expand, collapse or close it as `claimContentDrag` says, scrolling
   * this body when they do not. Without `onExpandedChange` they only close it.
   */
  contentRef?: RefObject<HTMLElement>;
  /** Content drags apply only while this returns true (e.g. phone bottom-sheet layout). */
  contentDragEnabled?(): boolean;
}

/** Spring back / collapse / expand; dismiss uses the CSS menu close duration. */
export const SHEET_SETTLE_MS = 240;
const SETTLE_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const EXIT_EASING = "cubic-bezier(0.4, 0, 1, 1)";

const translate = (offset: number) => `translateY(${offset}px)`;

/** translateY of a computed transform ("none", matrix(...) or matrix3d(...)). */
export function transformOffsetY(transform: string | null | undefined): number {
  if (!transform || transform === "none") return 0;
  const values = /\(([^)]*)\)/.exec(transform)?.[1].split(",").map((part) => parseFloat(part));
  if (!values) return 0;
  if (transform.startsWith("matrix3d") && values.length === 16) return values[13] || 0;
  if (transform.startsWith("matrix") && values.length === 6) return values[5] || 0;
  const px = /translateY\((-?[\d.]+)px\)/.exec(transform);
  return px ? parseFloat(px[1]) : 0;
}

/**
 * DOM side of SheetMotion. The motion owns the sheet's transform: inline
 * while dragging, one Web Animation while settling. Script animations rank
 * above the sheet's CSS keyframes and transitions, so its open/close CSS
 * cannot fight a settle or a drag exit; the open keyframe is canceled when a
 * drag takes over. Without Web Animations (tests) moves land at once.
 */
function createSheetDriver(
  latest: { current: SheetDragOptions },
  requestLayout: (ready: () => void) => void,
): SheetDriver {
  let running: Animation | null = null;
  const sheet = () => latest.current.sheetRef.current;
  const stopRunning = () => {
    const animation = running;
    running = null;
    animation?.cancel();
  };
  const readOffset = (): number => {
    const element = sheet();
    if (!element) return 0;
    try {
      const computed = element.ownerDocument.defaultView?.getComputedStyle(element).transform;
      if (computed) return transformOffsetY(computed);
    } catch { /* detached */ }
    return transformOffsetY(element.style.transform);
  };
  const layoutTop = (element: HTMLElement): number =>
    (typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect().top : 0) - readOffset();
  const hold = (offset: number) => {
    const element = sheet();
    stopRunning();
    if (!element) return;
    // The opening keyframe would override the inline position: a drag takes it over.
    for (const animation of element.getAnimations?.() ?? []) {
      if (animation instanceof (element.ownerDocument.defaultView?.CSSAnimation ?? class {})) animation.cancel();
    }
    element.style.transition = "none";
    element.style.transform = translate(offset);
  };
  const play = (from: number, to: number, duration: number, easing: string, done?: () => void) => {
    const element = sheet();
    stopRunning();
    if (!element) return;
    if (typeof element.animate !== "function" || duration <= 0) {
      element.style.transform = translate(to);
      done?.();
      return;
    }
    // The inline position stays at `from` until the end: a frame before the
    // animation starts still shows where the sheet was, never the target.
    const animation = element.animate([{ transform: translate(from) }, { transform: translate(to) }], { duration, easing, fill: "forwards" });
    running = animation;
    animation.onfinish = () => {
      if (running !== animation) return;
      element.style.transform = translate(to);
      done?.();
    };
  };
  const rest = () => {
    const element = sheet();
    if (element) {
      element.style.transform = "";
      element.style.transition = "";
      element.style.animation = "";
    }
    stopRunning();
  };
  return {
    readOffset,
    hold,
    animate(from, to, _kind: SheetSettle, done) {
      play(from, to, uiMotionReduced() ? 0 : SHEET_SETTLE_MS, SETTLE_EASING, done);
    },
    rest,
    collapsedOffset() {
      const element = sheet();
      const className = latest.current.expandedClassName ?? "is-expanded";
      if (!element || !element.classList.contains(className)) return readOffset();
      const expandedTop = layoutTop(element);
      // Measured on the same frame and restored before paint; React keeps owning the class.
      element.classList.remove(className);
      const collapsedTop = layoutTop(element);
      element.classList.add(className);
      return collapsedTop - expandedTop;
    },
    commitLayout(expanded, ready) {
      const element = sheet();
      const visualTop = element ? layoutTop(element) + readOffset() : 0;
      requestLayout(() => {
        const current = sheet();
        ready(current ? visualTop - layoutTop(current) : 0);
      });
      latest.current.onExpandedChange?.(expanded);
    },
    dismiss(from) {
      const element = sheet();
      const view = element?.ownerDocument.defaultView;
      const exit = element
        ? Math.max(element.offsetHeight || 0, (view?.innerHeight ?? 0) - layoutTop(element))
        : 0;
      // Logical close starts now (closing state, backdrop fade, unmount timer);
      // the exit continues from the released frame and holds until unmount.
      // The sheet's own CSS exit keyframe would start from 0 for a frame
      // before this animation applies (seen on the phone): it never runs here.
      if (element) element.style.animation = "none";
      latest.current.onDismiss();
      play(from, exit, uiMotionReduced() ? 0 : menuCloseMs(), EXIT_EASING);
    },
    release() {
      rest();
    },
  };
}

/**
 * Bottom-sheet grip: the sheet follows a downward drag, resists an upward
 * one, and on release closes, collapses, expands or springs back, always
 * starting from the frame on screen (see SheetMotion). Spread `grip` on the
 * grip and header elements. With `contentRef`, drags elsewhere in the sheet
 * expand, collapse and close it as `claimContentDrag` says.
 *
 * Every way a gesture can end without a release — pointercancel, lost
 * capture, touchcancel, backgrounding, disabled — goes through one
 * interrupt; only a pointer capture this hook took and still holds is released.
 */
type ContentGesture = { startX: number; startY: number; lastY: number; lastAt: number; velocity: number; claim: ContentDragClaim | "scroll"; ticket: number; inContent: boolean };
type GripDrag = { pointerId: number; element: HTMLElement; startY: number; lastY: number; lastAt: number; velocity: number; ticket: number };

export function useSheetDrag(options: SheetDragOptions) {
  const latest = useRef(options);
  latest.current = options;
  const drag = useRef<GripDrag | null>(null);
  // A touch in the content lives here too, so one end/cancel path clears both
  // and a late move or release from a cancelled touch finds nothing to commit.
  const contentGesture = useRef<ContentGesture | null>(null);
  const [dragging, setDragging] = useState(false);

  // Layout compensation runs after React committed the new height (below).
  const pendingLayout = useRef<(() => void) | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);
  const [motion] = useState(() => new SheetMotion(createSheetDriver(latest, (ready) => {
    pendingLayout.current = ready;
    setLayoutTick((tick) => tick + 1);
  })));
  useLayoutEffect(() => {
    const ready = pendingLayout.current;
    pendingLayout.current = null;
    ready?.();
  }, [layoutTick]);

  const releaseCapture = (state: GripDrag | null) => {
    if (!state) return;
    try {
      if (state.element.hasPointerCapture?.(state.pointerId)) state.element.releasePointerCapture(state.pointerId);
    } catch { /* already gone */ }
  };
  const finish = (kind: SheetSettle | null) => {
    const grip = drag.current;
    const content = contentGesture.current;
    drag.current = null;
    contentGesture.current = null;
    releaseCapture(grip);
    setDragging(false);
    const ticket = grip?.ticket ?? (content && content.claim !== "scroll" && content.claim !== null ? content.ticket : null);
    if (kind === null || ticket === null) motion.interrupt();
    else motion.settle(ticket, kind);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  // The single cancel entry: a gesture cut off without a release.
  const interrupt = () => {
    if (drag.current || contentGesture.current) finishRef.current(null);
  };
  const interruptRef = useRef(interrupt);
  interruptRef.current = interrupt;

  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === "hidden") interruptRef.current(); };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      releaseCapture(drag.current);
      drag.current = null;
      contentGesture.current = null;
      pendingLayout.current = null;
      motion.terminate();
    };
  }, [motion]);
  useEffect(() => {
    if (options.disabled) interruptRef.current();
  }, [options.disabled]);

  const grip = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (latest.current.disabled || event.button !== 0 || !event.isPrimary || drag.current) return;
      contentGesture.current = null;
      const ticket = motion.begin();
      drag.current = { pointerId: event.pointerId, element: event.currentTarget, startY: event.clientY, lastY: event.clientY, lastAt: event.timeStamp, velocity: 0, ticket };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
      setDragging(true);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const dt = Math.max(1, event.timeStamp - state.lastAt);
      state.velocity = (event.clientY - state.lastY) / dt;
      state.lastY = event.clientY;
      state.lastAt = event.timeStamp;
      const dy = event.clientY - state.startY;
      // Upward pull only gives a little; the sheet never detaches from the bottom.
      motion.move(state.ticket, dy >= 0 ? dy : dy / 4);
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const { expanded = false, onExpandedChange } = latest.current;
      finish(resolveSheetDrag(event.clientY - state.startY, state.velocity, { expandable: Boolean(onExpandedChange), expanded }));
    },
    onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
      if (drag.current?.pointerId === event.pointerId) interrupt();
    },
    onLostPointerCapture(event: ReactPointerEvent<HTMLElement>) {
      // After a normal release the drag is already gone; otherwise the capture was taken away.
      if (drag.current?.pointerId === event.pointerId) interrupt();
    },
  };

  // Content drags use touch events: they must decide before the browser
  // starts scrolling, and cancel that scroll (non-passive) once claimed.
  // They are heard on the whole sheet so the header drags it too; a grip
  // drag has already started by the time its touch arrives and is skipped.
  const sheetRef = options.sheetRef;
  const contentRef = options.contentRef;
  const contentExpandable = Boolean(options.onExpandedChange);
  useEffect(() => {
    const sheetEl = sheetRef.current;
    const contentEl = contentRef?.current;
    if (!sheetEl || !contentEl) return;
    const onStart = (event: TouchEvent) => {
      const opts = latest.current;
      // A second finger or a new touch never inherits an old gesture.
      if (contentGesture.current) interruptRef.current();
      if (drag.current || opts.disabled || event.touches.length !== 1 || (opts.contentDragEnabled && !opts.contentDragEnabled())) return;
      const target = event.target as Element | null;
      if (target?.closest?.(CONTENT_DRAG_EXEMPT)) return;
      const touch = event.touches[0];
      const inContent = Boolean(target && contentEl.contains(target));
      contentGesture.current = { startX: touch.clientX, startY: touch.clientY, lastY: touch.clientY, lastAt: event.timeStamp, velocity: 0, claim: null, ticket: 0, inContent };
    };
    const onMove = (event: TouchEvent) => {
      const gesture = contentGesture.current;
      if (!gesture || gesture.claim === "scroll") return;
      const touch = event.touches[0];
      if (!touch) return;
      const dy = touch.clientY - gesture.startY;
      if (gesture.claim === null) {
        const dx = touch.clientX - gesture.startX;
        const sheetState = { expanded: latest.current.expanded ?? false, atTop: !gesture.inContent || contentEl.scrollTop <= 0, expandable: contentExpandable };
        const claim = claimContentDrag(dx, dy, sheetState);
        if (claim === null) {
          if (Math.abs(dy) >= CONTENT_DRAG_SLOP_PX || Math.abs(dx) >= CONTENT_DRAG_SLOP_PX) {
            // Native scrolling owns this touch to its end.
            gesture.claim = "scroll";
          } else if (Math.abs(dy) > Math.abs(dx) && claimContentDrag(dx, Math.sign(dy) * CONTENT_DRAG_SLOP_PX, sheetState) !== null) {
            // Still inside the slop but heading the claimable way: hold the
            // native scroll now, since the browser stops letting us cancel it
            // once it has started. Only a mostly vertical start: holding a
            // sideways one would also stop a horizontal row (theme cards) from
            // scrolling for the whole touch.
            event.preventDefault();
          }
          return;
        }
        gesture.claim = claim;
        gesture.ticket = motion.begin();
        setDragging(true);
      }
      event.preventDefault();
      const dt = Math.max(1, event.timeStamp - gesture.lastAt);
      gesture.velocity = (touch.clientY - gesture.lastY) / dt;
      gesture.lastY = touch.clientY;
      gesture.lastAt = event.timeStamp;
      motion.move(gesture.ticket, gesture.claim === "expand" ? Math.min(0, dy) / 4 : Math.max(0, dy));
    };
    const onEnd = (event: TouchEvent) => {
      const state = contentGesture.current;
      if (!state) return;
      if (state.claim === null || state.claim === "scroll") {
        contentGesture.current = null;
        return;
      }
      if (event.type === "touchcancel") { interruptRef.current(); return; }
      const outcome = resolveSheetDrag(state.lastY - state.startY, state.velocity, { expandable: true, expanded: state.claim === "collapse" });
      // A drag settles only the way it was claimed; anything else springs back.
      finishRef.current(outcome === state.claim ? outcome : "stay");
    };
    sheetEl.addEventListener("touchstart", onStart, { passive: true });
    sheetEl.addEventListener("touchmove", onMove, { passive: false });
    sheetEl.addEventListener("touchend", onEnd);
    sheetEl.addEventListener("touchcancel", onEnd);
    return () => {
      sheetEl.removeEventListener("touchstart", onStart);
      sheetEl.removeEventListener("touchmove", onMove);
      sheetEl.removeEventListener("touchend", onEnd);
      sheetEl.removeEventListener("touchcancel", onEnd);
    };
  }, [sheetRef, contentRef, contentExpandable, motion]);

  // A sheet kept mounted while closed starts its next opening from rest:
  // drop any gesture, settle or exit still owning its transform.
  const reset = () => {
    releaseCapture(drag.current);
    drag.current = null;
    contentGesture.current = null;
    pendingLayout.current = null;
    setDragging(false);
    motion.terminate();
  };

  return { dragging, grip, reset };
}
