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
