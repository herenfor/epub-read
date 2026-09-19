/**
 * L5 compatibility for authored backdrop-filter boxes that Chromium fragments
 * across columns.  The default is to keep the author's blur and only prevent a
 * safe, single-column-sized flow block from being split.  Every write is
 * transactional and restores the exact inline value/priority when validation
 * fails or before the next measure.
 */

const BREAK_MARKER = "data-reader-backdrop-break";

interface RestoreSnapshot {
  element: HTMLElement;
  /** Raw style text preserves author aliases that CSSStyleDeclaration drops. */
  rawStyle: string | null;
  hadMarker: boolean;
  markerValue: string | null;
}

interface ContentBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BackdropCompatibilityGeometry {
  /** Actual content column width, excluding inter-column gap. */
  pageWidth: number;
  /** Column stride: pageWidth + column gap. */
  step: number;
}

export interface BackdropCompatibilityOptions {
  /** Hard cap for the computed-style scan when a backdrop declaration exists. */
  maxElements?: number;
}

function cssNumber(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function contentBoxFor(viewer: HTMLElement, doc: Document): ContentBox | null {
  const rect = viewer.getBoundingClientRect();
  const cs = doc.defaultView?.getComputedStyle(viewer);
  if (!cs || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) {
    return null;
  }
  return {
    left: rect.left + cssNumber(cs.borderLeftWidth) + cssNumber(cs.paddingLeft),
    top: rect.top + cssNumber(cs.borderTopWidth) + cssNumber(cs.paddingTop),
    right: rect.right - cssNumber(cs.borderRightWidth) - cssNumber(cs.paddingRight),
    bottom: rect.bottom - cssNumber(cs.borderBottomWidth) - cssNumber(cs.paddingBottom),
  };
}

function hasBackdropDeclaration(doc: Document, viewer: HTMLElement): boolean {
  try {
    if (viewer.querySelector('[style*="backdrop" i]')) return true;
  } catch {
    // Older DOM shims may not support the case-insensitive attribute flag.
  }
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (/backdrop-filter/i.test(rule.cssText ?? "")) return true;
    }
  }
  return false;
}

function hasComplexDescendant(el: HTMLElement, doc: Document): boolean {
  if (el.querySelector("table, svg, canvas, video, audio, iframe, object, embed, form, button, input, textarea, select")) {
    return true;
  }
  for (const descendant of Array.from(el.querySelectorAll<HTMLElement>("*"))) {
    const cs = doc.defaultView?.getComputedStyle(descendant);
    if (!cs) continue;
    if (cs.position === "absolute" || cs.position === "fixed") return true;
    if (cs.float !== "none") return true;
    if (cs.transform && cs.transform !== "none") return true;
    if (cs.breakInside !== "auto" || cs.breakBefore !== "auto" || cs.breakAfter !== "auto") return true;
  }
  return false;
}

function hasGeneratedContent(el: HTMLElement, doc: Document): boolean {
  const view = doc.defaultView;
  if (!view) return false;
  for (const pseudo of ["::before", "::after"] as const) {
    try {
      const cs = view.getComputedStyle(el, pseudo);
      const content = cs.content;
      if (content && content !== "none" && content !== "normal") return true;
    } catch {
      // Unsupported pseudo selector support is treated as absent.
    }
  }
  return false;
}

function isSafeCandidate(el: HTMLElement, cs: CSSStyleDeclaration, doc: Document): boolean {
  if (el.hasAttribute(BREAK_MARKER)) return false;
  if (cs.display !== "block") return false;
  if (cs.position !== "static") return false;
  if (cs.float !== "none") return false;
  if (cs.breakInside !== "auto" || cs.breakBefore !== "auto" || cs.breakAfter !== "auto") return false;
  if (cs.transform && cs.transform !== "none") return false;
  if (cs.writingMode && !cs.writingMode.startsWith("horizontal-tb")) return false;
  if (cs.overflowX !== "visible" || cs.overflowY !== "visible") return false;
  if (hasComplexDescendant(el, doc) || hasGeneratedContent(el, doc)) return false;
  return true;
}

function snapshotElement(el: HTMLElement): RestoreSnapshot | null {
  if (!el.style) return null;
  return {
    element: el,
    rawStyle: el.getAttribute("style"),
    hadMarker: el.hasAttribute(BREAK_MARKER),
    markerValue: el.getAttribute(BREAK_MARKER),
  };
}

function restoreSnapshot(snapshot: RestoreSnapshot): void {
  if (snapshot.rawStyle === null) snapshot.element.removeAttribute("style");
  else snapshot.element.setAttribute("style", snapshot.rawStyle);
  if (snapshot.hadMarker && snapshot.markerValue !== null) {
    snapshot.element.setAttribute(BREAK_MARKER, snapshot.markerValue);
  } else {
    snapshot.element.removeAttribute(BREAK_MARKER);
  }
}

function relativeColumnStart(rect: DOMRect, contentLeft: number, scrollLeft: number, step: number): number | null {
  const left = rect.left - contentLeft + scrollLeft;
  if (!Number.isFinite(left) || step <= 0) return null;
  return Math.floor(left / step);
}

function fitsColumn(
  rect: DOMRect,
  column: number,
  content: ContentBox,
  geometry: BackdropCompatibilityGeometry,
  scrollLeft: number,
): boolean {
  const left = rect.left - content.left + scrollLeft;
  const right = rect.right - content.left + scrollLeft;
  if (![left, right, rect.top, rect.bottom].every(Number.isFinite)) return false;
  if (right <= left) return false;
  if (rect.top < content.top - 1 || rect.bottom > content.bottom + 1) return false;
  if (Math.floor(left / geometry.step) !== column) return false;
  const columnLeft = column * geometry.step;
  const columnRight = columnLeft + geometry.pageWidth;
  return left >= columnLeft - 1 && right <= columnRight + 1;
}

/** Collect real text Range rects plus replaced/atomic visual boxes. */
function collectVisualRects(el: HTMLElement, doc: Document): DOMRect[] | null {
  const rects: DOMRect[] = [];
  try {
    const walker = doc.createTreeWalker(el, 4); // NodeFilter.SHOW_TEXT
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (!text.data || !/\S/u.test(text.data)) continue;
      const range = doc.createRange();
      range.selectNodeContents(text);
      rects.push(
        ...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
      );
    }
  } catch {
    return null;
  }
  for (const media of Array.from(el.querySelectorAll("img, video, canvas, object, embed"))) {
    rects.push(
      ...Array.from(media.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
    );
  }
  return rects;
}

function validateCandidate(
  el: HTMLElement,
  viewer: HTMLElement,
  doc: Document,
  content: ContentBox,
  geometry: BackdropCompatibilityGeometry,
): boolean {
  const boxRects = Array.from(el.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  if (boxRects.length !== 1) return false;
  const box = boxRects[0];
  const scrollLeft = viewer.scrollLeft;
  const column = relativeColumnStart(box, content.left, scrollLeft, geometry.step);
  if (column === null || !fitsColumn(box, column, content, geometry, scrollLeft)) return false;

  const visualRects = collectVisualRects(el, doc);
  if (!visualRects) return false;
  for (const rect of visualRects) {
    if (!fitsColumn(rect, column, content, geometry, scrollLeft)) return false;
  }
  return true;
}

/**
 * Apply conservative `break-inside: avoid-column` to fragmented backdrop
 * boxes that fit inside one current column.  Returns a restore function, or
 * null when no candidate was accepted.
 */
export function applyBackdropCompatibility(
  doc: Document | null | undefined,
  viewer: HTMLElement | null | undefined,
  geometry: BackdropCompatibilityGeometry,
  options: BackdropCompatibilityOptions = {},
): (() => void) | null {
  if (!doc || !viewer || !Number.isFinite(geometry.pageWidth) || geometry.pageWidth <= 0 ||
    !Number.isFinite(geometry.step) || geometry.step <= 0) {
    return null;
  }
  if (!hasBackdropDeclaration(doc, viewer)) return null;

  const content = contentBoxFor(viewer, doc);
  if (!content || content.bottom <= content.top || content.right <= content.left) return null;
  const maxElements = Math.max(1, Math.floor(options.maxElements ?? 2000));
  const accepted: RestoreSnapshot[] = [];

  for (const el of Array.from(viewer.querySelectorAll<HTMLElement>("*")).slice(0, maxElements)) {
    const cs = doc.defaultView?.getComputedStyle(el);
    if (!cs) continue;
    const backdrop = cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter");
    const webkitBackdrop = cs.getPropertyValue("-webkit-backdrop-filter");
    if (!((backdrop && backdrop !== "none") || (webkitBackdrop && webkitBackdrop !== "none"))) continue;
    if (!isSafeCandidate(el, cs, doc)) continue;

    const currentRects = Array.from(el.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
    if (currentRects.length <= 1) continue;

    const usedHeight = Number.parseFloat(cs.height);
    if (!Number.isFinite(usedHeight) || usedHeight <= 0 || usedHeight > content.bottom - content.top) continue;

    const snapshot = snapshotElement(el);
    if (!snapshot) continue;
    const rawStyle = snapshot.rawStyle ?? "";
    const separator = rawStyle.trim() && !rawStyle.trim().endsWith(";") ? ";" : "";
    el.setAttribute(BREAK_MARKER, "pending");
    el.setAttribute(
      "style",
      `${rawStyle}${separator} break-inside: avoid-column !important; -webkit-column-break-inside: avoid !important;`
    );
    // Flush layout before validating; one bounded layout read per candidate.
    void viewer.scrollWidth;
    void el.getBoundingClientRect();

    if (validateCandidate(el, viewer, doc, content, geometry)) {
      el.setAttribute(BREAK_MARKER, "applied");
      accepted.push(snapshot);
    } else {
      restoreSnapshot(snapshot);
    }
  }

  // Later candidates can move earlier ones.  Revalidate the accepted set as a
  // group and roll the whole transaction back if any box no longer fits.
  for (const snapshot of accepted) {
    if (!validateCandidate(snapshot.element, viewer, doc, content, geometry)) {
      for (const item of accepted) restoreSnapshot(item);
      return null;
    }
  }

  if (accepted.length === 0) return null;
  return () => {
    for (const snapshot of accepted) restoreSnapshot(snapshot);
  };
}
