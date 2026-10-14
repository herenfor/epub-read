import { resolveTextAnchorOffset, type TextAnchorData, type VisibleTextIndex } from "../textAnchor";
import { buildVerticalPageModel, verticalPageAt, type VerticalInterval, type VerticalPageModel } from "./pageModel";

export type VerticalTextLocation =
  | { readonly status: "located"; readonly page: number; readonly logicalOffset: number; readonly anchor: TextAnchorData }
  | { readonly status: "unresolved" | "stale-layout" | "unsupported" };

/** Optional core only: no current reader imports this snapshot. The owner must
 * invalidate after text projection, fonts or geometry change. No observers,
 * styles, transforms, scrolling, progress writes or media fitting live here. */
export class VerticalTextLayout {
  readonly model: VerticalPageModel;
  private valid = true;
  private readonly columnWidths = new WeakMap<Element, number>();

  constructor(private readonly root: HTMLElement, private readonly index: VisibleTextIndex, pageWidth: number) {
    if (root.ownerDocument.defaultView?.getComputedStyle(root).writingMode !== "vertical-rl") {
      throw new Error("vertical text viewport must itself use vertical-rl");
    }
    const intervals: VerticalInterval[] = [];
    const rubies = new Set<Element>();
    const origin = this.origin();
    const range = root.ownerDocument.createRange();
    for (const node of index.textNodes) {
      if (!root.contains(node)) throw new Error("canonical index belongs to another document");
      const ruby = node.parentElement?.closest("ruby");
      if (ruby && root.contains(ruby)) rubies.add(ruby);
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) intervals.push(this.columnInterval(rect, origin, node));
      }
    }
    // Annotation ink may be separated from its base by a gap. Keep a ruby
    // together even when text-only rectangles do not overlap horizontally.
    for (const ruby of rubies) {
      range.selectNodeContents(ruby);
      let start = Infinity, end = -Infinity;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        start = Math.min(start, origin - rect.right);
        end = Math.max(end, origin - rect.left);
      }
      if (end > start) intervals.push({ start, end });
    }
    this.model = buildVerticalPageModel(intervals, pageWidth);
  }

  invalidate(): void { this.valid = false; }

  /** Native negative scrollLeft is removed from rects, not saved as an anchor. */
  private origin(): number {
    const style = this.root.ownerDocument.defaultView!.getComputedStyle(this.root);
    const borderRight = parseFloat(style.borderRightWidth) || 0;
    return this.root.getBoundingClientRect().right - borderRight - this.root.scrollLeft;
  }

  // Range rectangles are font ink/content metrics, not line boxes. Tight
  // line-height can overlap neighbouring ink by several pixels; it must not
  // turn distinct columns into one indivisible chapter. Ruby ink is protected
  // separately above. Cache per element, never read style once per character.
  private columnInterval(rect: Pick<DOMRect, "left" | "right">, origin: number, node: Text): VerticalInterval {
    const element = node.parentElement!;
    let width = this.columnWidths.get(element);
    if (width === undefined) {
      const style = this.root.ownerDocument.defaultView!.getComputedStyle(element);
      const em = parseFloat(style.fontSize);
      const line = parseFloat(style.lineHeight);
      width = Number.isFinite(em) && em > 0 ? Math.min(em, Number.isFinite(line) && line > 0 ? line : em) : Infinity;
      this.columnWidths.set(element, width);
    }
    const half = Math.min(rect.right - rect.left, width) / 2;
    const centre = origin - (rect.left + rect.right) / 2;
    return { start: Math.max(0, centre - half), end: centre + half };
  }

  locate(anchor: TextAnchorData): VerticalTextLocation {
    if (!this.valid) return { status: "stale-layout" };
    if (this.model.kind === "unsupported") return { status: "unsupported" };
    if (this.model.kind === "empty") return { status: "unresolved" };
    const offset = resolveTextAnchorOffset(this.index, anchor);
    if (offset === null) return { status: "unresolved" };
    const position = this.index.positionForOffset(offset);
    if (!position || !this.root.contains(position.node)) return { status: "unresolved" };
    const text = position.node.data;
    let start = position.rawOffset;
    // End-of-text anchors refer to the last visible code point, not an empty Range.
    if (start === text.length) start = Math.max(0, start - (text.codePointAt(start - 2)! > 0xffff ? 2 : 1));
    if (start >= text.length) return { status: "unresolved" };
    const range = this.root.ownerDocument.createRange();
    range.setStart(position.node, start);
    range.setEnd(position.node, start + (text.codePointAt(start)! > 0xffff ? 2 : 1));
    const rect = Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
    if (!rect) return { status: "unresolved" };
    const logicalOffset = this.columnInterval(rect, this.origin(), position.node).start;
    const page = verticalPageAt(this.model, logicalOffset);
    return page === null ? { status: "unresolved" } : {
      status: "located", page, logicalOffset,
      anchor: { textOffset: offset, textSnippet: this.index.snippetAt(offset) },
    };
  }
}
