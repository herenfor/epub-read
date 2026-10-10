import { useCallback, useEffect, useRef, useState } from "react";

/** Full-motion defaults; CSS-aware exits use menuCloseMs() below. */
export const MENU_OPEN_MS = 440;
export const MENU_CLOSE_MS = 200;

/** CSS is authoritative, including app/system reduced motion. Read only on exit. */
export function menuCloseMs(): number {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return MENU_CLOSE_MS;
  const duration = window.getComputedStyle(document.documentElement).getPropertyValue("--menu-close").trim();
  if (!/^\d+(?:\.\d+)?m?s$/.test(duration)) return MENU_CLOSE_MS;
  return parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
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
export function useExitPresence(open: boolean, closeMs?: number): { present: boolean; closing: boolean } {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const timer = setTimeout(() => setPresent(false), closeMs ?? menuCloseMs());
    return () => clearTimeout(timer);
  }, [open, present, closeMs]);
  return { present: open || present, closing: !open && present };
}
