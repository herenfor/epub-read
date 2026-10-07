import { useCallback, useEffect, useState } from "react";

/**
 * Interface motion level. "full" keeps every panel/menu animation; "reduced"
 * shortens them, drops backdrop blur and skips layout-driven transitions such
 * as the resume card height. Reader page-turn motion is not affected.
 */
export type UiMotion = "full" | "reduced";

const STORAGE_KEY = "epub_ui_motion";

export function readUiMotion(): UiMotion {
  try {
    return localStorage.getItem(STORAGE_KEY) === "reduced" ? "reduced" : "full";
  } catch {
    return "full";
  }
}

/** Mirror the preference on <html data-motion> so CSS can branch on it. */
export function applyUiMotion(motion: UiMotion): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.motion = motion;
}

/** True when either the app switch or the system asks for less motion. */
export function uiMotionReduced(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced") return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function useUiMotion(): [UiMotion, (next: UiMotion) => void] {
  const [motion, setMotion] = useState<UiMotion>(readUiMotion);
  useEffect(() => applyUiMotion(motion), [motion]);
  const update = useCallback((next: UiMotion) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* the in-memory value still applies for this session */
    }
    setMotion(next);
  }, []);
  return [motion, update];
}
