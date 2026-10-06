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
  /** Drag feedback only; never changes the current page. null clears it. */
  onPreview?(dx: number | null): void;
  /** 单指按下（含随后被忽略的手势）：宿主可在此落定进行中的翻页动画。 */
  onGestureStart?(): void;
  /**
   * 该方向是否交给原生横向滚动（scroll-snap）：返回 true 时本手势不拦截
   * touchmove、不预览、抬手不翻页，由原生滚动与吸附完成。
   */
  nativeScroll?(direction: 1 | -1): boolean;
  /** 手指抬起或取消。 */
  onGestureEnd?(): void;
  gestureSurface?: HTMLElement;
  /** CSS pixels. Kept local to this input path; no settings/config system. */
  thresholdPx?: number;
}

const HORIZONTAL_RATIO = 1.2;
const INTENT_THRESHOLD_PX = 8;
export const PAGED_SWIPE_THRESHOLD_PX = 24;
const SUPPRESS_CLICK_MS = 700;
/** 拖出后又往回收超过该距离，视为用户反悔，不翻页。 */
export const PAGED_SWIPE_REVERSAL_PX = 48;

function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = target as (Element & { closest?: (selector: string) => Element | null }) | null;
  if (!element || typeof element.closest !== "function") return false;
  // Links/images still accept swipes. Their ordinary click is suppressed only
  // after a page turn; a tap keeps its original action.
  return Boolean(element.closest(
    "button, input, textarea, select, option, [role='button'], [contenteditable='true'], video, audio"
  ));
}

function hasActiveSelection(doc: Document): boolean {
  try {
    return Boolean(doc.defaultView?.getSelection()?.toString());
  } catch {
    return false;
  }
}

export function installPagedSwipe(target: Document | HTMLElement, handlers: PagedSwipeHandlers): () => void {
  const doc = target.nodeType === 9 ? target as Document : target.ownerDocument!;
  const surface = handlers.gestureSurface ?? (target.nodeType === 9 ? doc.documentElement : target as HTMLElement);
  const oldTouchAction = surface.style.getPropertyValue("touch-action");
  const oldTouchPriority = surface.style.getPropertyPriority("touch-action");
  // Reserve horizontal motion before WebView takes over at its touch slop.
  // Native vertical pan and multi-touch gestures remain available.
  surface.style.setProperty("touch-action", "pan-y pinch-zoom", "important");
  const threshold = handlers.thresholdPx ?? PAGED_SWIPE_THRESHOLD_PX;
  let tracking = false;
  let startX = 0;
  let startY = 0;
  let peakAbsDx = 0;
  let suppressClickUntil = 0;
  /** 本手势的横向意图已交给原生滚动。 */
  let native = false;
  /** 宿主要求忽略本手势（未就绪、浮层等）：原生横向滚动也必须拦下。 */
  let blockNative = false;

  const reset = (): void => {
    tracking = false;
    startX = 0;
    startY = 0;
    peakAbsDx = 0;
    native = false;
    handlers.onPreview?.(null);
  };

  // The preview moves the iframe. Screen coordinates stay stable as it moves.
  const x = (touch: Touch): number => touch.screenX ?? touch.clientX;
  const y = (touch: Touch): number => touch.screenY ?? touch.clientY;

  const onTouchStart = (event: TouchEvent): void => {
    // A new real touch starts a new gesture; do not let the previous swipe
    // suppression swallow this gesture's click.
    suppressClickUntil = 0;
    blockNative = false;
    if (event.touches.length === 1) handlers.onGestureStart?.();
    if (event.touches.length !== 1 || hasActiveSelection(doc)) {
      reset();
      return;
    }
    if (isInteractiveTarget(event.target)) {
      reset();
      return;
    }
    if (handlers.shouldIgnore(event)) {
      reset();
      blockNative = Boolean(handlers.nativeScroll);
      return;
    }
    const touch = event.touches[0];
    tracking = true;
    startX = x(touch);
    startY = y(touch);
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (!tracking) {
      if (blockNative && event.cancelable && event.touches.length === 1) event.preventDefault();
      return;
    }
    if (event.touches.length !== 1 || hasActiveSelection(doc) || handlers.shouldIgnore(event)) {
      reset();
      return;
    }
    const touch = event.touches[0];
    const dx = x(touch) - startX;
    const dy = y(touch) - startY;
    // 只在尚未取得横向意图时判纵向。已横拖的手指往回越过起点时 dx 会接近零，
    // 不能因此把少量 dy 误判成新纵向手势，提前回弹并丢弃余下的 touchmove。
    if (peakAbsDx === 0 && Math.abs(dy) > Math.abs(dx) * HORIZONTAL_RATIO && Math.abs(dy) > INTENT_THRESHOLD_PX) {
      reset();
      return;
    }
    if (peakAbsDx > 0 || (Math.abs(dx) >= INTENT_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_RATIO)) {
      if (peakAbsDx === 0 && handlers.nativeScroll?.(dx < 0 ? 1 : -1)) native = true;
      if (native) {
        // 原生滚动接手：不拦截、不预览；只记录以便抬手时不再重复翻页。
        peakAbsDx = Math.max(peakAbsDx, Math.abs(dx));
        return;
      }
      if (event.cancelable) event.preventDefault();
      peakAbsDx = Math.max(peakAbsDx, Math.abs(dx));
      handlers.onPreview?.(dx);
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (event.touches.length === 0) handlers.onGestureEnd?.();
    if (!tracking) return;
    if (native) {
      reset();
      return;
    }
    const touch = event.changedTouches[0];
    const dx = touch ? x(touch) - startX : 0;
    const dy = touch ? y(touch) - startY : 0;
    const reversed = peakAbsDx - Math.abs(dx) > PAGED_SWIPE_REVERSAL_PX;
    reset();
    // A slow/low-frame-rate gesture can cross the threshold at touchend.
    if (event.touches.length || hasActiveSelection(doc) || handlers.shouldIgnore(event) ||
        Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_RATIO || reversed) return;
    suppressClickUntil = Date.now() + SUPPRESS_CLICK_MS;
    if (dx < 0) handlers.onNext();
    else handlers.onPrev();
  };

  const onTouchCancel = (): void => {
    handlers.onGestureEnd?.();
    reset();
  };

  // Android WebView 会在真实单指横滑仍继续发送 touch 事件时先发 touch 型 pointercancel；
  // 此时 touchcancel 才是触摸取消的权威信号，误用 pointercancel 会取消有效横滑。
  const onPointerCancel = (event: Event): void => {
    if ((event as PointerEvent).pointerType === "touch") return;
    reset();
  };

  const onClickCapture = (event: Event): void => {
    if (Date.now() >= suppressClickUntil) return;
    suppressClickUntil = 0;
    event.preventDefault();
    // Image/link activation also listens on this same document in capture phase.
    event.stopImmediatePropagation();
  };

  target.addEventListener("touchstart", onTouchStart as EventListener, { capture: true, passive: true });
  target.addEventListener("touchmove", onTouchMove as EventListener, { capture: true, passive: false });
  target.addEventListener("touchend", onTouchEnd as EventListener, { capture: true, passive: true });
  target.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });
  target.addEventListener("pointercancel", onPointerCancel, true);
  target.addEventListener("click", onClickCapture, true);

  return () => {
    reset();
    if (oldTouchAction) surface.style.setProperty("touch-action", oldTouchAction, oldTouchPriority);
    else surface.style.removeProperty("touch-action");
    target.removeEventListener("touchstart", onTouchStart as EventListener, true);
    target.removeEventListener("touchmove", onTouchMove as EventListener, true);
    target.removeEventListener("touchend", onTouchEnd as EventListener, true);
    target.removeEventListener("touchcancel", onTouchCancel, true);
    target.removeEventListener("pointercancel", onPointerCancel, true);
    target.removeEventListener("click", onClickCapture, true);
  };
}
