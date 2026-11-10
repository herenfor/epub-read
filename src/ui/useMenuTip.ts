import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent, MouseEvent, PointerEvent, RefObject } from "react";

/** Mouse: how long the pointer rests on a button before its description shows. */
export const TIP_HOVER_MS = 350;
/** Touch: how long a finger holds a button before its description shows instead of the action. */
export const TIP_PRESS_MS = 450;
/** Touch: how long the description stays after the finger lifts. */
export const TIP_LINGER_MS = 1400;
/** Moving on to a neighbour within this time shows its description at once. */
const TIP_WARM_MS = 300;
const TIP_GAP = 6;
const TIP_EDGE = 4;

export interface MenuTip {
  label: string;
  anchor: HTMLElement;
}

export interface MenuTipHandlers {
  onPointerEnter(event: PointerEvent<HTMLElement>): void;
  onPointerLeave(event: PointerEvent<HTMLElement>): void;
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  onPointerUp(event: PointerEvent<HTMLElement>): void;
  onPointerCancel(event: PointerEvent<HTMLElement>): void;
  onFocus(event: FocusEvent<HTMLElement>): void;
  onBlur(event: FocusEvent<HTMLElement>): void;
  onContextMenu(event: MouseEvent<HTMLElement>): void;
}

function showsFocusRing(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * Descriptions for the icon buttons of a floating menu (ER-0166). One bubble
 * for the whole menu, placed over the button it describes and kept inside the
 * viewport. A mouse gets it by resting on a button, a keyboard by focusing it,
 * a finger by holding it; a hold that showed the description does not also run
 * the button (`consumePress`).
 */
export function useMenuTip(menuRef: RefObject<HTMLElement | null>) {
  const [tip, setTip] = useState<MenuTip | null>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const live = useRef({
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    pressed: false,
    touch: false,
    shown: null as HTMLElement | null,
    hiddenAt: 0,
  });

  const hide = useCallback(() => {
    const state = live.current;
    clearTimeout(state.timer);
    if (state.shown) state.hiddenAt = Date.now();
    state.shown = null;
    setTip(null);
  }, []);

  useEffect(() => () => clearTimeout(live.current.timer), []);

  useLayoutEffect(() => {
    const bubble = tipRef.current;
    const menu = menuRef.current;
    if (!tip || !bubble || !menu) return;
    const anchor = tip.anchor.getBoundingClientRect();
    const frame = menu.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();
    const maxLeft = Math.max(TIP_EDGE, window.innerWidth - size.width - TIP_EDGE);
    const left = Math.min(Math.max(TIP_EDGE, anchor.left + anchor.width / 2 - size.width / 2), maxLeft);
    const above = anchor.top - size.height - TIP_GAP;
    const top = above >= TIP_EDGE ? above : anchor.top + anchor.height + TIP_GAP;
    // The bubble is absolute inside the fixed menu: offsets count from its padding box.
    bubble.style.left = `${left - frame.left - (menu.clientLeft || 0)}px`;
    bubble.style.top = `${top - frame.top - (menu.clientTop || 0)}px`;
  }, [tip, menuRef]);

  const bind = useCallback((label: string, options: { press?: boolean } = {}): MenuTipHandlers => {
    const state = live.current;
    const show = (anchor: HTMLElement) => {
      state.shown = anchor;
      setTip({ label, anchor });
    };
    const release = (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse") return;
      clearTimeout(state.timer);
      if (state.pressed) state.timer = setTimeout(hide, TIP_LINGER_MS);
    };
    return {
      onPointerEnter(event) {
        if (event.pointerType !== "mouse") return;
        const anchor = event.currentTarget;
        clearTimeout(state.timer);
        if (Date.now() - state.hiddenAt < TIP_WARM_MS) show(anchor);
        else state.timer = setTimeout(() => show(anchor), TIP_HOVER_MS);
      },
      onPointerLeave(event) {
        if (event.pointerType === "mouse") hide();
        else release(event);
      },
      onPointerDown(event) {
        state.touch = event.pointerType !== "mouse";
        state.pressed = false;
        if (!state.touch) { hide(); return; }
        clearTimeout(state.timer);
        if (options.press === false) { hide(); return; }
        const anchor = event.currentTarget;
        state.timer = setTimeout(() => {
          state.pressed = true;
          show(anchor);
        }, TIP_PRESS_MS);
      },
      onPointerUp: release,
      onPointerCancel: release,
      onFocus(event) {
        // A tap or click focuses the button too, but only the keyboard draws a focus ring.
        if (showsFocusRing(event.currentTarget)) show(event.currentTarget);
      },
      onBlur(event) {
        // A tap moves the focus: the button losing it must not take another button's description away.
        if (state.shown === event.currentTarget) hide();
      },
      onContextMenu(event) {
        // A held finger also raises the system menu on Android; the description replaces it.
        if (state.touch) event.preventDefault();
      },
    };
  }, [hide]);

  /** True once after a hold showed the description: the click that follows must not act. */
  const consumePress = useCallback(() => {
    const pressed = live.current.pressed;
    live.current.pressed = false;
    return pressed;
  }, []);

  return useMemo(() => ({ tip, tipRef, bind, hide, consumePress }), [tip, bind, hide, consumePress]);
}
