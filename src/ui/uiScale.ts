import { useLayoutEffect } from "react";

/**
 * The UI scale setting (ER-0127). One custom property on the root element
 * drives the --fs-* text tokens and the inline icon rule in uiTokens.css, so
 * every surface follows it: the app, portals, and panels added later. Touch
 * targets, spacing and book pages are unaffected.
 */

export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_PROPERTY = "--ui-scale";

export function isValidUiScale(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= UI_SCALE_MIN && value <= UI_SCALE_MAX;
}

export function applyUiScale(scale: number, root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement): void {
  if (!root) return;
  root.style.setProperty(UI_SCALE_PROPERTY, String(isValidUiScale(scale) ? scale : 1));
}

/** Writes the scale before the first paint and whenever it changes. */
export function useUiScaleRoot(scale: number): void {
  useLayoutEffect(() => {
    applyUiScale(scale);
  }, [scale]);
}
