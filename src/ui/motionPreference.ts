import { useSyncExternalStore } from "react";

/**
 * Interface motion level ("low effects"). "full" keeps every panel/menu
 * animation; "reduced" shortens them, drops all interface backdrop blur and
 * hover lifts, and skips layout-driven transitions such as the resume card
 * height. Reader page-turn motion is not affected. New decorative effects
 * should hang off :root[data-motion="reduced"] rather than a switch of their own.
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

// One value shared by every entry (shelf menu, reader Aa panel).
let current: UiMotion | null = null;
const listeners = new Set<() => void>();

function snapshot(): UiMotion {
  return (current ??= readUiMotion());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setUiMotion(next: UiMotion): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* the in-memory value still applies for this session */
  }
  current = next;
  applyUiMotion(next);
  for (const listener of listeners) listener();
}

export function useUiMotion(): [UiMotion, (next: UiMotion) => void] {
  return [useSyncExternalStore(subscribe, snapshot, () => "full"), setUiMotion];
}
