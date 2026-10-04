import { useEffect, useState } from "react";

/** 与 styles.css 的 --menu-open / --menu-close 一致：所有菜单、面板与弹层共用。 */
export const MENU_OPEN_MS = 440;
export const MENU_CLOSE_MS = 200;

/**
 * 关闭时保留挂载 MENU_CLOSE_MS，让退场动画（.is-closing）播完再卸载。
 * 关闭期间重新打开会立即取消退场。
 */
export function useExitPresence(open: boolean, closeMs: number = MENU_CLOSE_MS): { present: boolean; closing: boolean } {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const timer = setTimeout(() => setPresent(false), closeMs);
    return () => clearTimeout(timer);
  }, [open, present, closeMs]);
  return { present: open || present, closing: !open && present };
}
