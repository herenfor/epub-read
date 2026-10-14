import type { PageProgression } from "./pagedDirection";

export type VerticalWritingMode = "vertical-rl" | "vertical-lr";

/** Use the chapter's computed style, never language or OPF as a layout guess. */
export function basicVerticalMode(writingMode: string, fixedLayout: boolean, scrollMode: boolean): VerticalWritingMode | null {
  if (fixedLayout || scrollMode) return null;
  const mode = writingMode.trim().toLowerCase();
  return mode === "vertical-rl" || mode === "vertical-lr" ? mode : null;
}

export function verticalProgression(mode: VerticalWritingMode): PageProgression {
  return mode === "vertical-rl" ? "rtl" : "ltr";
}

/** Reader defaults, not a prescribed Japanese paper margin ratio. Keep the
 * existing head position; reserve two em at each side and four at the foot. */
export function basicVerticalAutoMargins(
  fontSize: number, base: { top: number; bottom: number; left: number; right: number },
) {
  return { top: base.top, bottom: Math.max(base.bottom, Math.round(4 * fontSize)),
    left: Math.max(base.left, Math.round(2 * fontSize)),
    right: Math.max(base.right, Math.round(2 * fontSize)) };
}

/** JLREQ's integral base-character line length. Keep the head fixed and put
 * the fractional remainder at the foot. Paragraph ends/indentation are free
 * to leave space; this never edits text or forces a short line to justify. */
export function basicVerticalGridBottom(height: number, top: number, bottom: number, fontSize: number): number {
  const available = Math.max(0, height - top - bottom);
  const textHeight = Math.floor(available / fontSize) * fontSize;
  return bottom + available - textHeight;
}

/** The margin belongs to the viewport, not the beginning of the chapter.
 * The body clips a settled leaf to its reading area. During motion the shared
 * compositor window is open, so the margins do not become fixed side strips.
 * A short leaf's unused end is blank, never a slice of the following column. */
export function applyBasicVerticalViewport(
  viewer: HTMLElement, left: number, right: number, mode: VerticalWritingMode,
  width: number, height: number,
): { restore: () => void; beginMotion: () => void; setBlankAfter: (blank: number) => void } {
  const parent = viewer.parentElement!;
  const value = parent.style.getPropertyValue("clip-path");
  const priority = parent.style.getPropertyPriority("clip-path");
  viewer.style.marginLeft = `${left}px`;
  viewer.style.marginRight = `${right}px`;
  viewer.style.paddingLeft = "0px";
  viewer.style.paddingRight = "0px";
  // A chapter can include illustrations wider than the text viewport. Bound
  // them before measuring leaves, using fixed viewport pixels: percentages
  // would grow again when the compositor expands the root to several screens.
  const media = Array.from(viewer.querySelectorAll<HTMLElement>("img,svg,video")).map(element => ({
    element, properties: ["max-width", "max-height"].map(property => ({
      property, value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    })),
  }));
  for (const { element } of media) {
    element.style.setProperty("max-width", `${width}px`, "important");
    element.style.setProperty("max-height", `${height}px`, "important");
  }
  let moving = false;
  const beginMotion = () => {
    if (moving) return;
    moving = true;
    parent.style.setProperty("clip-path", "none");
  };
  const setBlankAfter = (blank: number) => {
    moving = false;
    parent.style.setProperty("clip-path", `inset(0px ${right + (mode === "vertical-lr" ? blank : 0)}px 0px ${left + (mode === "vertical-rl" ? blank : 0)}px)`);
  };
  setBlankAfter(0);
  return { beginMotion, setBlankAfter, restore: () => {
    if (value) parent.style.setProperty("clip-path", value, priority);
    else parent.style.removeProperty("clip-path");
    for (const { element, properties } of media) {
      for (const { property, value, priority } of properties) {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      }
    }
  } };
}

/** Keep the reader's viewport shell horizontal, while the original chapter
 * flows vertically inside it. Snapshot only our own properties for reflow,
 * manual conversion and disposal; do not edit the book or its descendants. */
export function applyBasicVerticalShell(viewer: HTMLElement, mode: VerticalWritingMode): () => void {
  const doc = viewer.ownerDocument;
  const saved = [doc.documentElement, doc.body, viewer].map(element => ({
    element,
    value: element.style.getPropertyValue("writing-mode"),
    priority: element.style.getPropertyPriority("writing-mode"),
  }));
  const marker = viewer.getAttribute("data-reader-vertical");
  viewer.setAttribute("data-reader-vertical", mode);
  doc.documentElement.style.setProperty("writing-mode", "horizontal-tb", "important");
  doc.body.style.setProperty("writing-mode", "horizontal-tb", "important");
  viewer.style.setProperty("writing-mode", mode, "important");
  return () => {
    for (const { element, value, priority } of saved) {
      if (value) element.style.setProperty("writing-mode", value, priority);
      else element.style.removeProperty("writing-mode");
    }
    if (marker === null) viewer.removeAttribute("data-reader-vertical");
    else viewer.setAttribute("data-reader-vertical", marker);
  };
}
