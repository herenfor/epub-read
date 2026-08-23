/**
 * Content-text anchors are deliberately independent of pagination.  This
 * module only observes the chapter DOM and maps normalized text positions to
 * text nodes; it never writes DOM/style values or changes layout.
 */

export const MAX_ANCHOR_SNIPPET_CODE_POINTS = 32;
export const MAX_ANCHOR_TEXT_OFFSET = Number.MAX_SAFE_INTEGER;

export interface TextAnchorData {
  textOffset: number | null;
  textSnippet: string | null;
}

/** A persisted text range used by annotations (end is exclusive). */
export interface TextRangeAnchorData {
  startTextOffset: number;
  endTextOffset: number;
  startTextSnippet: string | null;
  endTextSnippet: string | null;
}

export interface TextSelectionPayload extends TextRangeAnchorData {
  selectedText: string;
  rect: { left: number; top: number; right: number; bottom: number };
}

export interface TextNodePosition {
  node: Text;
  /** DOM Range offsets are UTF-16 code units. */
  rawOffset: number;
}

interface IndexedTextNode {
  node: Text;
  start: number;
  end: number;
  /** UTF-16 offset for each normalized Unicode code point. */
  rawStarts: number[];
  rawEnds: number[];
  rawEnd: number;
}

const WHITESPACE = /\p{White_Space}/u;

function isWhitespace(value: string): boolean {
  return WHITESPACE.test(value);
}

/** The stable persisted representation: Unicode code points, no whitespace. */
export function normalizeAnchorText(value: string): string {
  return Array.from(value).filter((codePoint) => !isWhitespace(codePoint)).join("");
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validOffset(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_ANCHOR_TEXT_OFFSET
  );
}

function validSnippet(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    codePointLength(value) <= MAX_ANCHOR_SNIPPET_CODE_POINTS &&
    normalizeAnchorText(value) === value
  );
}

/**
 * Old JSON may omit these optional keys. New writes use null, while invalid
 * values are discarded as a pair so a hostile snippet cannot affect recovery.
 */
export function sanitizePersistedTextAnchor(value: unknown): TextAnchorData {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const textOffset = input.textOffset;
  const textSnippet = input.textSnippet;
  if (textOffset === undefined && textSnippet === undefined) {
    return { textOffset: null, textSnippet: null };
  }
  if (textOffset !== null && !validOffset(textOffset)) {
    return { textOffset: null, textSnippet: null };
  }
  if (textSnippet !== null && !validSnippet(textSnippet)) {
    return { textOffset: null, textSnippet: null };
  }
  if (textOffset === null && textSnippet !== null) {
    return { textOffset: null, textSnippet: null };
  }
  return {
    textOffset: textOffset === undefined || textOffset === null ? null : textOffset,
    textSnippet: textSnippet === undefined || textSnippet === null ? null : textSnippet,
  };
}

export function isExplicitFootnote(element: Element): boolean {
  if (element.closest("note aside, aside[epub\\:type~='footnote']")) return true;
  const epubType = element.getAttribute("epub:type") ?? "";
  return /(?:^|\s)footnote(?:\s|$)/i.test(epubType);
}

/** Structural visibility shared by provisional chapter scans and measured anchors. */
export function isStructurallyHiddenElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return (
    tag === "script" ||
    tag === "style" ||
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" ||
    isExplicitFootnote(element)
  );
}

export function hasStructurallyExcludedAncestor(node: Node): boolean {
  let current = node.parentElement;
  while (current) {
    if (isStructurallyHiddenElement(current)) return true;
    current = current.parentElement;
  }
  return false;
}

function isVisibleTextNode(
  node: Text,
  doc: Document,
  hiddenCache: WeakMap<Element, boolean>,
): boolean {
  if (!node.data || normalizeAnchorText(node.data) === "") return false;
  let current = node.parentElement;
  while (current) {
    const cached = hiddenCache.get(current);
    if (cached === true) return false;
    if (cached === undefined) {
      let hidden = isStructurallyHiddenElement(current);
      if (!hidden) {
        try {
          const computed = doc.defaultView?.getComputedStyle(current);
          hidden =
            computed?.display === "none" ||
            computed?.visibility === "hidden" ||
            computed?.visibility === "collapse";
        } catch {
          // A detached/old document is handled by the paginator lifecycle.
        }
      }
      hiddenCache.set(current, hidden);
      if (hidden) return false;
    }
    current = current.parentElement;
  }
  return true;
}

export class VisibleTextIndex {
  readonly text: string;
  readonly codePoints: string[];
  readonly totalChars: number;
  readonly mediaUnits: number;
  private readonly nodes: IndexedTextNode[];
  private readonly nodeMap: Map<Text, IndexedTextNode>;

  constructor(nodes: IndexedTextNode[], text: string, mediaUnits = 0) {
    this.nodes = nodes;
    this.nodeMap = new Map(nodes.map((item) => [item.node, item]));
    this.text = text;
    this.codePoints = Array.from(text);
    this.totalChars = this.codePoints.length;
    this.mediaUnits = mediaUnits;
  }

  offsetForNode(node: Node, rawOffset: number): number | null {
    if (node.nodeType !== 3) return null;
    const item = this.nodeMap.get(node as Text);
    if (!item || !Number.isFinite(rawOffset)) return null;
    const raw = Math.max(0, Math.min(item.rawEnd, Math.floor(rawOffset)));
    for (let i = 0; i < item.rawStarts.length; i++) {
      // A defensive caller could hand us an offset in the middle of a
      // surrogate pair. Map it to the code point boundary before that pair;
      // persisted positions never split a Unicode character.
      if (raw <= item.rawStarts[i] || raw < item.rawEnds[i]) return item.start + i;
    }
    return item.end;
  }

  positionForOffset(offset: number): TextNodePosition | null {
    if (!validOffset(offset) || offset > this.totalChars || this.nodes.length === 0) return null;
    const item = this.nodes.find((candidate) => offset >= candidate.start && offset < candidate.end)
      ?? (offset === this.totalChars ? this.nodes.at(-1) : undefined);
    if (!item) return null;
    if (offset === item.end) return { node: item.node, rawOffset: item.rawEnd };
    return { node: item.node, rawOffset: item.rawStarts[offset - item.start] ?? item.rawEnd };
  }

  /** Convert any Range boundary (text node or element node) to our normalized offset. */
  offsetForBoundary(doc: Document, node: Node, rawOffset: number): number | null {
    if (!validOffset(rawOffset) || !this.nodes.length) return null;
    if (node.nodeType === 3) return this.offsetForNode(node, rawOffset);
    if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) return null;
    try {
      const boundary = doc.createRange();
      boundary.setStart(node, Math.min(rawOffset, node.nodeType === 1 ? node.childNodes.length : rawOffset));
      boundary.collapse(true);
      let normalizedOffset = 0;
      for (const item of this.nodes) {
        const itemEnd = doc.createRange();
        itemEnd.setStart(item.node, item.rawEnd);
        itemEnd.collapse(true);
        const startToStart = doc.defaultView?.Range.START_TO_START ?? 0;
        if (itemEnd.compareBoundaryPoints(startToStart, boundary) <= 0) {
          normalizedOffset = item.end;
          continue;
        }
        break;
      }
      return normalizedOffset;
    } catch {
      return null;
    }
  }

  /** Build a DOM Range from normalized offsets without inserting marker nodes. */
  rangeForOffsets(doc: Document, start: number, end: number): Range | null {
    if (!validOffset(start) || !validOffset(end) || end <= start || end > this.totalChars) return null;
    const from = this.positionForOffset(start);
    const to = this.positionForOffset(end);
    if (!from || !to) return null;
    try {
      const range = doc.createRange();
      range.setStart(from.node, from.rawOffset);
      range.setEnd(to.node, to.rawOffset);
      return range;
    } catch {
      return null;
    }
  }

  snippetAt(offset: number): string | null {
    if (!validOffset(offset) || offset >= this.totalChars) return null;
    return this.codePoints.slice(offset, offset + MAX_ANCHOR_SNIPPET_CODE_POINTS).join("") || null;
  }

  snippetBefore(offset: number): string | null {
    if (!validOffset(offset) || offset <= 0 || offset > this.totalChars) return null;
    return this.codePoints
      .slice(Math.max(0, offset - MAX_ANCHOR_SNIPPET_CODE_POINTS), offset)
      .join("") || null;
  }
}

function matchesEnding(haystack: readonly string[], needle: readonly string[], end: number): boolean {
  if (end < needle.length || end > haystack.length) return false;
  const start = end - needle.length;
  for (let i = 0; i < needle.length; i++) if (haystack[start + i] !== needle[i]) return false;
  return true;
}

/** Resolve an annotation range, preferring the full selected text when present. */
export function resolveTextRangeOffsets(
  index: VisibleTextIndex,
  anchor: TextRangeAnchorData,
  selectedText?: string
): { start: number; end: number } | null {
  if (
    !validOffset(anchor.startTextOffset) ||
    !validOffset(anchor.endTextOffset) ||
    anchor.endTextOffset <= anchor.startTextOffset ||
    anchor.endTextOffset > index.totalChars
  ) return null;
  const selected = selectedText ? normalizeAnchorText(selectedText) : "";
  const startNeedle = anchor.startTextSnippet ? Array.from(anchor.startTextSnippet) : [];
  const endNeedle = anchor.endTextSnippet ? Array.from(anchor.endTextSnippet) : [];
  let start = anchor.startTextOffset;
  if (startNeedle.length && !matchesAt(index.codePoints, startNeedle, start)) {
    const resolved = resolveTextAnchorOffset(index, { textOffset: start, textSnippet: anchor.startTextSnippet });
    if (resolved === null) return null;
    start = resolved;
  }
  if (selected) {
    const codePoints = Array.from(selected);
    const min = Math.max(0, start - 4096);
    const max = Math.min(index.totalChars - codePoints.length, start + 4096);
    let best: number | null = null;
    for (let candidate = min; candidate <= max; candidate++) {
      if (!matchesAt(index.codePoints, codePoints, candidate)) continue;
      if (best === null || Math.abs(candidate - start) < Math.abs(best - start)) best = candidate;
    }
    if (best !== null) {
      const end = best + codePoints.length;
      if (end <= index.totalChars) return { start: best, end };
    }
  }
  let end = anchor.endTextOffset;
  if (endNeedle.length && !matchesEnding(index.codePoints, endNeedle, end)) {
    let nearest: number | null = null;
    for (let candidate = endNeedle.length; candidate <= index.totalChars; candidate++) {
      if (!matchesEnding(index.codePoints, endNeedle, candidate)) continue;
      if (nearest === null || Math.abs(candidate - end) < Math.abs(nearest - end)) nearest = candidate;
    }
    if (nearest === null) return null;
    end = nearest;
  }
  return end > start ? { start, end } : null;
}

const MAX_SELECTION_CODE_POINTS = 4096;

function rangeRect(range: Range): { left: number; top: number; right: number; bottom: number } | null {
  const rects = Array.from(range.getClientRects?.() ?? []).filter((r) =>
    [r.left, r.top, r.right, r.bottom].every(Number.isFinite)
  );
  const fallback = rects.length > 0 ? null : range.getBoundingClientRect?.();
  const all = rects.length > 0 ? rects : fallback ? [fallback] : [];
  if (!all.length) return null;
  // Range client rects follow document order. Anchor the context menu to the
  // final visible fragment, not to the union bounding box: a multi-line or
  // multi-column selection's union right edge is usually unrelated to where
  // the selected text actually ends.
  const terminal = all.at(-1)!;
  return { left: terminal.left, top: terminal.top, right: terminal.right, bottom: terminal.bottom };
}

/** Capture a valid current-document selection as a stable normalized range. */
export function captureTextSelection(
  doc: Document,
  viewer: HTMLElement,
  index: VisibleTextIndex,
  selection = doc.getSelection?.()
): TextSelectionPayload | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  let range: Range;
  try {
    range = selection.getRangeAt(0);
  } catch {
    return null;
  }
  if (range.collapsed || !viewer.contains(range.startContainer) || !viewer.contains(range.endContainer)) return null;
  if (hasStructurallyExcludedAncestor(range.startContainer) || hasStructurallyExcludedAncestor(range.endContainer)) return null;
  // A selection can begin/end in normal text while spanning an excluded
  // aside/script in between. Do not create an ambiguous anchor in that case.
  for (const element of Array.from(viewer.querySelectorAll("*"))) {
    if (!isStructurallyHiddenElement(element)) continue;
    try {
      if (range.intersectsNode(element)) return null;
    } catch {
      return null;
    }
  }
  const start = index.offsetForBoundary(doc, range.startContainer, range.startOffset);
  const end = index.offsetForBoundary(doc, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  const selectedText = range.toString();
  if (
    !selectedText ||
    codePointLength(selectedText) > MAX_SELECTION_CODE_POINTS ||
    codePointLength(normalizeAnchorText(selectedText)) > MAX_SELECTION_CODE_POINTS
  ) return null;
  const rect = rangeRect(range);
  if (!rect) return null;
  return {
    selectedText,
    startTextOffset: start,
    endTextOffset: end,
    startTextSnippet: index.snippetAt(start),
    endTextSnippet: index.snippetBefore(end),
    rect,
  };
}

/** Build once per valid current chapter document; callers own invalidation. */
export function buildVisibleTextIndex(doc: Document, viewer: HTMLElement): VisibleTextIndex {
  // SHOW_TEXT is 4. Referencing the numeric DOM constant keeps this helper
  // usable in minimal DOM test implementations that do not expose NodeFilter.
  const walker = doc.createTreeWalker(viewer, 4);
  const nodes: IndexedTextNode[] = [];
  const pieces: string[] = [];
  const hiddenCache = new WeakMap<Element, boolean>();
  let normalizedOffset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!isVisibleTextNode(text, doc, hiddenCache)) continue;
    const rawStarts: number[] = [];
    const rawEnds: number[] = [];
    let rawOffset = 0;
    let normalized = "";
    for (const codePoint of Array.from(text.data)) {
      if (!isWhitespace(codePoint)) {
        rawStarts.push(rawOffset);
        rawEnds.push(rawOffset + codePoint.length);
        normalized += codePoint;
      }
      rawOffset += codePoint.length;
    }
    if (!normalized) continue;
    nodes.push({
      node: text,
      start: normalizedOffset,
      end: normalizedOffset + rawStarts.length,
      rawStarts,
      rawEnds,
      rawEnd: text.data.length,
    });
    normalizedOffset += rawStarts.length;
    pieces.push(normalized);
  }
  const mediaTags = new Set(["img", "video", "audio", "canvas", "svg", "object", "embed"]);
  let mediaUnits = 0;
  for (const element of Array.from(viewer.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();
    if (!mediaTags.has(tag) || isStructurallyHiddenElement(element) || hasStructurallyExcludedAncestor(element)) continue;
    if (tag !== "svg" && element.closest("svg")) continue;
    let hidden = false;
    try {
      const computed = doc.defaultView?.getComputedStyle(element);
      hidden = computed?.display === "none" || computed?.visibility === "hidden" || computed?.visibility === "collapse";
    } catch {
      // Structural visibility remains a conservative fallback.
    }
    if (!hidden) mediaUnits++;
  }
  return new VisibleTextIndex(nodes, pieces.join(""), mediaUnits);
}

function matchesAt(haystack: readonly string[], needle: readonly string[], start: number): boolean {
  for (let i = 0; i < needle.length; i++) {
    if (haystack[start + i] !== needle[i]) return false;
  }
  return true;
}

/**
 * Returns the exact offset when the snippet still validates it. A bounded
 * snippet means the fallback scan is O(chapter characters), not O(n²).
 */
export function resolveTextAnchorOffset(index: VisibleTextIndex, anchor: TextAnchorData): number | null {
  const { textOffset, textSnippet } = sanitizePersistedTextAnchor(anchor);
  if (textOffset === null || textOffset > index.totalChars) return null;
  if (!textSnippet) return textOffset;
  const needle = Array.from(textSnippet);
  if (matchesAt(index.codePoints, needle, textOffset)) return textOffset;
  if (needle.length > index.totalChars) return null;
  let nearest: number | null = null;
  for (let start = 0; start <= index.totalChars - needle.length; start++) {
    if (!matchesAt(index.codePoints, needle, start)) continue;
    if (
      nearest === null ||
      Math.abs(start - textOffset) < Math.abs(nearest - textOffset)
    ) {
      nearest = start;
    }
  }
  return nearest;
}
