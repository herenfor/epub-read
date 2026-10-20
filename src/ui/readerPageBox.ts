/**
 * The page box the paginator lays text out in: the content box of the shown
 * chapter iframe's parent (its padding is not page). Margins are measured
 * from these edges, so the Aa margin guide insets this box by them. Null
 * when no chapter is on screen.
 */
export function readerPageBox(root: ParentNode = document): DOMRect | null {
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
  const parent = best?.frame.parentElement;
  if (!parent) return null;
  const rect = parent.getBoundingClientRect();
  const style = parent.ownerDocument.defaultView!.getComputedStyle(parent);
  const px = (value: string) => parseFloat(value) || 0;
  const left = rect.left + px(style.paddingLeft) + px(style.borderLeftWidth);
  const top = rect.top + px(style.paddingTop) + px(style.borderTopWidth);
  const right = rect.right - px(style.paddingRight) - px(style.borderRightWidth);
  const bottom = rect.bottom - px(style.paddingBottom) - px(style.borderBottomWidth);
  if (right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}
