/**
 * Minimal plain-tap detector for touch-first reader chrome toggling.
 *
 * It only reports a tap on non-interactive content; it never prevents
 * default, so links, selection, image activation and native gestures keep
 * their existing priority.
 */
export interface PlainTapHandlers {
  onTap(): void;
  shouldIgnore?: () => boolean;
  isBlankImageTap?: (target: Element | null, point: { clientX: number; clientY: number }) => boolean;
}

const MOVE_TOLERANCE_PX = 10;

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

  const reset = (): void => {
    tracking = false;
    startX = 0;
    startY = 0;
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (
      event.touches.length !== 1 ||
      (isInteractiveTarget(event.target) && !handlers.isBlankImageTap?.(event.target as Element, event.touches[0])) ||
      hasActiveSelection(doc) ||
      handlers.shouldIgnore?.() === true
    ) {
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
    if (event.touches.length) { reset(); return; }
    if (!tracking) return;
    const endPoint = event.changedTouches?.[0] ?? { clientX: startX, clientY: startY };
    if (isInteractiveTarget(event.target) && !handlers.isBlankImageTap?.(event.target as Element, endPoint)) { reset(); return; }
    const wasTracking = tracking;
    reset();
    if (!wasTracking || hasActiveSelection(doc) || handlers.shouldIgnore?.() === true) return;
    handlers.onTap();
  };

  const onTouchCancel = (): void => {
    reset();
  };

  doc.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  doc.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
  doc.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  doc.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });
  const onPointerCancel = (event: Event): void => {
    if ((event as PointerEvent).pointerType !== "touch") reset();
  };
  doc.addEventListener("pointercancel", onPointerCancel, true);

  return () => {
    doc.removeEventListener("touchstart", onTouchStart, true);
    doc.removeEventListener("touchmove", onTouchMove, true);
    doc.removeEventListener("touchend", onTouchEnd, true);
    doc.removeEventListener("touchcancel", onTouchCancel, true);
    doc.removeEventListener("pointercancel", onPointerCancel, true);
  };
}
