import { VIEWER_ID } from "../render/sanitize";

/** The book frame the reader shows now (the main layer's visible chapter iframe). */
function shownChapterFrame(root: ParentNode): HTMLIFrameElement | null {
  const host = root.querySelector('.reader-layer[data-role="main"]') ?? root.querySelector(".reader-presentation-host");
  if (!host) return null;
  let best: { frame: HTMLIFrameElement; area: number } | null = null;
  for (const frame of Array.from(host.querySelectorAll("iframe"))) {
    const view = frame.ownerDocument.defaultView;
    if (!view || view.getComputedStyle(frame).visibility === "hidden") continue;
    const rect = frame.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > 0 && (!best || area > best.area)) best = { frame, area };
  }
  return best?.frame ?? null;
}

export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AppliedTextInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The text box in screen coordinates from what the paginator applied: the
 * frame, minus the viewer's own margins and padding at each side (the page
 * margins, automatic ones included, plus any book inset folded into them).
 * The vertical edges follow the viewer's box, which paged layout keeps at
 * the page; the horizontal ones are measured from the frame, because the
 * viewer itself scrolls sideways from page to page.
 */
export function textBoxFromApplied(
  frame: Pick<DOMRect, "left" | "right" | "top">,
  viewerTop: number,
  viewerHeight: number,
  insets: AppliedTextInsets,
): ScreenBox | null {
  const left = frame.left + insets.left;
  const right = frame.right - insets.right;
  const top = frame.top + viewerTop + insets.top;
  const bottom = frame.top + viewerTop + viewerHeight - insets.bottom;
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/**
 * The text box the reader laid out for the chapter on screen, or null when
 * no laid-out chapter is shown. Read after the reader published its layout,
 * so the box always belongs to the layout being displayed.
 */
export function readerTextBox(root: ParentNode = document): ScreenBox | null {
  const frame = shownChapterFrame(root);
  const doc = frame?.contentDocument;
  const viewer = doc?.getElementById(VIEWER_ID);
  const view = doc?.defaultView;
  if (!frame || !viewer || !view) return null;
  const style = view.getComputedStyle(viewer);
  const px = (value: string) => parseFloat(value) || 0;
  const viewerRect = viewer.getBoundingClientRect();
  return textBoxFromApplied(frame.getBoundingClientRect(), viewerRect.top, viewerRect.height, {
    left: px(style.marginLeft) + px(style.paddingLeft),
    right: px(style.marginRight) + px(style.paddingRight),
    top: px(style.paddingTop),
    bottom: px(style.paddingBottom),
  });
}
