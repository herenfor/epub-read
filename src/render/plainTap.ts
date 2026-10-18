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

/**
 * A click synthesized from a touch. Its hit target is computed after touchend,
 * so it can land on a different document than the one that owned the touch.
 */
function isTouchCompatClick(event: MouseEvent): boolean {
  const pointerType = (event as PointerEvent).pointerType;
  if (pointerType === "touch") return true;
  return (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null })
    .sourceCapabilities?.firesTouchEvents === true;
}

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

/**
 * `target` is a chapter document, or a host element that receives its own taps
 * (e.g. an input surface over moving readers). A physical input is consumed only
 * by the target that saw it go down: touches at their own touchend, mouse/pen at
 * click after their own pointerdown. Compatibility clicks never count as intent.
 */
export function installPlainTap(target: Document | HTMLElement, handlers: PlainTapHandlers): () => void {
  const doc = target.nodeType === 9 ? target as Document : target.ownerDocument!;
  let tracking = false;
  let startX = 0;
  let startY = 0;
  let mouseTracking = false;
  let mouseX = 0;
  let mouseY = 0;
  let lastPointerType = "";
  let lastTouchAt = Number.NEGATIVE_INFINITY;
  /** Mouse/pen pointer that went down on this target and has not clicked yet. */
  let pressPointer: number | null = null;

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
    const pointer = event as PointerEvent;
    lastPointerType = pointer.pointerType ?? "";
    pressPointer = lastPointerType === "mouse" || lastPointerType === "pen" ? pointer.pointerId ?? 0 : null;
  };

  const fromMouse = (): boolean =>
    (lastPointerType === "mouse" || lastPointerType === "pen") && Date.now() - lastTouchAt > TOUCH_MOUSE_GUARD_MS;

  const onMouseDown = (event: MouseEvent): void => {
    resetMouse();
    if (pressPointer === null || !fromMouse() || event.button !== 0 || blocked(event.target, event)) return;
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
    const press = pressPointer;
    pressPointer = null;
    const pointerId = (event as PointerEvent).pointerId;
    if (isTouchCompatClick(event) || (typeof pointerId === "number" && pointerId > 0 && press !== null && press > 0 &&
      pointerId !== press)) return;
    if (!fromMouse() || event.button !== 0 || blocked(event.target, event)) return;
    if (Math.hypot(event.clientX - mouseX, event.clientY - mouseY) > MOVE_TOLERANCE_PX) return;
    handlers.onTap({
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: lastPointerType === "pen" ? "pen" : "mouse",
    });
  };

  target.addEventListener("touchstart", onTouchStart as EventListener, { capture: true, passive: true });
  target.addEventListener("touchmove", onTouchMove as EventListener, { capture: true, passive: true });
  target.addEventListener("touchend", onTouchEnd as EventListener, { capture: true, passive: true });
  target.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });
  const onPointerCancel = (event: Event): void => {
    if ((event as PointerEvent).pointerType !== "touch") reset();
    resetMouse();
    pressPointer = null;
  };
  target.addEventListener("pointercancel", onPointerCancel, true);
  target.addEventListener("pointerdown", onPointerDown, true);
  target.addEventListener("mousedown", onMouseDown as EventListener, true);
  target.addEventListener("mousemove", onMouseMove as EventListener, { capture: true, passive: true });
  target.addEventListener("click", onClick as EventListener, true);

  return () => {
    target.removeEventListener("touchstart", onTouchStart as EventListener, true);
    target.removeEventListener("touchmove", onTouchMove as EventListener, true);
    target.removeEventListener("touchend", onTouchEnd as EventListener, true);
    target.removeEventListener("touchcancel", onTouchCancel, true);
    target.removeEventListener("pointercancel", onPointerCancel, true);
    target.removeEventListener("pointerdown", onPointerDown, true);
    target.removeEventListener("mousedown", onMouseDown as EventListener, true);
    target.removeEventListener("mousemove", onMouseMove as EventListener, true);
    target.removeEventListener("click", onClick as EventListener, true);
  };
}
