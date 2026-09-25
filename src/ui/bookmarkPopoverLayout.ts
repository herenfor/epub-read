export interface BookmarkPopoverLayout {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/** 极窄/极矮窗口下仍保留可点击的条目高度，避免浮层退化成零高。 */
export const MIN_BOOKMARK_POPOVER_HEIGHT = 120;

/** Viewport coordinates for a fixed, border-box popover outside the toolbar. */
export function bookmarkPopoverLayout(
  anchor: Pick<DOMRectReadOnly, "right" | "bottom">,
  viewport: { width: number; height: number },
): BookmarkPopoverLayout {
  const margin = 8;
  const width = Math.max(0, Math.min(280, viewport.width - margin * 2));
  const top = Math.min(anchor.bottom + margin, Math.max(margin, viewport.height - margin));
  const left = Math.min(
    Math.max(margin, anchor.right - width),
    Math.max(margin, viewport.width - margin - width),
  );
  return {
    left,
    top,
    width,
    maxHeight: Math.max(
      Math.min(MIN_BOOKMARK_POPOVER_HEIGHT, viewport.height / 2),
      Math.min(380, viewport.height / 2, viewport.height - top - margin),
    ),
  };
}
