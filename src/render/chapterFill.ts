import type { OccupiedColumns, SpreadLayout } from "./pagedSpread";
import type { Book } from "../core/types";

/** Runtime layout data only. Never serialize this into a bookmark or progress record. */
export interface ChapterLeafLayout {
  readonly contentLeafCount: number;
  readonly leadingBlankColumns: 0 | 1;
  readonly authoredLeadingColumns: number;
}

export function canInsertLeadingColumn(viewer: HTMLElement): boolean {
  const content = viewer.ownerDocument.defaultView?.getComputedStyle(viewer, "::before").content;
  return content === "none" || content === "normal";
}

export function chapterLeafLayout(layout: SpreadLayout): ChapterLeafLayout {
  const leadingBlankColumns = layout.leadingBlankColumns ?? 0;
  return {
    contentLeafCount: layout.empty ? 0 : layout.lastColumn - layout.firstColumn + 1 - leadingBlankColumns,
    leadingBlankColumns,
    authoredLeadingColumns: layout.firstColumn,
  };
}

/** Only our own extra first column is retained; authored leading columns are never relabelled. */
export function canRetainLeadingColumn(occupied: OccupiedColumns | null): boolean {
  return occupied !== null && occupied.first === 1;
}

/**
 * An empty generated box creates a real column break without changing the book's
 * children, :first-child selectors, text nodes or legacy element indices.
 * An existing author ::before is a boundary, never something to overwrite.
 */
export class LeadingColumnGap {
  private sheet: HTMLStyleElement | null = null;

  apply(viewer: HTMLElement): boolean {
    this.dispose();
    const doc = viewer.ownerDocument;
    if (!canInsertLeadingColumn(viewer)) return false;
    const sheet = doc.createElement("style");
    sheet.setAttribute("data-reader", "leading-column");
    // The reader container has a fixed, reader-owned id. Author nodes are untouched.
    sheet.textContent = `#${viewer.id}::before { all:initial !important; content:"" !important; display:block !important;
      block-size:0 !important; inline-size:auto !important; margin:0 !important;
      padding:0 !important; border:0 !important; break-after:column !important;
      position:static !important; float:none !important; pointer-events:none !important; }`;
    doc.head.appendChild(sheet);
    this.sheet = sheet;
    return true;
  }

  dispose(): void {
    this.sheet?.remove();
    this.sheet = null;
  }
}

export interface ChapterFillEntry {
  readonly chapter: number;
  /** A13/image groups, author page-side requests and unsupported flows reset pairing. */
  readonly isolated?: boolean;
}

/** Keep explicit author page-side/layout requests outside ordinary text pairing. */
export function chapterFillEntries(book: Book, isolated: ReadonlySet<number> = new Set()): ChapterFillEntry[] {
  return book.spine.flatMap((entry, chapter) => !entry.linear ? [] : [{
    chapter,
    isolated: book.fixedLayout || isolated.has(chapter) || entry.properties?.some((property) =>
      /^(?:page-spread-(?:left|right)|rendition:(?:page-spread-|layout-|spread-|flow-))/.test(property)) === true,
  }]);
}

export interface ChapterFillMeasurement {
  readonly contentLeafCount: number;
  /** False for authored leading/forced boundary pages or a layout we cannot shift safely. */
  readonly joinable: boolean;
}

export interface ChapterFillPlacement {
  readonly layoutKey: string;
  /** false means legacy pairing for this visit, never an estimated parity. */
  readonly known: boolean;
  readonly leadingBlankColumns: 0 | 1;
}

/**
 * One book/layout's exact leaf counts. The host feeds only display-ready results
 * through its existing bounded idle queue; this class owns no DOM or timers.
 * Replace this instance on reflow/close. Old instances cannot write a new index.
 */
export class ChapterFillIndex {
  private readonly positions = new Map<number, number>();
  private readonly measurements = new Map<number, ChapterFillMeasurement>();

  constructor(readonly layoutKey: string, private readonly entries: readonly ChapterFillEntry[]) {
    entries.forEach((entry, index) => this.positions.set(entry.chapter, index));
  }

  record(layoutKey: string, chapter: number, measurement: ChapterFillMeasurement): boolean {
    if (layoutKey !== this.layoutKey || !this.positions.has(chapter)) return false;
    if (!Number.isSafeInteger(measurement.contentLeafCount) || measurement.contentLeafCount < 0) return false;
    this.measurements.set(chapter, { ...measurement });
    return true;
  }

  /** Capture once at chapter entry. New measurements never mutate an active placement. */
  placement(chapter: number): ChapterFillPlacement {
    const at = this.positions.get(chapter);
    if (at === undefined) return this.result(false, 0);
    const target = this.measurements.get(chapter);
    if (this.entries[at].isolated || (target && !target.joinable)) return this.result(true, 0);
    // A boundary can establish a fresh prefix even when earlier chapters are unknown.
    let start = at;
    while (start > 0 && !this.boundary(start - 1)) start--;
    let parity: 0 | 1 = 0;
    for (let i = start; i < at; i++) {
      const measured = this.measurements.get(this.entries[i].chapter);
      if (!measured) return this.result(false, 0);
      parity = ((parity + measured.contentLeafCount) % 2) as 0 | 1;
    }
    return this.result(target !== undefined, target === undefined ? 0 : parity);
  }

  /** A real consumer may restore far-chapter measurement; never mark resource-only work measured. */
  nextUnmeasured(skip?: (chapter: number) => boolean): number | null {
    return this.entries.find((entry) => !entry.isolated && !this.measurements.has(entry.chapter) &&
      !skip?.(entry.chapter))?.chapter ?? null;
  }

  private boundary(index: number): boolean {
    const entry = this.entries[index];
    return entry.isolated === true || this.measurements.get(entry.chapter)?.joinable === false;
  }

  private result(known: boolean, leadingBlankColumns: 0 | 1): ChapterFillPlacement {
    return Object.freeze({ layoutKey: this.layoutKey, known, leadingBlankColumns });
  }
}
