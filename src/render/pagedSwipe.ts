/**
 * Minimal single-finger horizontal swipe input for paged reading.
 *
 * The controller only expresses one page/spread step to the caller. It does
 * not calculate columns, chapter boundaries or page numbers.
 */
export interface PagedSwipeHandlers {
  onNext(): void;
  onPrev(): void;
  shouldIgnore(event: Event): boolean;
  /** CSS pixels. Kept local to this input path; no settings/config system. */
  thresholdPx?: number;
}

const HORIZONTAL_RATIO = 1.5;
const DEFAULT_THRESHOLD_PX = 32;
const SUPPRESS_CLICK_MS = 700;

function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = target as (Element & { closest?: (selector: string) => Element | null }) | null;
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.closest(
    "a, button, input, textarea, select, option, [role='button'], [contenteditable='true'], img, svg, video, audio"
  ));
}

function hasActiveSelection(doc: Document): boolean {
  try {
    return Boolean(doc.defaultView?.getSelection()?.toString());
  } catch {
    return false;
  }
}

export function installPagedSwipe(doc: Document, handlers: PagedSwipeHandlers): () => void {
  const threshold = handlers.thresholdPx ?? DEFAULT_THRESHOLD_PX;
  let tracking = false;
  let horizontal = false;
  let startX = 0;
  let startY = 0;
  let suppressClickUntil = 0;

  const reset = (): void => {
    tracking = false;
    horizontal = false;
    startX = 0;
    startY = 0;
  };

  const onTouchStart = (event: TouchEvent): void => {
    // A new real touch starts a new gesture; do not let the previous swipe
    // suppression swallow this gesture's click.
    suppressClickUntil = 0;
    if (event.touches.length !== 1 || hasActiveSelection(doc)) {
      reset();
      return;
    }
    if (isInteractiveTarget(event.target) || handlers.shouldIgnore(event)) {
      reset();
      return;
    }
    const touch = event.touches[0];
    tracking = true;
    horizontal = false;
    startX = touch.clientX;
    startY = touch.clientY;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (!tracking) return;
    if (event.touches.length !== 1 || hasActiveSelection(doc)) {
      reset();
      return;
    }
    const touch = event.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dy) > Math.abs(dx) * HORIZONTAL_RATIO && Math.abs(dy) > 12) {
      reset();
      return;
    }
    if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_RATIO) {
      horizontal = true;
      if (event.cancelable) event.preventDefault();
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (!tracking) return;
    const wasHorizontal = horizontal;
    const touch = event.changedTouches[0];
    const dx = touch ? touch.clientX - startX : 0;
    const dy = touch ? touch.clientY - startY : 0;
    reset();
    if (!wasHorizontal || Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_RATIO) return;
    suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS;
    if (dx < 0) handlers.onNext();
    else handlers.onPrev();
  };

  const onTouchCancel = (): void => {
    reset();
  };

  const onClickCapture = (event: Event): void => {
    if (Date.now() >= suppressClickUntil) return;
    suppressClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  doc.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  doc.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  doc.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  doc.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });
  doc.addEventListener("pointercancel", onTouchCancel, true);
  doc.addEventListener("click", onClickCapture, true);

  return () => {
    doc.removeEventListener("touchstart", onTouchStart, true);
    doc.removeEventListener("touchmove", onTouchMove, true);
    doc.removeEventListener("touchend", onTouchEnd, true);
    doc.removeEventListener("touchcancel", onTouchCancel, true);
    doc.removeEventListener("pointercancel", onTouchCancel, true);
    doc.removeEventListener("click", onClickCapture, true);
  };
}
