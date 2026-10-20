import { VIEWER_ID } from "../render/sanitize";
import type { AppliedTextInsets } from "../render/pageLayout";

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
 * Use the reader's published insets, never the animated viewer's margin-left.
 * The normal box stays valid while the compositor retains its wider window.
 * Without a published layout, there is no guide to draw yet.
 */
export function readerTextBox(insets: AppliedTextInsets | undefined, root: ParentNode = document): ScreenBox | null {
  if (!insets) return null;
  const frame = shownChapterFrame(root);
  const doc = frame?.contentDocument;
  const viewer = doc?.getElementById(VIEWER_ID);
  const view = doc?.defaultView;
  if (!frame || !viewer || !view) return null;
  const viewerRect = viewer.getBoundingClientRect();
  return textBoxFromApplied(frame.getBoundingClientRect(), viewerRect.top, viewerRect.height, insets);
}
