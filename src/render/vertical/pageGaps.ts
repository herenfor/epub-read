import { collectVisibleTextNodes } from "../textAnchor";
import type { TextProjectionSession } from "../textProjection/session";
import type { VerticalWritingMode } from "../basicVertical";
import { buildVerticalPageModel } from "./pageModel";

interface Atom { start: number; end: number; node?: Text; element?: HTMLElement }
interface Gap { element: HTMLElement; anchor: Range; target: number; size: number }

/** Reader-owned page seams. No text, no clone of the chapter, no persisted
 * pixel offsets. The caller disposes them before changing any layout inputs. */
export class VerticalPageGaps {
  private readonly elements: HTMLElement[] = [];
  private readonly splits: Array<{ left: Text; right: Text; restoreProjection?: () => void }> = [];

  dispose(): void {
    for (const element of this.elements) element.remove();
    // A Text node can have several cuts; undo precisely in reverse order.
    for (const { left, right, restoreProjection } of this.splits.reverse()) {
      if (left.parentNode && right.parentNode === left.parentNode && left.nextSibling === right) {
        left.data += right.data;
        right.remove();
      }
      restoreProjection?.();
    }
    this.elements.length = this.splits.length = 0;
  }

  apply(viewer: HTMLElement, mode: VerticalWritingMode, screenWidth: number,
    left: number, right: number, projection?: TextProjectionSession | null):
    { kind: "ready"; pages: number; seams: number } | { kind: "unsupported"; reason: string } {
    this.dispose();
    const doc = viewer.ownerDocument, win = doc.defaultView!;
    const root = viewer.getBoundingClientRect();
    const rtl = mode === "vertical-rl";
    // Read on normal geometry and zero scroll, before the compositor expands it.
    const origin = rtl ? root.right - right : root.left + left;
    const interval = (r: DOMRect) => rtl
      ? { start: origin - r.right, end: origin - r.left }
      : { start: r.left - origin, end: r.right - origin };
    const atoms: Atom[] = [], atomic = new Set<HTMLElement>();
    const ownerCache = new Map<Element, HTMLElement | null>();
    const atomicOwner = (element: Element | null): HTMLElement | null => {
      if (!element || element === viewer) return null;
      if (ownerCache.has(element)) return ownerCache.get(element)!;
      const cs = win.getComputedStyle(element);
      const parent = atomicOwner(element.parentElement);
      const own = /^(ruby|svg|img|video|canvas|object|embed)$/i.test(element.tagName) ||
        cs.textCombineUpright !== "none" && Boolean(cs.textCombineUpright) ||
        cs.writingMode !== mode;
      const result = parent ?? (own ? element as HTMLElement : null);
      ownerCache.set(element, result);
      return result;
    };
    for (const node of collectVisibleTextNodes(doc, viewer)) {
      const owner = atomicOwner(node.parentElement);
      if (owner) { atomic.add(owner); continue; }
      const range = doc.createRange(); range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) atoms.push({ ...interval(rect), node });
      }
    }
    for (const element of viewer.querySelectorAll<HTMLElement>("img,svg,video,canvas,object,embed")) {
      atomic.add(atomicOwner(element) ?? element);
    }
    for (const element of atomic) {
      const cs = win.getComputedStyle(element);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const range = doc.createRange(); range.selectNode(element);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) atoms.push({ ...interval(rect), element });
      }
    }
    const model = buildVerticalPageModel(atoms, screenWidth - left - right);
    if (model.kind === "unsupported") return { kind: "unsupported", reason: model.reason };
    if (model.kind === "empty") return { kind: "ready", pages: 1, seams: 0 };
    const gaps: Gap[] = [];
    const textBoundaries = new Map<Text, number[]>();
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let shift = 0;
    // Plan every insertion and its exact DOM position before any layout writes.
    const planned: Array<{ atom: Atom; offset?: number; anchor: Range; size: number; target: number; inline: boolean }> = [];
    for (let page = 1; page < model.pages.length; page++) {
      const start = model.pages[page].start;
      const group = model.groups.find(g => g.end > start + .01)!;
      const atom = atoms.find(a => Math.abs(a.start - group.start) < .01)!;
      const target = page * screenWidth;
      const delta = target - group.start - shift;
      if (delta < -.5) return { kind: "unsupported", reason: "authored-gap" };
      const anchor = doc.createRange();
      let offset: number | undefined;
      if (atom.node) {
        const node = atom.node;
        // Find the first character of this column with logarithmic range reads.
        let boundaries = textBoundaries.get(node);
        if (!boundaries) {
          boundaries = [0];
          for (const { index, segment } of segmenter.segment(node.data)) boundaries.push(index + segment.length);
          textBoundaries.set(node, boundaries);
        }
        let lo = 0, hi = boundaries.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          anchor.setStart(node, boundaries[mid]); anchor.setEnd(node, boundaries[mid + 1]);
          const rect = anchor.getBoundingClientRect();
          if (interval(rect).start < atom.start - .5) lo = mid + 1; else hi = mid;
        }
        if (lo >= boundaries.length - 1) return { kind: "unsupported", reason: "column-anchor" };
        anchor.setStart(node, boundaries[lo]); anchor.setEnd(node, boundaries[lo + 1]);
        // Inserting after the first character removes the line-end ambiguity.
        offset = projection?.splitBoundary(node, boundaries[lo + 1]) ?? boundaries[lo + 1];
        const probe = doc.createRange();
        probe.setStart(node, Math.max(boundaries[lo], offset - 1)); probe.setEnd(node, offset);
        if (Math.abs(interval(probe.getBoundingClientRect()).start - atom.start) > .5) {
          return { kind: "unsupported", reason: "projected-fragment-crosses-column" };
        }
      } else anchor.selectNode(atom.element!);
      const cs = win.getComputedStyle(atom.node?.parentElement ?? atom.element!);
      const inline = Boolean(atom.node) || !/^(img|svg|video|canvas|object|embed)$/i.test(atom.element!.tagName) && /^(inline|ruby)/.test(cs.display);
      const advance = inline ? parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 : 0;
      planned.push({ atom, offset, anchor, target, inline, size: Math.max(0, delta) + advance });
      shift += Math.max(0, delta);
    }
    // Reverse order keeps all planned raw offsets valid even inside one Text.
    for (const plan of planned.reverse()) {
      const gap = doc.createElement(plan.inline ? "span" : "div");
      gap.setAttribute("data-reader-page-gap", "");
      gap.setAttribute("aria-hidden", "true");
      gap.style.cssText = "inline-size:0!important;min-inline-size:0!important;min-block-size:0!important;max-block-size:none!important;margin:0!important;padding:0!important;border:0!important;overflow:hidden!important;pointer-events:none!important;";
      const size = plan.size;
      gap.style.setProperty("display", plan.inline ? "inline-block" : "block", "important");
      if (plan.inline) gap.style.setProperty("vertical-align", "bottom", "important");
      if (plan.atom.node) {
        const node = plan.atom.node, offset = plan.offset!;
        const tail = node.splitText(offset);
        const restoreProjection = projection?.trackSplit(node, tail, offset);
        this.splits.push({ left: node, right: tail, restoreProjection });
        tail.parentNode!.insertBefore(gap, tail);
      } else {
        const element = plan.atom.element!;
        // Treat ruby/tate-chu-yoko as the first indivisible item of a column.
        // Placing its seam after that item avoids claiming the preceding line.
        element.parentNode!.insertBefore(gap, plan.inline ? element.nextSibling : element);
      }
      gap.style.setProperty("block-size", `${size}px`, "important");
      this.elements.push(gap);
      gaps.push({ element: gap, anchor: plan.anchor, target: plan.target, size });
    }
    // One measured correction, batched: earlier corrections move later seams.
    gaps.reverse();
    const actual = gaps.map(g => interval(g.anchor.getBoundingClientRect()).start);
    let correction = 0;
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i], delta = g.target - actual[i] - correction;
      g.element.style.setProperty("block-size", `${Math.max(0, g.size + delta)}px`, "important");
      correction += delta;
    }
    return { kind: "ready", pages: model.pages.length, seams: gaps.length };
  }
}
