import { useCallback, useEffect, useMemo, useRef } from "react";
import { isShelfCardActionTarget } from "./shelfCardEventScope";

/**
 * One press recognizer per shelf card/row: it owns press feedback, the
 * long-press timer and whether the click that ends a gesture may act.
 *
 * Scrolling stays native. Any movement, scroll, second finger, cancel, blur,
 * background or unmount withdraws the press; such a gesture (and one whose
 * long press already fired) swallows its own trailing click only. The next
 * pointerdown is a new gesture, so an independent tap always works.
 */

export type ShelfLongPress = "select" | "drag" | "menu";
/** Where the press happens; decides what a long press means. */
export type ShelfPressSurface = "book" | "folderModalBook" | "row" | "folder";
export type ShelfPressPhase = "pressed" | "charging";

/** Feedback waits a beat so a scroll starting on a card does not flash it. */
export const SHELF_PRESS_FEEDBACK_MS = 60;
/** From here the cover keeps sinking until the long press fires. */
export const SHELF_PRESS_CHARGE_MS = 200;
export const SHELF_LONG_PRESS_MS = 500;
export const SHELF_PRESS_SLOP_PX = 8;
/** A click later than this after the gesture ended is not that gesture's click. */
export const SHELF_PRESS_CLICK_TAIL_MS = 700;
export const SHELF_LONG_PRESS_VIBRATE_MS = 15;

/** Current product semantics: touch long press selects first; drag happens from selection. */
export function shelfLongPressKind(
  surface: ShelfPressSurface,
  pointerType: string,
  selectionMode: boolean,
  can: { select?: boolean; drag?: boolean; menu?: boolean },
): ShelfLongPress | null {
  const touch = pointerType === "touch";
  switch (surface) {
    case "book":
      if (touch) return selectionMode ? (can.drag ? "drag" : null) : (can.select ? "select" : null);
      return !selectionMode && can.drag ? "drag" : null;
    case "folderModalBook":
      return can.drag ? "drag" : null;
    case "row":
      return touch && !selectionMode && can.select ? "select" : null;
    case "folder":
      return touch && !selectionMode && can.menu ? "menu" : null;
  }
}

export interface ShelfPressPointer {
  pointerId: number;
  pointerType: string;
  button: number;
  isPrimary: boolean;
  clientX: number;
  clientY: number;
}

export interface ShelfPressCallbacks {
  longPressKind(pointerType: string): ShelfLongPress | null;
  onLongPress(kind: ShelfLongPress, point: { x: number; y: number }): void;
  setPhase(phase: ShelfPressPhase | null): void;
}

export interface ShelfPressClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const browserClock: ShelfPressClock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

interface ActivePress {
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
  status: "pending" | "fired" | "withdrawn";
}

export class ShelfPressGesture {
  private press: ActivePress | null = null;
  private timers: unknown[] = [];
  /** The last gesture must not act through its click. */
  private consumed = false;
  private endedAt = 0;
  private lastPointerType = "";

  constructor(private readonly callbacks: ShelfPressCallbacks, private readonly clock: ShelfPressClock = browserClock) {}

  get active(): boolean {
    return this.press?.status === "pending";
  }

  /** The pointer type of the gesture in progress or the one that just ended. */
  get pointerType(): string {
    return this.press?.pointerType ?? this.lastPointerType;
  }

  down(pointer: ShelfPressPointer): void {
    if (pointer.isPrimary === false) {
      // A second finger turns the current gesture into a pinch/scroll.
      this.withdraw();
      return;
    }
    if (pointer.button !== 0) return;
    this.clearTimers();
    this.consumed = false;
    this.lastPointerType = pointer.pointerType;
    this.press = { pointerId: pointer.pointerId, pointerType: pointer.pointerType, x: pointer.clientX, y: pointer.clientY, status: "pending" };
    const kind = this.callbacks.longPressKind(pointer.pointerType);
    this.schedule(SHELF_PRESS_FEEDBACK_MS, () => this.callbacks.setPhase("pressed"));
    if (!kind) return;
    this.schedule(SHELF_PRESS_CHARGE_MS, () => this.callbacks.setPhase("charging"));
    this.schedule(SHELF_LONG_PRESS_MS, () => this.fire(kind));
  }

  /**
   * A press that began on a control inside the card (star, three-dot) belongs to that control.
   * Sliding off and releasing over the card makes the browser click the card itself; that click
   * must not open or select.
   */
  foreign(pointer: ShelfPressPointer): void {
    if (pointer.isPrimary === false || pointer.button !== 0) return;
    this.clearTimers();
    this.lastPointerType = pointer.pointerType;
    this.press = { pointerId: pointer.pointerId, pointerType: pointer.pointerType, x: pointer.clientX, y: pointer.clientY, status: "withdrawn" };
    this.consumed = true;
  }

  move(pointer: Pick<ShelfPressPointer, "pointerId" | "clientX" | "clientY">): void {
    const press = this.press;
    if (!press || press.pointerId !== pointer.pointerId || press.status !== "pending") return;
    if (Math.hypot(pointer.clientX - press.x, pointer.clientY - press.y) > SHELF_PRESS_SLOP_PX) this.withdraw();
  }

  /** Pointer released normally: a still-pending press leaves its click to act. */
  up(pointer: Pick<ShelfPressPointer, "pointerId">): void {
    this.finish(pointer.pointerId, false);
  }

  /** pointercancel: the browser took the gesture (usually native scrolling). */
  pointerCancel(pointer: Pick<ShelfPressPointer, "pointerId">): void {
    this.finish(pointer.pointerId, true);
  }

  /** External reasons: scroll, blur, background, another pointer, unmount. */
  withdraw(): void {
    const press = this.press;
    if (!press || press.status !== "pending") return;
    press.status = "withdrawn";
    this.clearTimers();
    this.callbacks.setPhase(null);
    this.consumed = true;
  }

  /** True when this click belongs to a gesture that already acted or was withdrawn. */
  takeClick(): boolean {
    if (this.press) return this.press.status !== "pending";
    if (!this.consumed) return false;
    this.consumed = false;
    return this.clock.now() - this.endedAt <= SHELF_PRESS_CLICK_TAIL_MS;
  }

  dispose(): void {
    this.withdraw();
    this.press = null;
    this.clearTimers();
  }

  private fire(kind: ShelfLongPress): void {
    const press = this.press;
    if (!press || press.status !== "pending") return;
    press.status = "fired";
    this.consumed = true;
    this.clearTimers();
    this.callbacks.setPhase(null);
    this.callbacks.onLongPress(kind, { x: press.x, y: press.y });
  }

  private finish(pointerId: number, cancelled: boolean): void {
    const press = this.press;
    if (!press || press.pointerId !== pointerId) return;
    if (press.status === "pending") {
      this.clearTimers();
      this.callbacks.setPhase(null);
    }
    this.consumed = cancelled || press.status !== "pending";
    this.endedAt = this.clock.now();
    this.press = null;
  }

  private schedule(ms: number, fn: () => void): void {
    this.timers.push(this.clock.setTimeout(fn, ms));
  }

  private clearTimers(): void {
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers = [];
  }
}

export interface ShelfPressOptions {
  longPressKind(pointerType: string): ShelfLongPress | null;
  onLongPress(kind: ShelfLongPress, point: { x: number; y: number }, element: HTMLElement): void;
}

export interface ShelfPressBindings {
  handlers: {
    onPointerDown(event: React.PointerEvent<HTMLElement>): void;
    onPointerMove(event: React.PointerEvent<HTMLElement>): void;
    onPointerUp(event: React.PointerEvent<HTMLElement>): void;
    onPointerCancel(event: React.PointerEvent<HTMLElement>): void;
  };
  /** Call first in onClick: true means the click was this gesture's tail and is swallowed. */
  swallowClick(event: React.MouseEvent): boolean;
  /** Touch long press owns contextmenu; true means it was swallowed. */
  swallowTouchContextMenu(event: React.MouseEvent): boolean;
}

/** DOM wiring for ShelfPressGesture; feedback is written as data-press without re-rendering. */
export function useShelfPress(options: ShelfPressOptions): ShelfPressBindings {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const elementRef = useRef<HTMLElement | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  const gesture = useMemo(() => new ShelfPressGesture({
    longPressKind: (pointerType) => optionsRef.current.longPressKind(pointerType),
    onLongPress: (kind, point) => {
      detachRef.current?.();
      detachRef.current = null;
      if (gesture.pointerType === "touch") {
        try { navigator.vibrate?.(SHELF_LONG_PRESS_VIBRATE_MS); } catch { /* unsupported */ }
      }
      const element = elementRef.current;
      if (element) optionsRef.current.onLongPress(kind, point, element);
    },
    setPhase: (phase) => {
      const element = elementRef.current;
      if (!element) return;
      if (phase) element.dataset.press = phase;
      else delete element.dataset.press;
    },
  }), []);

  const detach = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
  }, []);

  const attach = useCallback((pointerId: number) => {
    detach();
    const withdraw = () => { gesture.withdraw(); detach(); };
    const onOtherPointer = (event: PointerEvent) => { if (event.pointerId !== pointerId) withdraw(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") withdraw(); };
    window.addEventListener("scroll", withdraw, true);
    window.addEventListener("blur", withdraw);
    window.addEventListener("pointerdown", onOtherPointer, true);
    document.addEventListener("visibilitychange", onVisibility);
    detachRef.current = () => {
      window.removeEventListener("scroll", withdraw, true);
      window.removeEventListener("blur", withdraw);
      window.removeEventListener("pointerdown", onOtherPointer, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [detach, gesture]);

  useEffect(() => () => { detach(); gesture.dispose(); }, [detach, gesture]);

  const handlers = useMemo<ShelfPressBindings["handlers"]>(() => ({
    onPointerDown(event) {
      if (event.isPrimary === false) { gesture.withdraw(); detach(); return; }
      // Controls inside the card (three-dot, star, checkbox) own their own press.
      if (isShelfCardActionTarget(event.target, event.currentTarget)) {
        gesture.foreign(event);
        detach();
        return;
      }
      elementRef.current = event.currentTarget;
      gesture.down(event);
      if (gesture.active) attach(event.pointerId);
    },
    onPointerMove(event) {
      gesture.move(event);
      if (!gesture.active) detach();
    },
    onPointerUp(event) {
      gesture.up(event);
      detach();
    },
    onPointerCancel(event) {
      gesture.pointerCancel(event);
      detach();
    },
  }), [attach, detach, gesture]);

  const swallowClick = useCallback((event: React.MouseEvent): boolean => {
    if (!gesture.takeClick()) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, [gesture]);

  const swallowTouchContextMenu = useCallback((event: React.MouseEvent): boolean => {
    const nativeType = (event.nativeEvent as Partial<PointerEvent>).pointerType;
    if (nativeType !== "touch" && !(gesture.pointerType === "touch" && !nativeType)) return false;
    event.preventDefault();
    return true;
  }, [gesture]);

  return { handlers, swallowClick, swallowTouchContextMenu };
}
