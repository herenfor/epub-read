import { createContext, useContext, useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import "./touchSlider.css";

/** Horizontal travel before a touch on a slider counts as a drag (px). */
export const SLIDER_DRAG_SLOP_PX = 8;
/** The thumb's centre stays this far inside each end (matches touchSlider.css). */
const THUMB_INSET_PX = 10;

export type SliderGesture = "pending" | "drag" | "scroll";

/**
 * How a touch that started on a slider is read after it moved (dx, dy).
 * It stays pending inside the slop; then a mostly sideways move drags the
 * slider and anything else belongs to the page (scrolling the panel).
 */
export function classifySliderGesture(dx: number, dy: number): SliderGesture {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SLIDER_DRAG_SLOP_PX && ay < SLIDER_DRAG_SLOP_PX) return "pending";
  return ax > ay * 1.2 ? "drag" : "scroll";
}

/**
 * Value for a relative drag: the thumb moves by the finger's travel, not to
 * where the finger is, so grabbing anywhere on the row never jumps.
 */
export function sliderDragValue(startValue: number, dx: number, trackWidth: number, min: number, max: number, step: number): number {
  if (trackWidth <= 0) return startValue;
  const raw = startValue + (dx / trackWidth) * (max - min);
  const stepped = Math.round((raw - min) / step) * step + min;
  return Math.min(max, Math.max(min, Math.round(stepped * 1e6) / 1e6));
}

/** Panels that hide everything but the held row while a slider drags (see sliderFocus). */
export interface SliderDragHost {
  begin(row: HTMLElement, key: string): number;
  end(token: number): void;
  /** False once the panel ended this drag (closed, covered): stop changing the value. */
  alive(token: number): boolean;
}

export const SliderDragContext = createContext<SliderDragHost | null>(null);

export interface TouchSliderProps {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange(value: number): void;
  label: string;
  valueText: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A slider that a passing finger cannot change. Touch: nothing happens until
 * the finger has moved sideways past the slop, then the thumb follows the
 * finger's travel; a vertical move scrolls the panel instead, and a tap does
 * nothing (the row's buttons step). Mouse: press on the track jumps there and
 * drags, as desktop users expect. Keys: arrows, Home and End.
 */
export function TouchSlider({ min, max, step, value, onChange, label, valueText, disabled, className }: TouchSliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const host = useContext(SliderDragContext);
  const latest = useRef({ value, onChange, host, min, max, step, disabled });
  latest.current = { value, onChange, host, min, max, step, disabled };

  useEffect(() => {
    const element = ref.current!;
    let gesture: {
      pointerId: number;
      startX: number;
      startY: number;
      startValue: number;
      state: SliderGesture;
      token: number | null;
    } | null = null;
    const trackWidth = (): number => element.getBoundingClientRect().width - 2 * THUMB_INSET_PX;
    const emit = (next: number): void => {
      const token = gesture?.token ?? null;
      if (token !== null && latest.current.host && !latest.current.host.alive(token)) return;
      if (next !== latest.current.value) latest.current.onChange(next);
    };
    const startDrag = (): void => {
      if (!gesture) return;
      gesture.state = "drag";
      element.setAttribute("data-dragging", "");
      try { element.setPointerCapture(gesture.pointerId); } catch { /* pointer already gone */ }
      const row = (element.closest("[data-slider-row], .rd-range-row") as HTMLElement | null) ?? element.parentElement;
      if (row && latest.current.host) gesture.token = latest.current.host.begin(row, row.getAttribute("data-slider-row") ?? "");
    };
    const finish = (): void => {
      if (!gesture) return;
      const { token, pointerId } = gesture;
      gesture = null;
      element.removeAttribute("data-dragging");
      try { if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId); } catch { /* already released */ }
      if (token !== null) latest.current.host?.end(token);
    };
    const down = (event: PointerEvent): void => {
      // Closing the panel invalidates its token even if no pointerup arrives.
      // A newly opened panel must accept the next gesture immediately.
      if (gesture && gesture.token !== null && latest.current.host && !latest.current.host.alive(gesture.token)) finish();
      if (latest.current.disabled || gesture) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const { min: lo, max: hi, step: st } = latest.current;
      gesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startValue: latest.current.value, state: "pending", token: null };
      if (event.pointerType === "mouse") {
        // Desktop: the press itself lands the thumb and starts the drag.
        const rect = element.getBoundingClientRect();
        const width = rect.width - 2 * THUMB_INSET_PX;
        const at = width > 0 ? lo + ((event.clientX - rect.left - THUMB_INSET_PX) / width) * (hi - lo) : latest.current.value;
        const landed = sliderDragValue(at, 0, width, lo, hi, st);
        gesture.startValue = landed;
        startDrag();
        emit(landed);
        event.preventDefault();
      }
    };
    const move = (event: PointerEvent): void => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (gesture.state === "pending") {
        const next = classifySliderGesture(dx, dy);
        if (next === "scroll") {
          // The panel scrolls (touch-action: pan-y); this touch is not ours.
          finish();
          return;
        }
        if (next === "pending") return;
        startDrag();
        // Count travel from here, so crossing the slop is not a jump.
        gesture.startX = event.clientX;
      }
      if (gesture.state !== "drag") return;
      event.preventDefault();
      const { min: lo, max: hi, step: st } = latest.current;
      emit(sliderDragValue(gesture.startValue, event.clientX - gesture.startX, trackWidth(), lo, hi, st));
    };
    const up = (event: PointerEvent): void => {
      if (gesture && event.pointerId === gesture.pointerId) finish();
    };
    // Taking the capture moves it off the inner track the touch landed on;
    // that child's lostpointercapture bubbles here and is not an end.
    const lost = (event: PointerEvent): void => {
      if (event.target === element) up(event);
    };
    const view = element.ownerDocument.defaultView;
    const doc = element.ownerDocument;
    const visibility = (): void => { if (doc.visibilityState === "hidden") finish(); };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("lostpointercapture", lost);
    view?.addEventListener("blur", finish);
    doc.addEventListener("visibilitychange", visibility);
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("lostpointercapture", lost);
      view?.removeEventListener("blur", finish);
      doc.removeEventListener("visibilitychange", visibility);
      finish();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5 };
    let next: number | null = null;
    if (event.key in steps) next = value + steps[event.key] * step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.min(max, Math.max(min, Math.round(next * 1e6) / 1e6));
    if (clamped !== value) onChange(clamped);
  };

  const fraction = max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0;
  return (
    <div
      ref={ref}
      className={`touch-slider${className ? ` ${className}` : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      style={{ "--slider-pos": fraction } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <span className="touch-slider-track" aria-hidden="true">
        <span className="touch-slider-fill" />
      </span>
      <span className="touch-slider-thumb" aria-hidden="true" />
    </div>
  );
}
