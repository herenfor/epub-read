import { spineItemPath } from "./book";
import { splitHref } from "./paths";
import {
  BLOCK_BOUNDARY,
  MAX_ANCHOR_SNIPPET_CODE_POINTS,
  buildDocument,
  extractSearchText,
  extractVisibleText,
  normalizeQueryPart,
  type SearchDocument,
} from "./corpus";
import type { Book, TocNode } from "./types";
import { buildExactTextHitsAndPoints, type ExactTextHit } from "./exactTextHits";
import { captureSearchOccurrence, type SearchOccurrence } from "./searchOccurrence";

const ANCHOR_WHITESPACE = /\p{White_Space}/u;

function decodeBytes(data: Uint8Array): string {
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.slice(2));
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.slice(2));
  }
  return new TextDecoder("utf-8").decode(data);
}

export interface SearchProgress {
  completed: number;
  total: number;
  spineIndex: number;
}

export interface SearchBookOptions {
  /** Overrides ResourceServer/book resource decoding, useful for tests and streaming hosts. */
  textFor?: (path: string) => string | undefined | Promise<string | undefined>;
  /** Alternative injected source; textFor takes precedence. */
  resourceServer?: { textFor(path: string): string | undefined };
  signal?: AbortSignal;
  maxResults?: number;
  onProgress?: (progress: SearchProgress) => void;
  /** Defaults to a macrotask yield after every processed chapter. */
  yieldToHost?: () => Promise<void>;
  /** When present, searches projected display text while retaining canonical original hits. */
  projection?: SearchProjection;
}

export type SearchQueryOptions = Pick<SearchBookOptions, "signal" | "maxResults" | "onProgress" | "yieldToHost">;

/**
 * Optional display-projection adapter. The core stays independent of render/UI
 * modules: callers provide the compiled projection and the raw-range inverse.
 */
export interface SearchProjection {
  /** Stable identity for display index caches. */
  readonly version: string;
  /** Project one chapter's extracted search text. Must be pure. */
  projectText(sourceText: string): string;
  /**
   * Map a raw UTF-16 range from projected text back to the original extracted
   * text. Start/end use opposite fragment biases in the implementation.
   */
  toSourceRawRange(
    sourceText: string,
    displayText: string,
    start: number,
    end: number,
  ): { start: number; end: number } | null;
}

export interface SearchSession {
  search(query: string, options?: SearchQueryOptions): Promise<SearchResult[]>;
  dispose(): void;
}

export interface SearchDisplayHit {
  /** Raw UTF-16 range in projected extracted text. */
  range: { start: number; end: number };
  /** Display matched text with block separators rendered as newlines. */
  matchedText: string;
  /** Display-only exact identity; it is never used as a canonical locator. */
  textHits?: ExactTextHit[];
  occurrence?: SearchOccurrence;
}

export interface SearchResult {
  spineIndex: number;
  chapterPath: string;
  chapterTitle: string;
  /** Original extracted visible text, or projected display text for display search. */
  snippet: string;
  /** UTF-16 ranges relative to snippet; one range for phrase, one per keyword. */
  snippetMatchRanges: Array<{ start: number; end: number }>;
  /**
   * Canonical range in the original extracted text, measured in UTF-16 code
   * units. For display search this is the source range chosen by the fragment
   * bias rules, not a reverse lookup of the query keyword.
   */
  originalRange: { start: number; end: number };
  /** Existing paginator text-anchor coordinate: original code points, whitespace removed. */
  textOffset: number;
  textSnippet: string;
  /** The matched text in the searched view; block separators rendered as newlines. */
  matchedText: string;
  /** Runtime-only exact body ranges; never persisted to the corpus database. */
  textHits?: ExactTextHit[];
  /** Runtime-only exact identity context for new search navigation. */
  occurrence?: SearchOccurrence;
  /** Present only for display-projected search. */
  display?: SearchDisplayHit;
  matchType: "phrase" | "keywords";
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("搜索已取消");
  error.name = "AbortError";
  throw error;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function publicText(text: string): string {
  return text.replaceAll(BLOCK_BOUNDARY, "\n");
}

/** Build the persisted-anchor snippet without copying/splitting the whole chapter. */
function anchorSnippetFromRaw(text: string, rawStart: number): string {
  const points: string[] = [];
  for (const point of Array.from(text.slice(rawStart))) {
    if (point === BLOCK_BOUNDARY || ANCHOR_WHITESPACE.test(point)) continue;
    points.push(point);
    if (points.length >= MAX_ANCHOR_SNIPPET_CODE_POINTS) break;
  }
  return points.join("");
}

function findAll(haystack: string, needle: string, from = 0): number[] {
  const result: number[] = [];
  if (!needle) return result;
  let index = from;
  while ((index = haystack.indexOf(needle, index)) >= 0) {
    result.push(index);
    index += Math.max(1, needle.length);
  }
  return result;
}

function titleFor(book: Book, path: string): string {
  const target = splitHref(path).path;
  const visit = (nodes: TocNode[]): string | undefined => {
    for (const node of nodes) {
      if (splitHref(node.href).path === target && node.label.trim()) return node.label.trim();
      const nested = visit(node.children);
      if (nested) return nested;
    }
    return undefined;
  };
  const found = visit(book.toc);
  if (found) return found;
  const base = target.split("/").pop() ?? target;
  return base.replace(/\.[^.]+$/, "") || target;
}

function snippetFor(text: string, ranges: Array<{ start: number; end: number }>): {
  snippet: string;
  matchRanges: Array<{ start: number; end: number }>;
  rawStart: number;
  rawEnd: number;
} {
  const before = 48;
  const after = 96;
  const rawStart = Math.min(...ranges.map((range) => range.start));
  const rawEnd = Math.max(...ranges.map((range) => range.end));
  const contextStart = Math.max(0, rawStart - before);
  const contextEnd = Math.min(text.length, rawEnd + after);
  const rawSnippet = publicText(text.slice(contextStart, contextEnd));
  const leading = rawSnippet.length - rawSnippet.trimStart().length;
  return {
    snippet: rawSnippet.trim(),
    rawStart,
    rawEnd,
    matchRanges: ranges.map((range) => ({
      start: Math.max(0, range.start - contextStart - leading),
      end: Math.max(0, range.end - contextStart - leading),
    })),
  };
}

function rawRangeFor(doc: SearchDocument, start: number, end: number): { start: number; end: number } {
  const first = doc.rawStarts[start];
  const last = doc.rawEnds[Math.max(start, end - 1)];
  const rawStart = first ?? 0;
  const rawEnd = last ?? rawStart;
  return { start: rawStart, end: rawEnd };
}

function codePointRangeForUnits(doc: SearchDocument, startUnit: number, endUnit: number): { start: number; end: number } {
  if (endUnit <= startUnit || startUnit < 0 || startUnit >= doc.normalized.length) {
    return { start: 0, end: 0 };
  }
  const start = doc.normalizedUnitToEntry[startUnit] ?? 0;
  const last = doc.normalizedUnitToEntry[Math.min(doc.normalized.length, endUnit) - 1] ?? start;
  return { start, end: last + 1 };
}

function resultFor(
  doc: SearchDocument,
  start: number,
  spineIndex: number,
  chapterPath: string,
  chapterTitle: string,
  matchType: SearchResult["matchType"],
  normalizedRanges: Array<{ start: number; end: number }>,
): SearchResult {
  const rawRanges = normalizedRanges.map((range) => rawRangeFor(doc, range.start, range.end));
  const snippet = snippetFor(doc.text, rawRanges);
  const rawStart = snippet.rawStart;
  const rawEnd = snippet.rawEnd;
  const anchorOffset = doc.anchorStarts[start] ?? 0;
  const exactHits = buildExactTextHitsAndPoints(doc.text, rawRanges);
  const textHits = exactHits?.hits;
  const occurrence = exactHits && textHits
    ? captureSearchOccurrence(exactHits.points, textHits) ?? undefined
    : undefined;
  return {
    spineIndex,
    chapterPath,
    chapterTitle,
    snippet: snippet.snippet,
    snippetMatchRanges: snippet.matchRanges,
    originalRange: { start: rawStart, end: rawEnd },
    textOffset: anchorOffset,
    textSnippet: anchorSnippetFromRaw(doc.text, rawStart),
    matchedText: publicText(doc.text.slice(rawStart, rawEnd)),
    textHits,
    occurrence,
    matchType,
  };
}

interface MatchGroup {
  matchType: SearchResult["matchType"];
  /** Normalized code-point ranges in the scanned document. */
  ranges: Array<{ start: number; end: number }>;
}

function matchGroupsForDocument(doc: SearchDocument, query: string): MatchGroup[] {
  const phrase = normalizeQueryPart(query);
  if (!phrase) return [];
  const groups: MatchGroup[] = [];
  for (const startUnit of findAll(doc.normalized, phrase)) {
    const range = codePointRangeForUnits(doc, startUnit, startUnit + phrase.length);
    groups.push({ matchType: "phrase", ranges: [range] });
  }
  const tokens = query.trim().split(/\s+/u).map(normalizeQueryPart).filter(Boolean);
  if (tokens.length < 2) return groups;
  let segmentStart = 0;
  for (let i = 0; i <= doc.normalized.length; i++) {
    if (i !== doc.normalized.length && doc.normalized[i] !== BLOCK_BOUNDARY) continue;
    const segment = doc.normalized.slice(segmentStart, i);
    const tokenStarts = tokens.map((token) => segment.indexOf(token));
    if (tokenStarts.every((value) => value >= 0)) {
      const ranges = tokenStarts.map((value, index) => codePointRangeForUnits(
        doc,
        segmentStart + value,
        segmentStart + value + tokens[index].length,
      ));
      groups.push({ matchType: "keywords", ranges });
    }
    segmentStart = i + 1;
  }
  return groups;
}

function resultForGroup(
  doc: SearchDocument,
  group: MatchGroup,
  spineIndex: number,
  chapterPath: string,
  chapterTitle: string,
): SearchResult {
  return resultFor(
    doc,
    Math.min(...group.ranges.map((range) => range.start)),
    spineIndex,
    chapterPath,
    chapterTitle,
    group.matchType,
    group.ranges,
  );
}

function matchesForDocument(
  doc: SearchDocument,
  query: string,
  spineIndex: number,
  chapterPath: string,
  chapterTitle: string,
): SearchResult[] {
  const results = matchGroupsForDocument(doc, query)
    .map((group) => resultForGroup(doc, group, spineIndex, chapterPath, chapterTitle));
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    const key = `${result.originalRange.start}:${result.originalRange.end}`;
    const previous = unique.get(key);
    if (!previous || (previous.matchType === "keywords" && result.matchType === "phrase")) unique.set(key, result);
  }
  return [...unique.values()].sort((a, b) => a.originalRange.start - b.originalRange.start);
}

function displayResultForGroup(
  sourceDoc: SearchDocument,
  displayDoc: SearchDocument,
  displayGroup: MatchGroup,
  sourceRanges: ReadonlyArray<{ start: number; end: number }>,
  spineIndex: number,
  chapterPath: string,
  chapterTitle: string,
): SearchResult | null {
  const displayRawRanges = displayGroup.ranges.map((range) =>
    rawRangeFor(displayDoc, range.start, range.end),
  );
  if (displayRawRanges.some((range) => range.end <= range.start)) return null;
  const sourceExact = buildExactTextHitsAndPoints(sourceDoc.text, [...sourceRanges]);
  const displayExact = buildExactTextHitsAndPoints(displayDoc.text, displayRawRanges);
  if (!sourceExact || !displayExact || sourceExact.hits.length === 0) return null;
  const sourceRawStart = Math.min(...sourceRanges.map((range) => range.start));
  const sourceRawEnd = Math.max(...sourceRanges.map((range) => range.end));
  const displayRawStart = Math.min(...displayRawRanges.map((range) => range.start));
  const displayRawEnd = Math.max(...displayRawRanges.map((range) => range.end));
  const displaySnippet = snippetFor(displayDoc.text, displayRawRanges);
  const displayHits = displayExact.hits;
  return {
    spineIndex,
    chapterPath,
    chapterTitle,
    snippet: displaySnippet.snippet,
    snippetMatchRanges: displaySnippet.matchRanges,
    originalRange: { start: sourceRawStart, end: sourceRawEnd },
    textOffset: Math.min(...sourceExact.hits.map((hit) => hit.start)),
    textSnippet: anchorSnippetFromRaw(sourceDoc.text, sourceRawStart),
    matchedText: publicText(displayDoc.text.slice(displayRawStart, displayRawEnd)),
    textHits: sourceExact.hits,
    occurrence: captureSearchOccurrence(sourceExact.points, sourceExact.hits) ?? undefined,
    display: {
      range: { start: displayRawStart, end: displayRawEnd },
      matchedText: publicText(displayDoc.text.slice(displayRawStart, displayRawEnd)),
      textHits: displayHits,
      occurrence: captureSearchOccurrence(displayExact.points, displayHits) ?? undefined,
    },
    matchType: displayGroup.matchType,
  };
}

/**
 * Create a per-book search session. It does not read any chapter at creation;
 * each completed chapter is cached so rapid follow-up queries only rescan
 * normalized arrays. dispose() releases all extracted text and mappings.
 */
export function createSearchSession(book: Book, options: SearchBookOptions = {}): SearchSession {
  const textFor = options.textFor
    ?? (options.resourceServer ? (path: string) => options.resourceServer!.textFor(path) : undefined)
    ?? ((path: string) => {
      const resource = book.resources.get(path);
      return resource ? decodeBytes(resource.data) : undefined;
    });
  const linear = book.spine.map((item, index) => ({ item, index })).filter(({ item }) => item.linear);
  interface CachedChapter {
    source: SearchDocument;
    sourceText: string;
    display: SearchDocument;
    displayText: string;
  }
  const cache = new Map<number, CachedChapter | null>();
  const projection = options.projection;
  let disposed = false;
  return {
    async search(query, queryOptions = {}): Promise<SearchResult[]> {
      if (disposed) throw new Error("搜索会话已释放");
      const maxResults = Math.max(0, Math.floor(queryOptions.maxResults ?? options.maxResults ?? 100));
      if (maxResults === 0) return [];
      const signal = queryOptions.signal ?? options.signal;
      const onProgress = queryOptions.onProgress ?? options.onProgress;
      const yieldToHost = queryOptions.yieldToHost ?? options.yieldToHost ?? defaultYield;
      const results: SearchResult[] = [];
      for (let completed = 0; completed < linear.length; completed++) {
        abortIfNeeded(signal);
        const { index } = linear[completed];
        const path = spineItemPath(book, index);
        if (path) {
          let chapter = cache.get(index);
          if (!cache.has(index)) {
            const source = await textFor(path);
            abortIfNeeded(signal);
            if (source === undefined) {
              chapter = null;
            } else {
              const sourceText = await extractSearchText(source);
              const sourceDoc = buildDocument(sourceText);
              const displayText = projection ? projection.projectText(sourceText) : sourceText;
              chapter = {
                source: sourceDoc,
                sourceText,
                display: displayText === sourceText ? sourceDoc : buildDocument(displayText),
                displayText,
              };
            }
            cache.set(index, chapter);
          }
          if (chapter) {
            if (!projection) {
              results.push(...matchesForDocument(chapter.source, query, index, path, titleFor(book, path)));
            } else {
              const groups = matchGroupsForDocument(chapter.display, query);
              const chapterResults: SearchResult[] = [];
              for (const group of groups) {
                const sourceRanges: Array<{ start: number; end: number }> = [];
                let mapped = true;
                for (const range of group.ranges) {
                  const displayRaw = rawRangeFor(chapter.display, range.start, range.end);
                  const sourceRaw = projection.toSourceRawRange(
                    chapter.sourceText,
                    chapter.displayText,
                    displayRaw.start,
                    displayRaw.end,
                  );
                  if (!sourceRaw) {
                    mapped = false;
                    break;
                  }
                  sourceRanges.push(sourceRaw);
                }
                if (!mapped) continue;
                const result = displayResultForGroup(
                  chapter.source,
                  chapter.display,
                  group,
                  sourceRanges,
                  index,
                  path,
                  titleFor(book, path),
                );
                if (result) chapterResults.push(result);
              }
              // Phrase wins over keyword duplicates of the same visible
              // occurrence. Different display occurrences are never removed
              // merely because they map back to one non-invertible fragment.
              const uniqueChapter = new Map<string, SearchResult>();
              for (const result of chapterResults) {
                const key = `${result.display?.range.start ?? -1}:${result.display?.range.end ?? -1}`;
                const previous = uniqueChapter.get(key);
                if (!previous || (previous.matchType === "keywords" && result.matchType === "phrase")) {
                  uniqueChapter.set(key, result);
                }
              }
              const uniqueResults = [...uniqueChapter.values()].sort((a, b) =>
                a.originalRange.start - b.originalRange.start ||
                (a.display?.range.start ?? 0) - (b.display?.range.start ?? 0),
              );
              results.push(...uniqueResults);
            }
            if (results.length >= maxResults) {
              results.length = maxResults;
              onProgress?.({ completed: completed + 1, total: linear.length, spineIndex: index });
              return results;
            }
          }
        }
        onProgress?.({ completed: completed + 1, total: linear.length, spineIndex: index });
        await yieldToHost();
      }
      return results;
    },
    dispose(): void {
      disposed = true;
      cache.clear();
    },
  };
}

/** One-shot compatibility wrapper; callers with repeated queries should retain a session. */
export async function searchBook(book: Book, query: string, options: SearchBookOptions = {}): Promise<SearchResult[]> {
  const session = createSearchSession(book, options);
  try {
    return await session.search(query, options);
  } finally {
    session.dispose();
  }
}

export { extractSearchText, extractVisibleText, buildDocument, normalizeQueryPart };
export type { SearchDocument };
