/**
 * Minimal plain-tap detector for the reader body: touch taps and primary
 * mouse clicks on non-interactive content.
 *
 * It reports where the tap landed (iframe client coordinates) and which
 * input made it; the host decides what that point means. It never prevents
 * default, so links, selection, image activation and native gestures keep
 * their existing priority. The only exception is a repeated click that the
 * host claims as a turn: its word-selecting default is suppressed so rapid
 * clicks keep turning instead of selecting text.
 */
export interface PlainTapPoint {
  clientX: number;
  clientY: number;
}

export interface PlainTapInfo extends PlainTapPoint {
  pointerType: "touch" | "mouse" | "pen";
}

export interface PlainTapHandlers {
  onTap(tap: PlainTapInfo): void;
  shouldIgnore?: () => boolean;
  isBlankImageTap?: (target: Element | null, point: PlainTapPoint) => boolean;
  /** A double/triple click here turns pages, so it must not select a word. */
  claimsRepeatClick?: (point: PlainTapPoint) => boolean;
  /** Primary mouse press that may become a tap (e.g. prepare a page turn before the click). */
  onPress?: (point: PlainTapPoint) => void;
}

const MOVE_TOLERANCE_PX = 10;
/** Compatibility mouse events trail a touch; never count them as a second tap. */
const TOUCH_MOUSE_GUARD_MS = 800;

function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = target as (Element & { closest?: (selector: string) => Element | null }) | null;
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.closest(
    "a, button, input, textarea, select, option, [role='button'], [contenteditable='true'], img, svg, video, audio, note, .duokan-footnote, .zhangyue-footnote"
  ));
}

function hasActiveSelection(doc: Document): boolean {
  try {
    return Boolean(doc.defaultView?.getSelection()?.toString());
  } catch {
    return false;
  }
}

export function installPlainTap(doc: Document, handlers: PlainTapHandlers): () => void {
  let tracking = false;
  let startX = 0;
  let startY = 0;
  let mouseTracking = false;
  let mouseX = 0;
  let mouseY = 0;
  let lastPointerType = "";
  let lastTouchAt = Number.NEGATIVE_INFINITY;

  const reset = (): void => {
    tracking = false;
    startX = 0;
    startY = 0;
  };
  const resetMouse = (): void => {
    mouseTracking = false;
  };
  const blocked = (target: EventTarget | null, point: PlainTapPoint): boolean =>
    (isInteractiveTarget(target) && !handlers.isBlankImageTap?.(target as Element, point)) ||
    hasActiveSelection(doc) ||
    handlers.shouldIgnore?.() === true;

  const onTouchStart = (event: TouchEvent): void => {
    lastTouchAt = Date.now();
    if (event.touches.length !== 1 || blocked(event.target, event.touches[0])) {
      reset();
      return;
    }
    const touch = event.touches[0];
    tracking = true;
    startX = touch.clientX;
    startY = touch.clientY;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (!tracking) return;
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > MOVE_TOLERANCE_PX) {
      reset();
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    lastTouchAt = Date.now();
    if (event.touches.length) { reset(); return; }
    if (!tracking) return;
    const endPoint = event.changedTouches?.[0] ?? { clientX: startX, clientY: startY };
    reset();
    if (blocked(event.target, endPoint)) return;
    handlers.onTap({ clientX: endPoint.clientX, clientY: endPoint.clientY, pointerType: "touch" });
  };

  const onTouchCancel = (): void => {
    reset();
  };

  const onPointerDown = (event: Event): void => {
    lastPointerType = (event as PointerEvent).pointerType ?? "";
  };

  const fromMouse = (): boolean =>
    (lastPointerType === "mouse" || lastPointerType === "pen") && Date.now() - lastTouchAt > TOUCH_MOUSE_GUARD_MS;

  const onMouseDown = (event: MouseEvent): void => {
    resetMouse();
    if (!fromMouse() || event.button !== 0 || blocked(event.target, event)) return;
    if (event.detail >= 2 && handlers.claimsRepeatClick?.(event) === true) event.preventDefault();
    mouseTracking = true;
    mouseX = event.clientX;
    mouseY = event.clientY;
    handlers.onPress?.(event);
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (mouseTracking && Math.hypot(event.clientX - mouseX, event.clientY - mouseY) > MOVE_TOLERANCE_PX) {
      resetMouse();
    }
  };

  const onClick = (event: MouseEvent): void => {
    if (!mouseTracking) return;
    resetMouse();
    if (!fromMouse() || event.button !== 0 || blocked(event.target, event)) return;
    if (Math.hypot(event.clientX - mouseX, event.clientY - mouseY) > MOVE_TOLERANCE_PX) return;
    handlers.onTap({
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: lastPointerType === "pen" ? "pen" : "mouse",
    });
  };

  doc.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  doc.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
  doc.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  doc.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });
  const onPointerCancel = (event: Event): void => {
    if ((event as PointerEvent).pointerType !== "touch") reset();
    resetMouse();
  };
  doc.addEventListener("pointercancel", onPointerCancel, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("mousedown", onMouseDown, true);
  doc.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });
  doc.addEventListener("click", onClick, true);

  return () => {
    doc.removeEventListener("touchstart", onTouchStart, true);
    doc.removeEventListener("touchmove", onTouchMove, true);
    doc.removeEventListener("touchend", onTouchEnd, true);
    doc.removeEventListener("touchcancel", onTouchCancel, true);
    doc.removeEventListener("pointercancel", onPointerCancel, true);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("mousedown", onMouseDown, true);
    doc.removeEventListener("mousemove", onMouseMove, true);
    doc.removeEventListener("click", onClick, true);
  };
}
