import {
  createSearchSession,
  type SearchBookOptions,
  type SearchProjection,
  type SearchSession,
} from "../../core/search";
import type { Book } from "../../core/types";
import type { CompiledTextProjection } from "./compile";
import { projectText } from "./compile";
import { createNodeProjection } from "./nodeProjection";

/** Core/search adapter backed by one compiled T-1 snapshot. */
export class CompiledTextSearchProjection implements SearchProjection {
  readonly version: string;
  private lastSource: string | null = null;
  private lastNodeProjection: ReturnType<typeof createNodeProjection> | null = null;

  constructor(private readonly compiled: CompiledTextProjection) {
    this.version = compiled.version;
  }

  projectText(sourceText: string): string {
    return projectText(sourceText, this.compiled);
  }

  toSourceRawRange(
    sourceText: string,
    _displayText: string,
    start: number,
    end: number,
  ): { start: number; end: number } | null {
    if (this.lastSource !== sourceText || this.lastNodeProjection === null) {
      this.lastSource = sourceText;
      this.lastNodeProjection = createNodeProjection(sourceText, this.compiled);
    }
    const sourceStart = this.lastNodeProjection.toSource(start, "start");
    const sourceEnd = this.lastNodeProjection.toSource(end, "end");
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
