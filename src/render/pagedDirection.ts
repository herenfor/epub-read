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
