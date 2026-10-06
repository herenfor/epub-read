import {
  createSearchSession,
  type SearchBookOptions,
  type SearchProjection,
  type SearchSession,
} from "../../core/search";
import type { SearchTextSegment } from "../../core/corpus";
import type { Book } from "../../core/types";
import type { CompiledTextProjection } from "./compile";
import { projectText } from "./compile";
import { createNodeProjection, type NodeProjection } from "./nodeProjection";

interface DisplaySegment {
  sourceStart: number;
  sourceEnd: number;
  displayStart: number;
  displayEnd: number;
  /** Null means this segment is excluded from T-1 (pre/code/SVG). */
  projection: NodeProjection | null;
}

interface DisplayLayout {
  sourceText: string;
  displayText: string;
  segments: DisplaySegment[];
}

/** Core/search adapter backed by one compiled T-1 snapshot. */
export class CompiledTextSearchProjection implements SearchProjection {
  readonly version: string;
  private lastSource: string | null = null;
  private lastNodeProjection: NodeProjection | null = null;
  private lastLayout: DisplayLayout | null = null;

  constructor(private readonly compiled: CompiledTextProjection) {
    this.version = compiled.version;
  }

  projectText(sourceText: string): string {
    this.lastLayout = null;
    return projectText(sourceText, this.compiled);
  }

  projectSegments(sourceText: string, segments: readonly SearchTextSegment[]): string {
    let displayText = "";
    let sourceCursor = 0;
    const displaySegments: DisplaySegment[] = [];
    for (const segment of segments) {
      if (segment.start < sourceCursor || segment.end > sourceText.length) continue;
      displayText += sourceText.slice(sourceCursor, segment.start);
      const projection = segment.projectable
        ? createNodeProjection(segment.text, this.compiled)
        : null;
      const displayStart = displayText.length;
      displayText += projection?.display ?? segment.text;
      const displayEnd = displayText.length;
      displaySegments.push({
        sourceStart: segment.start,
        sourceEnd: segment.end,
        displayStart,
        displayEnd,
        projection,
      });
      sourceCursor = segment.end;
    }
    displayText += sourceText.slice(sourceCursor);
    this.lastSource = null;
    this.lastNodeProjection = null;
    this.lastLayout = { sourceText, displayText, segments: displaySegments };
    return displayText;
  }

  toSourceRawRange(
    sourceText: string,
    displayText: string,
    start: number,
    end: number,
  ): { start: number; end: number } | null {
    const layout = this.lastLayout;
    if (layout && layout.sourceText === sourceText && layout.displayText === displayText) {
      return this.mapLayoutRange(layout, start, end);
    }
    if (this.lastSource !== sourceText || this.lastNodeProjection === null) {
      this.lastSource = sourceText;
      this.lastNodeProjection = createNodeProjection(sourceText, this.compiled);
    }
    const sourceStart = this.lastNodeProjection.toSource(start, "start");
    const sourceEnd = this.lastNodeProjection.toSource(end, "end");
    return sourceEnd > sourceStart ? { start: sourceStart, end: sourceEnd } : null;
  }

  private mapLayoutRange(layout: DisplayLayout, start: number, end: number): { start: number; end: number } | null {
    const first = layout.segments.find((segment) => segment.displayEnd > start && segment.displayStart < end);
    if (!first) return null;
    let last = first;
    for (const segment of layout.segments) {
      if (segment.displayStart < end && segment.displayEnd > start) last = segment;
    }
    const mapSegmentBoundary = (
      segment: DisplaySegment,
      displayOffset: number,
      bias: "start" | "end",
    ): number => {
      const localDisplay = Math.max(0, Math.min(segment.displayEnd, displayOffset) - segment.displayStart);
      const localSource = segment.projection
        ? segment.projection.toSource(localDisplay, bias)
        : localDisplay;
      return Math.max(segment.sourceStart, Math.min(segment.sourceEnd, segment.sourceStart + localSource));
    };
    const sourceStart = mapSegmentBoundary(first, start, "start");
    const sourceEnd = mapSegmentBoundary(last, end, "end");
    return sourceEnd > sourceStart ? { start: sourceStart, end: sourceEnd } : null;
  }
}

export type DisplaySearchSessionOptions = Omit<SearchBookOptions, "projection">;

export type TextSearchView = "display" | "original";

/**
 * Scope switch for the reader UI. `display` uses the compiled T-1 snapshot
 * when present; `original` always reuses the untouched search corpus.
 */
export function createTextSearchSession(
  book: Book,
  view: TextSearchView,
  projection: CompiledTextProjection | null,
  options: DisplaySearchSessionOptions = {},
): SearchSession {
  if (view === "display" && projection) {
    return createDisplaySearchSession(book, projection, options);
  }
  return createSearchSession(book, options);
}

/**
 * Search the projected display text while returning canonical original text
 * hits. The query is never reverse-converted: it is matched against the same
 * projected string the renderer would show.
 */
export function createDisplaySearchSession(
  book: Book,
  projection: CompiledTextProjection,
  options: DisplaySearchSessionOptions = {},
): SearchSession {
  return createSearchSession(book, {
    ...options,
    projection: new CompiledTextSearchProjection(projection),
  });
}
