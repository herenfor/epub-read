/**
 * Continuous reading geometry. No DOM, timers, wheel thresholds or chapter turns.
 * The host owns the sole user scroll position; bounded chapter iframes project it.
 * Not wired into ReaderView yet. See the continuous-scroll handoff for integration.
 */
export interface ChapterExtent {
  /** Stable book-local spine identity, not a reusable iframe slot ID. */
  readonly key: string;
  /** Real content height, or an estimate while loading; no artificial screen minimum. */
  readonly height: number;
  readonly measured: boolean;
}

export interface ChapterBox extends ChapterExtent {
  readonly index: number;
  readonly top: number;
  readonly bottom: number;
}

export interface ChapterPoint {
  readonly key: string;
  readonly offset: number;
}

/** A chapter-local content point and its desired screen coordinate. */
export interface ContinuousAnchor extends ChapterPoint {
  readonly screenY: number;
}

export interface ChapterProjection {
  readonly box: ChapterBox;
  /** Offset of a fixed-viewport iframe inside its full-height chapter wrapper. */
  readonly frameOffset: number;
  /** Programmatic inner scrollTop; equal to frameOffset so content does not jump. */
  readonly innerScrollTop: number;
  readonly frameScreenTop: number;
  /** The visible strip inside that iframe, in iframe viewport coordinates. */
  readonly clipTop: number;
  readonly clipBottom: number;
  readonly visible: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export { continuousWheelPixels } from "../render/scrollLayout";

/** Inputs are validated by the measurement adapter: unique keys, finite heights >= 0. */
export class ContinuousChapterLayout {
  readonly boxes: readonly ChapterBox[];
  readonly totalHeight: number;
  private readonly byKey: ReadonlyMap<string, ChapterBox>;

  constructor(extents: readonly ChapterExtent[]) {
    let top = 0;
    this.boxes = extents.map((extent, index) => {
      const box = { ...extent, index, top, bottom: top + extent.height };
      top = box.bottom;
      return box;
    });
    this.totalHeight = top;
    this.byKey = new Map(this.boxes.map((box) => [box.key, box]));
  }

  /** Lookup for callers that map a live chapter wrapper back to its committed box. */
  boxFor(key: string): ChapterBox | null {
    return this.byKey.get(key) ?? null;
  }

  maxScrollTop(viewportHeight: number): number {
    return Math.max(0, this.totalHeight - viewportHeight);
  }

  clampScrollTop(scrollTop: number, viewportHeight: number): number {
    return clamp(scrollTop, 0, this.maxScrollTop(viewportHeight));
  }

  /** Half-open chapter intervals; exact seams belong to the following nonempty chapter. */
  pointAt(documentY: number): ChapterPoint | null {
    const y = clamp(documentY, 0, this.totalHeight);
    for (const box of this.boxes) {
      if (box.height > 0 && y >= box.top && y < box.bottom) {
        return { key: box.key, offset: y - box.top };
      }
    }
    // The end of the whole book belongs to the last nonempty chapter.
    for (let index = this.boxes.length - 1; index >= 0; index -= 1) {
      const box = this.boxes[index];
      if (box.height > 0) return { key: box.key, offset: box.height };
    }
    return null;
  }

  anchorAt(scrollTop: number, viewportHeight: number, screenY = 0): ContinuousAnchor | null {
    const top = this.clampScrollTop(scrollTop, viewportHeight);
    const probe = clamp(screenY, 0, Math.min(viewportHeight, this.totalHeight - top));
    const point = this.pointAt(top + probe);
    return point ? { ...point, screenY: probe } : null;
  }

  /** After height changes, restore a content point without replaying a wheel event. */
  scrollTopFor(anchor: ContinuousAnchor, viewportHeight: number): number | null {
    const box = this.byKey.get(anchor.key);
    if (!box) return null;
    const offset = clamp(anchor.offset, 0, box.height);
    return this.clampScrollTop(box.top + offset - anchor.screenY, viewportHeight);
  }

  /**
   * Slots are selected by pixel coverage, not by a fixed previous/current/next count.
   * Many short chapters may share one viewport. Zero-height chapters need no frame.
   */
  project(scrollTop: number, viewportHeight: number, overscan = 0): ChapterProjection[] {
    const top = this.clampScrollTop(scrollTop, viewportHeight);
    const bottom = top + viewportHeight;
    const start = Math.max(0, top - overscan);
    const end = Math.min(this.totalHeight, bottom + overscan);
    const result: ChapterProjection[] = [];
    for (const box of this.boxes) {
      if (box.height === 0 || box.bottom <= start || box.top >= end) continue;
      const frameOffset = clamp(top - box.top, 0, Math.max(0, box.height - viewportHeight));
      const frameScreenTop = box.top + frameOffset - top;
      const visibleStart = Math.max(top, box.top);
      const visibleEnd = Math.min(bottom, box.bottom);
      const visible = visibleEnd > visibleStart;
      result.push({
        box,
        frameOffset,
        innerScrollTop: frameOffset,
        frameScreenTop,
        clipTop: visible ? visibleStart - box.top - frameOffset : 0,
        clipBottom: visible ? visibleEnd - box.top - frameOffset : 0,
        visible,
      });
    }
    return result;
  }

  /** Replace measurements in one batch, preserving an anchor sampled just before commit. */
  withMeasurements(
    updates: readonly ChapterExtent[],
    anchor: ContinuousAnchor | null,
    viewportHeight: number,
    currentScrollTop: number,
  ): { layout: ContinuousChapterLayout; scrollTop: number } {
    const replacements = new Map(updates.map((extent) => [extent.key, extent]));
    const layout = new ContinuousChapterLayout(this.boxes.map((box) => replacements.get(box.key) ?? box));
    return {
      layout,
      scrollTop: (anchor && layout.scrollTopFor(anchor, viewportHeight))
        ?? layout.clampScrollTop(currentScrollTop, viewportHeight),
    };
  }
}

export interface ChapterLoadTicket {
  readonly key: string;
  readonly requestId: number;
}

/**
 * One in-flight load per chapter. Reset on book/layout generation changes.
 * Cancellation in the adapter must also abort IO and dispose unpublished resources.
 * This gate prevents stale results even when underlying work cannot be aborted.
 */
export class ChapterLoadGate {
  private nextId = 0;
  private readonly pending = new Map<string, ChapterLoadTicket>();

  begin(key: string): ChapterLoadTicket | null {
    if (this.pending.has(key)) return null;
    const ticket = { key, requestId: ++this.nextId };
    this.pending.set(key, ticket);
    return ticket;
  }

  isCurrent(ticket: ChapterLoadTicket): boolean {
    return this.pending.get(ticket.key) === ticket;
  }

  /** Commit only after this returns true; old completion must not remove a new load. */
  finish(ticket: ChapterLoadTicket): boolean {
    if (!this.isCurrent(ticket)) return false;
    this.pending.delete(ticket.key);
    return true;
  }

  cancel(key: string): void {
    this.pending.delete(key);
  }

  reset(): void {
    this.pending.clear();
  }
}
