import { useCallback, useEffect, useRef, useState } from "react";

/** Full-motion defaults; CSS-aware exits use menuCloseMs() below. */
export const MENU_OPEN_MS = 300;
export const MENU_CLOSE_MS = 200;

/** Full-screen page entrance and exit (motionKinds.css), full-motion defaults. */
export const PAGE_OPEN_MS = 320;
export const PAGE_CLOSE_MS = 240;

function cssDurationMs(name: string, fallback: number): number {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return fallback;
  const duration = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!/^\d+(?:\.\d+)?m?s$/.test(duration)) return fallback;
  return parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
}

/** CSS is authoritative, including app/system reduced motion. Read only on exit. */
export function menuCloseMs(): number {
  return cssDurationMs("--menu-close", MENU_CLOSE_MS);
}

/** How long a full-screen page takes to float in. */
export function pageOpenMs(): number {
  return cssDurationMs("--page-in", PAGE_OPEN_MS);
}

/** How long a full-screen page stays mounted while it lifts away. */
export function pageCloseMs(): number {
  return cssDurationMs("--page-out", PAGE_CLOSE_MS);
}

/** Locally closed panels: one exit, canceled on external dismissal or unmount. */
export function useMenuClose(onClose: () => void, open = true) {
  const [isClosing, setIsClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const callback = useRef(onClose);
  callback.current = onClose;
  const cancelClose = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setIsClosing(false);
  }, []);
  const requestClose = useCallback(() => {
    if (timer.current !== undefined || !open) return;
    setIsClosing(true);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setIsClosing(false);
      callback.current();
    }, menuCloseMs());
  }, [open]);
  useEffect(() => {
    if (!open) cancelClose();
    return () => { clearTimeout(timer.current); timer.current = undefined; };
  }, [open, cancelClose]);
  return { isClosing, requestClose, cancelClose };
}

/**
 * 关闭时按当前 CSS 时长保留挂载，让退场动画（.is-closing）播完再卸载。
 * 关闭期间重新打开会立即取消退场。
 */
export function useExitPresence(open: boolean, closeMs?: number | (() => number)): { present: boolean; closing: boolean } {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const ms = typeof closeMs === "function" ? closeMs() : closeMs ?? menuCloseMs();
    const timer = setTimeout(() => setPresent(false), ms);
    return () => clearTimeout(timer);
  }, [open, present, closeMs]);
  return { present: open || present, closing: !open && present };
}
