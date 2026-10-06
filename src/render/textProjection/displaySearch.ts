import {
  createSearchSession,
  type ProjectedSearchChapter,
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
  /** Null means this segment is either an unprotected gap or T-1-excluded text. */
  projection: NodeProjection | null;
}

interface DisplayLayout {
  sourceText: string;
  displayText: string;
  segments: DisplaySegment[];
}

function appendIdentitySegment(
  layout: { displayText: string; segments: DisplaySegment[] },
  sourceText: string,
  sourceStart: number,
  sourceEnd: number,
): void {
  if (sourceEnd <= sourceStart) return;
  const displayStart = layout.displayText.length;
  const text = sourceText.slice(sourceStart, sourceEnd);
  layout.displayText += text;
  layout.segments.push({
    sourceStart,
    sourceEnd,
    displayStart,
    displayEnd: displayStart + text.length,
    projection: null,
  });
}

/** Pure per-chapter layout builder. No mutable adapter state is shared between chapters. */
export function buildSegmentLayout(
  sourceText: string,
  segments: readonly SearchTextSegment[],
  compiled: CompiledTextProjection,
): DisplayLayout {
  const ordered = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const layout = { displayText: "", segments: [] as DisplaySegment[] };
  let sourceCursor = 0;
  for (const segment of ordered) {
    if (segment.start < sourceCursor || segment.end > sourceText.length || segment.end <= segment.start) continue;
    appendIdentitySegment(layout, sourceText, sourceCursor, segment.start);
    const projection = segment.projectable
      ? createNodeProjection(segment.text, compiled)
      : null;
    const displayStart = layout.displayText.length;
    layout.displayText += projection?.display ?? segment.text;
    layout.segments.push({
      sourceStart: segment.start,
      sourceEnd: segment.end,
      displayStart,
      displayEnd: layout.displayText.length,
      projection,
    });
    sourceCursor = segment.end;
  }
  appendIdentitySegment(layout, sourceText, sourceCursor, sourceText.length);
  return {
    sourceText,
    displayText: layout.displayText,
    segments: layout.segments,
  };
}

function mapSegmentBoundary(
  segment: DisplaySegment,
  displayOffset: number,
  bias: "start" | "end",
): number {
  const localDisplay = Math.max(0, Math.min(segment.displayEnd, displayOffset) - segment.displayStart);
  const localSource = segment.projection
    ? segment.projection.toSource(localDisplay, bias)
    : localDisplay;
  return Math.max(segment.sourceStart, Math.min(segment.sourceEnd, segment.sourceStart + localSource));
}

/** Map one display raw range to the canonical original raw range. */
export function mapLayoutRange(
  layout: DisplayLayout,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > layout.displayText.length
  ) {
    return null;
  }
  const first = layout.segments.find((segment) => segment.displayEnd > start && segment.displayStart < end);
  if (!first) return null;
  let last = first;
  for (const segment of layout.segments) {
    if (segment.displayStart < end && segment.displayEnd > start) last = segment;
  }
  const sourceStart = mapSegmentBoundary(first, start, "start");
  const sourceEnd = mapSegmentBoundary(last, end, "end");
  return sourceEnd > sourceStart ? { start: sourceStart, end: sourceEnd } : null;
}

/** Core/search adapter backed by one compiled T-1 snapshot. */
export class CompiledTextSearchProjection implements SearchProjection {
  readonly version: string;

  constructor(private readonly compiled: CompiledTextProjection) {
    this.version = compiled.version;
  }

  projectChapter(sourceText: string, segments: readonly SearchTextSegment[]): ProjectedSearchChapter {
    const layout = buildSegmentLayout(sourceText, segments, this.compiled);
    return {
      text: layout.displayText,
      toSourceRawRange: (start, end) => mapLayoutRange(layout, start, end),
    };
  }

  /** Small helper retained for preview/tests; display search uses projectChapter. */
  projectText(sourceText: string): string {
    return projectText(sourceText, this.compiled);
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
