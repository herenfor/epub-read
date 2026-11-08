/**
 * Press feedback for quiet buttons (text or icon actions with no resting
 * frame). A phone has no hover, and an Android WebView inside a scrolling
 * list shows `:active` late or not at all, so one delegated listener marks
 * the pressed button with `data-pressed` the moment the finger lands. The
 * mark is held long enough to be seen on a quick tap and is dropped as soon
 * as the finger starts to scroll. Looks live in quietButton.css.
 */

/** Buttons that get the quiet look and press feedback. */
export const QUIET_BUTTON_SELECTOR = ".ui-quiet-btn, .sidebar-note-act, .sidebar-bookmark-del-btn";
/** A quick tap still shows the pressed state for at least this long. */
export const PRESS_MIN_MS = 120;
/** Moving further than this means the finger is scrolling, not pressing. */
export const PRESS_CANCEL_PX = 10;

const PRESSED = "data-pressed";

interface ActivePress {
  button: Element;
  pointerId: number;
  x: number;
  y: number;
  startedAt: number;
}

interface PressTarget {
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: EventListenerOptions): void;
}

export function installPressFeedback(
  root: PressTarget,
  options: { selector?: string; now?: () => number; schedule?: (run: () => void, ms: number) => unknown; cancel?: (id: unknown) => void } = {},
): () => void {
  const selector = options.selector ?? QUIET_BUTTON_SELECTOR;
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
  const cancel = options.cancel ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let active: ActivePress | null = null;
  const pendingRelease = new Map<Element, unknown>();

  const clearMark = (button: Element) => {
    const timer = pendingRelease.get(button);
    if (timer !== undefined) cancel(timer);
    pendingRelease.delete(button);
    button.removeAttribute(PRESSED);
  };

  const onDown = (event: Event) => {
    const e = event as PointerEvent;
    if (e.button !== undefined && e.button > 0) return;
    const target = e.target as Element | null;
    const button = target?.closest?.(selector);
    if (!button || button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true") return;
    if (active) clearMark(active.button);
    clearMark(button);
    button.setAttribute(PRESSED, "");
    active = { button, pointerId: e.pointerId ?? 0, x: e.clientX ?? 0, y: e.clientY ?? 0, startedAt: now() };
  };

  const onMove = (event: Event) => {
    const e = event as PointerEvent;
    if (!active || (e.pointerId ?? 0) !== active.pointerId) return;
    if (Math.hypot((e.clientX ?? 0) - active.x, (e.clientY ?? 0) - active.y) > PRESS_CANCEL_PX) {
      clearMark(active.button);
      active = null;
    }
  };

  const onUp = (event: Event) => {
    const e = event as PointerEvent;
    if (!active || (e.pointerId ?? 0) !== active.pointerId) return;
    const { button, startedAt } = active;
    active = null;
    const left = PRESS_MIN_MS - (now() - startedAt);
    if (left <= 0 || event.type === "pointercancel") {
      clearMark(button);
      return;
    }
    pendingRelease.set(button, schedule(() => {
      pendingRelease.delete(button);
      button.removeAttribute(PRESSED);
    }, left));
  };

  const passive = { capture: true, passive: true } as const;
  root.addEventListener("pointerdown", onDown, passive);
  root.addEventListener("pointermove", onMove, passive);
  root.addEventListener("pointerup", onUp, passive);
  root.addEventListener("pointercancel", onUp, passive);
  return () => {
    root.removeEventListener("pointerdown", onDown, { capture: true });
    root.removeEventListener("pointermove", onMove, { capture: true });
    root.removeEventListener("pointerup", onUp, { capture: true });
    root.removeEventListener("pointercancel", onUp, { capture: true });
    if (active) clearMark(active.button);
    for (const button of [...pendingRelease.keys()]) clearMark(button);
    active = null;
  };
}
