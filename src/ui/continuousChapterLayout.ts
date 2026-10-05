/**
 * Continuous reading geometry. No DOM, timers, wheel thresholds or chapter turns.
 * The host owns the sole user scroll position; bounded chapter iframes project it.
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

/**
 * 连续滚动 iframe 的上下缓冲高度：覆盖合成线程滚动领先 JS 同步的一两帧
 * （快速甩动约 60–130px/帧），又不让 iframe 过高增加绘制面积。
 */
export function continuousFrameBleed(viewportHeight: number): number {
  if (!(viewportHeight > 0)) return 0;
  return Math.round(Math.min(400, Math.max(160, viewportHeight * 0.35)));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export { continuousWheelPixels } from "../render/scrollLayout";

export interface ChapterExtentDraft {
  key: string;
  height: number;
  measured: boolean;
}
export interface ChapterBoxDraft extends ChapterExtentDraft {
  index: number;
  top: number;
  bottom: number;
}

/**
 * 章间 gap 只出现在两个正高度章节之间；书首/书尾和空章不制造额外空隙。
 * 返回值被 {@link ContinuousChapterLayout} 和测试共用，保证所有调用方共享
 * 同一套 top/bottom/totalHeight 口径。
 */
export function buildSpacedChapterBoxes(
  extents: readonly ChapterExtentDraft[],
  gap: number,
): { boxes: ChapterBoxDraft[]; totalHeight: number } {
  const safeGap = Number.isFinite(gap) && gap > 0 ? gap : 0;
  let bottom = 0;
  let hasPreviousContent = false;
  const boxes = extents.map((extent, index) => {
    const top = bottom + (extent.height > 0 && hasPreviousContent ? safeGap : 0);
    const box = { ...extent, index, top, bottom: top + extent.height };
    if (extent.height > 0) {
      bottom = box.bottom;
      hasPreviousContent = true;
    }
    return box;
  });
  return { boxes, totalHeight: bottom };
}

/** 缝隙归到下一章起点；screenY 必须用实际点坐标重算，不能继续用 probeY。 */
export function anchorAtSpacedPoint(
  boxes: readonly ChapterBoxDraft[],
  documentY: number,
  hostScrollTop: number,
): { key: string; offset: number; screenY: number } | null {
  let last: ChapterBoxDraft | undefined;
  for (const box of boxes) {
    if (box.height === 0) continue;
    last = box;
    if (documentY < box.bottom) {
      const offset = Math.max(0, documentY - box.top);
      return { key: box.key, offset, screenY: box.top + offset - hostScrollTop };
    }
  }
  return last
    ? { key: last.key, offset: last.height, screenY: last.bottom - hostScrollTop }
    : null;
}

/** Inputs are validated by the measurement adapter: unique keys, finite heights >= 0. */
export class ContinuousChapterLayout {
  readonly boxes: readonly ChapterBox[];
  readonly totalHeight: number;
  readonly gap: number;
  private readonly byKey: ReadonlyMap<string, ChapterBox>;

  constructor(extents: readonly ChapterExtent[], gap = 0) {
    this.gap = Number.isFinite(gap) && gap > 0 ? gap : 0;
    const { boxes, totalHeight } = buildSpacedChapterBoxes(extents, this.gap);
    this.boxes = boxes;
    this.totalHeight = totalHeight;
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

  /**
   * Half-open chapter intervals; exact seams belong to the following nonempty
   * chapter. A gap between two chapters belongs to the following chapter at
   * offset 0 so sampling on the reading line does not jump to the previous
   * chapter end or pull the host by the gap height.
   */
  pointAt(documentY: number): ChapterPoint | null {
    const y = clamp(documentY, 0, this.totalHeight);
    for (const box of this.boxes) {
      if (box.height === 0) continue;
      if (y < box.top) return { key: box.key, offset: 0 };
      if (y < box.bottom) return { key: box.key, offset: y - box.top };
    }
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
    if (!point) return null;
    const box = this.byKey.get(point.key);
    if (!box) return null;
    // gap 内采样归到下个章节 offset 0，screenY 必须按该章实际 top 重算；
    // 继续使用 probe 会在 gap 位于阅读线时把重测拉动一个 gap 的距离。
    return { ...point, screenY: box.top + point.offset - top };
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
  project(scrollTop: number, viewportHeight: number, overscan = 0, bleed = 0): ChapterProjection[] {
    const top = this.clampScrollTop(scrollTop, viewportHeight);
    const bottom = top + viewportHeight;
    const start = Math.max(0, top - overscan);
    const end = Math.min(this.totalHeight, bottom + overscan);
    // iframe 比视口上下各多出 bleed：宿主原生滚动在合成线程先走，JS 跟上之前
    // 窗口随画布移动，多出的部分盖住边缘，不露出背景。
    const frameHeight = viewportHeight + 2 * Math.max(0, bleed);
    const result: ChapterProjection[] = [];
    for (const box of this.boxes) {
      if (box.height === 0 || box.bottom <= start || box.top >= end) continue;
      const frameOffset = clamp(top - box.top - Math.max(0, bleed), 0, Math.max(0, box.height - frameHeight));
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
    const extents = this.boxes.map((box) => ({
      key: box.key,
      height: replacements.get(box.key)?.height ?? box.height,
      measured: replacements.get(box.key)?.measured ?? box.measured,
    }));
    const layout = new ContinuousChapterLayout(extents, this.gap);
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

export interface ScrollNavigationTicket<T> {
  readonly serial: number;
  readonly bookSession: number;
  readonly chapterKey: string;
  readonly target: T;
}

/**
 * 显式滚动导航票据。替换“effect 入口立即消费 nonce”：等待目标章节装载/
 * 重排时票据保持有效，提交前还要校验 bookSession 与当前布局代次。
 */
export class PendingScrollNavigation<T> {
  private serial = 0;
  private pending: ScrollNavigationTicket<T> | null = null;

  begin(bookSession: number, chapterKey: string, target: T): ScrollNavigationTicket<T> {
    const ticket = { serial: ++this.serial, bookSession, chapterKey, target };
    this.pending = ticket;
    return ticket;
  }

  current(): ScrollNavigationTicket<T> | null {
    return this.pending;
  }

  canCommit(
    ticket: ScrollNavigationTicket<T>,
    bookSession: number,
    measuredRevision: number,
    currentRevision: number,
  ): boolean {
    return this.pending === ticket &&
      ticket.bookSession === bookSession &&
      measuredRevision === currentRevision;
  }

  /** 仅在外层几何 + scrollTop + 投影已提交，或已明确报告失败后调用。 */
  settle(ticket: ScrollNavigationTicket<T>): boolean {
    if (this.pending !== ticket) return false;
    this.pending = null;
    return true;
  }

  cancel(): void {
    this.pending = null;
  }
}
