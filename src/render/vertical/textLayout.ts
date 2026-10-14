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

  constructor(private readonly root: HTMLElement, private readonly index: VisibleTextIndex, pageWidth: number) {
    if (root.ownerDocument.defaultView?.getComputedStyle(root).writingMode !== "vertical-rl") {
      throw new Error("vertical text viewport must itself use vertical-rl");
    }
    const intervals: VerticalInterval[] = [];
    const origin = this.origin();
    const range = root.ownerDocument.createRange();
    for (const node of index.textNodes) {
      if (!root.contains(node)) throw new Error("canonical index belongs to another document");
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) intervals.push(this.interval(rect, origin));
      }
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

  private interval(rect: Pick<DOMRect, "left" | "right">, origin: number): VerticalInterval {
    return { start: origin - rect.right, end: origin - rect.left };
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
    const logicalOffset = this.interval(rect, this.origin()).start;
    const page = verticalPageAt(this.model, logicalOffset);
    return page === null ? { status: "unresolved" } : {
      status: "located", page, logicalOffset,
      anchor: { textOffset: offset, textSnippet: this.index.snippetAt(offset) },
    };
  }
}
