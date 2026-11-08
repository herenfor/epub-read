/** Logical reading offsets stay ascending; only their physical x axis reverses. */
export type PageProgression = "ltr" | "rtl";
export function pageAxisSign(progression: PageProgression): 1 | -1 {
  return progression === "rtl" ? -1 : 1;
}
export function readPageScroll(viewer: Pick<HTMLElement, "scrollLeft">, progression: PageProgression): number {
  // Modern Blink/WebKit RTL scroll origins are zero at the right, negative to
  // the left. Do not clamp: real mid-animation/bounce positions remain useful.
  return viewer.scrollLeft * pageAxisSign(progression);
}
export function writePageScroll(viewer: Pick<HTMLElement, "scrollLeft">, logical: number, progression: PageProgression): void {
  viewer.scrollLeft = logical * pageAxisSign(progression);
}
export function pageContentX(clientX: number, origin: number, scroll: number, progression: PageProgression): number {
  return (clientX - origin) * pageAxisSign(progression) + scroll;
}

/** Physical-axis helpers: in RTL progression the viewer's x axis is mirrored. */
export function contentClientOrigin(
  viewer: HTMLElement | null,
  doc: Document | null,
  progression: PageProgression,
): number {
  if (!viewer) return 0;
  const rect = viewer.getBoundingClientRect();
  const style = doc?.defaultView?.getComputedStyle(viewer);
  return progression === "rtl"
    ? (rect.right ?? rect.left + rect.width) - (parseFloat(style?.borderRightWidth ?? "") || 0) - (parseFloat(style?.paddingRight ?? "") || 0)
    : rect.left + (viewer.clientLeft || 0) + (parseFloat(style?.paddingLeft ?? "") || 0);
}

export function axisClientRect(
  viewer: HTMLElement | null,
  progression: PageProgression,
  rect: { left: number; right: number },
): { left: number; right: number } {
  if (progression !== "rtl" || !viewer) return rect;
  const viewerRect = viewer.getBoundingClientRect();
  const sum = viewerRect.left + viewerRect.right;
  return { left: sum - rect.right, right: sum - rect.left };
}

export function axisContentOrigin(
  viewer: HTMLElement | null,
  doc: Document | null,
  progression: PageProgression,
): number {
  if (progression !== "rtl" || !viewer) return contentClientOrigin(viewer, doc, progression);
  const viewerRect = viewer.getBoundingClientRect();
  return viewerRect.left + viewerRect.right - contentClientOrigin(viewer, doc, progression);
}

/** Change column progression, preserving the authored text direction. No
 * mirror transforms, cloned chapter DOM or changed text/anchor identities. */
export function setPagedFlowDirection(viewer: HTMLElement, progression: PageProgression): () => void {
  const properties: Array<{ element: HTMLElement; value: string; priority: string }> = [];
  const snapshot = (element: HTMLElement): void => {
    properties.push({ element, value: element.style.getPropertyValue("direction"), priority: element.style.getPropertyPriority("direction") });
  };
  const win = viewer.ownerDocument.defaultView;
  const children = Array.from(viewer.children).filter((el): el is HTMLElement => "style" in el);
  // Read before changing the root so an inherited LTR paragraph stays LTR.
  const textDirections = children.map(el => win?.getComputedStyle(el).direction || "ltr");
  snapshot(viewer);
  children.forEach((el, i) => {
    snapshot(el);
    el.style.setProperty("direction", textDirections[i], "important");
  });
  viewer.style.setProperty("direction", progression, "important");
  return () => {
    for (const { element, value, priority } of properties) {
      if (value) element.style.setProperty("direction", value, priority);
      else element.style.removeProperty("direction");
    }
  };
}
