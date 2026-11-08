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

/** Icon scale for the svg rule in uiTokens.css; none at 100% so icons get no stacking context by default. */
export const UI_ICON_SCALE_PROPERTY = "--ui-icon-scale";

export function applyUiScale(scale: number, root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement): void {
  if (!root) return;
  const value = isValidUiScale(scale) ? scale : 1;
  root.style.setProperty(UI_SCALE_PROPERTY, String(value));
  root.style.setProperty(UI_ICON_SCALE_PROPERTY, value === 1 ? "none" : String(value));
}

/** Writes the scale before the first paint and whenever it changes. */
export function useUiScaleRoot(scale: number): void {
  useLayoutEffect(() => {
    applyUiScale(scale);
  }, [scale]);
}
