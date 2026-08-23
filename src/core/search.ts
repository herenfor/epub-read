import { spineItemPath } from "./book";
import { splitHref } from "./paths";
import { hasParserError, parseXmlText } from "./parseXml";
import { isElement, localNameOf, type XmlNodeLike } from "./xml";
import type { Book, TocNode } from "./types";

/** Kept byte-for-byte compatible with the persisted paginator anchor contract. */
const MAX_ANCHOR_SNIPPET_CODE_POINTS = 32;
const ANCHOR_WHITESPACE = /\p{White_Space}/u;

function decodeBytes(data: Uint8Array): string {
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.slice(2));
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.slice(2));
  }
  return new TextDecoder("utf-8").decode(data);
}

/** A private separator which is never produced by normal text normalization. */
const BLOCK_BOUNDARY = "\u0000";
const EXCLUDED_TAGS = new Set(["script", "style", "noscript", "template", "head"]);
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "div", "dl",
  "dt", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "ul",
]);

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
}

export type SearchQueryOptions = Pick<SearchBookOptions, "signal" | "maxResults" | "onProgress" | "yieldToHost">;

export interface SearchSession {
  search(query: string, options?: SearchQueryOptions): Promise<SearchResult[]>;
  dispose(): void;
}

export interface SearchResult {
  spineIndex: number;
  chapterPath: string;
  chapterTitle: string;
  /** Original extracted visible text, with block boundaries represented as newlines. */
  snippet: string;
  /** UTF-16 ranges relative to snippet; one range for phrase, one per keyword. */
  snippetMatchRanges: Array<{ start: number; end: number }>;
  /** The original extracted text range, measured in UTF-16 code units. */
  originalRange: { start: number; end: number };
  /** Existing paginator text-anchor coordinate: code points with all whitespace removed. */
  textOffset: number;
  textSnippet: string;
  /** The matched original text, with internal block separators rendered as newlines. */
  matchedText: string;
  matchType: "phrase" | "keywords";
}

export interface SearchDocument {
  text: string;
  /** Normalized UTF-16 string; BLOCK_BOUNDARY prevents cross-block matches. */
  normalized: string;
  /** Maps each normalized UTF-16 code unit to its normalized code-point index. */
  normalizedUnitToEntry: Uint32Array;
  /** Compact mapping arrays indexed by normalized code-point index. */
  rawStarts: Uint32Array;
  rawEnds: Uint32Array;
  anchorStarts: Uint32Array;
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

function isFootnoteElement(element: XmlNodeLike): boolean {
  const tag = localNameOf(element).toLowerCase();
  if (tag === "aside" && isElement(element)) {
    const type = element.getAttribute("epub:type") ?? element.getAttribute("type") ?? "";
    return /(?:^|\s)footnote(?:\s|$)/i.test(type);
  }
  if (!isElement(element)) return false;
  const type = element.getAttribute("epub:type") ?? element.getAttribute("type") ?? "";
  return /(?:^|\s)footnote(?:\s|$)/i.test(type);
}

function isExcluded(element: XmlNodeLike): boolean {
  if (!isElement(element)) return false;
  const tag = localNameOf(element).toLowerCase();
  if (EXCLUDED_TAGS.has(tag) || isFootnoteElement(element)) return true;
  const hasAttribute = (name: string): boolean => {
    const candidate = element as XmlNodeLike & { hasAttribute?: (name: string) => boolean };
    if (typeof candidate.hasAttribute === "function") return candidate.hasAttribute(name);
    for (let i = 0; i < (element.attributes?.length ?? 0); i++) {
      if (element.attributes?.[i]?.name.toLowerCase() === name) return true;
    }
    return false;
  };
  if (hasAttribute("hidden")) return true;
  return (element.getAttribute("aria-hidden") ?? "").trim().toLowerCase() === "true";
}

/**
 * Convert an XHTML/HTML document to visible structural text. Block elements
 * become a boundary, while inline elements are joined without a separator.
 * The NUL marker is internal and is rendered as a newline in public snippets.
 */
function extractVisibleText(root: XmlNodeLike): string {
  const parts: string[] = [];
  let current = "";
  const flush = (): void => {
    if (!current) return;
    parts.push(current);
    current = "";
  };
  const walk = (node: XmlNodeLike): void => {
    if (node.nodeType === 3) {
      current += node.textContent ?? "";
      return;
    }
    if (!isElement(node) || isExcluded(node)) return;
    const tag = localNameOf(node).toLowerCase();
    if (tag === "br" || tag === "hr") {
      flush();
      parts.push(BLOCK_BOUNDARY);
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) flush();
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    if (block) flush();
  };
  const documentElement = (root as unknown as { documentElement?: XmlNodeLike }).documentElement;
  walk(documentElement ?? root);
  flush();
  return parts.join(BLOCK_BOUNDARY).replace(new RegExp(`${BLOCK_BOUNDARY}+`, "g"), BLOCK_BOUNDARY);
}

function publicText(text: string): string {
  return text.replaceAll(BLOCK_BOUNDARY, "\n");
}

/**
 * EPUB spine documents are XHTML, so parsing them as HTML first is unsafe:
 * HTML treats XML self-closing syntax (notably inside <head>) differently and
 * older WebView2 builds can swallow the following body into that element.
 * Keep the renderer's established contract: strict XML first, HTML only as a
 * compatibility fallback for malformed legacy books.
 */
export async function extractSearchText(source: string): Promise<string> {
  let document = await parseXmlText(source, "application/xml");
  if (hasParserError(document)) document = await parseXmlText(source, "text/html");
  return extractVisibleText(document);
}

/**
 * Build a second index on top of the existing anchor coordinate. NFKC can
 * expand one code point into several, so every normalized code point keeps
 * the source raw range and the anchor position which produced it.
 */
function buildDocument(text: string): SearchDocument {
  if (text.length > 0xffffffff) throw new Error("搜索章节过大，超过 32-bit 偏移范围");
  const normalizedParts: string[] = [];
  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  const anchorStarts: number[] = [];
  let rawOffset = 0;
  let anchorOffset = 0;
  for (const rawPoint of Array.from(text)) {
    const rawStart = rawOffset;
    rawOffset += rawPoint.length;
    if (rawPoint === BLOCK_BOUNDARY) {
      normalizedParts.push(BLOCK_BOUNDARY);
      rawStarts.push(rawStart);
      rawEnds.push(rawOffset);
      anchorStarts.push(anchorOffset);
      continue;
    }
    if (ANCHOR_WHITESPACE.test(rawPoint)) continue;
    anchorOffset++;
    const normalized = rawPoint === "\u00ad" ? "" : rawPoint.normalize("NFKC").toLowerCase();
    for (const value of Array.from(normalized)) {
      if (/\p{White_Space}/u.test(value) || value === "\u00ad") continue;
      normalizedParts.push(value);
      rawStarts.push(rawStart);
      rawEnds.push(rawOffset);
      anchorStarts.push(anchorOffset - 1);
    }
  }
  const normalized = normalizedParts.join("");
  if (rawStarts.length > 0xffffffff || normalized.length > 0xffffffff) {
    throw new Error("搜索章节索引超过 32-bit 偏移范围");
  }
  const normalizedUnitToEntry = new Uint32Array(normalized.length);
  let unitOffset = 0;
  let entryIndex = 0;
  for (const point of Array.from(normalized)) {
    for (let unit = 0; unit < point.length; unit++) normalizedUnitToEntry[unitOffset++] = entryIndex;
    entryIndex++;
  }
  return {
    text,
    normalized,
    normalizedUnitToEntry,
    rawStarts: Uint32Array.from(rawStarts),
    rawEnds: Uint32Array.from(rawEnds),
    anchorStarts: Uint32Array.from(anchorStarts),
  };
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

function normalizeQueryPart(value: string): string {
  return Array.from(value.normalize("NFKC").toLowerCase())
    .filter((point) => point !== "\u00ad" && !/\p{White_Space}/u.test(point))
    .join("");
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
    matchType,
  };
}

function matchesForDocument(
  doc: SearchDocument,
  query: string,
  spineIndex: number,
  chapterPath: string,
  chapterTitle: string,
): SearchResult[] {
  const phrase = normalizeQueryPart(query);
  if (!phrase) return [];
  const results: SearchResult[] = [];
  for (const startUnit of findAll(doc.normalized, phrase)) {
    const range = codePointRangeForUnits(doc, startUnit, startUnit + phrase.length);
    results.push(resultFor(doc, range.start, spineIndex, chapterPath, chapterTitle, "phrase", [range]));
  }
  const tokens = query.trim().split(/\s+/u).map(normalizeQueryPart).filter(Boolean);
  if (tokens.length < 2) return results;
  let segmentStart = 0;
  for (let i = 0; i <= doc.normalized.length; i++) {
    if (i !== doc.normalized.length && doc.normalized[i] !== BLOCK_BOUNDARY) continue;
    const segment = doc.normalized.slice(segmentStart, i);
    const tokenStarts = tokens.map((token) => {
      return segment.indexOf(token);
    });
    if (tokenStarts.every((value) => value >= 0)) {
      const ranges = tokenStarts.map((value, index) => codePointRangeForUnits(
        doc,
        segmentStart + value,
        segmentStart + value + tokens[index].length,
      ));
      results.push(resultFor(doc, Math.min(...ranges.map((range) => range.start)), spineIndex, chapterPath, chapterTitle, "keywords", ranges));
    }
    segmentStart = i + 1;
  }
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    const key = `${result.originalRange.start}:${result.originalRange.end}`;
    const previous = unique.get(key);
    if (!previous || (previous.matchType === "keywords" && result.matchType === "phrase")) unique.set(key, result);
  }
  return [...unique.values()].sort((a, b) => a.originalRange.start - b.originalRange.start);
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
  const cache = new Map<number, SearchDocument | null>();
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
          let doc = cache.get(index);
          if (!cache.has(index)) {
            const source = await textFor(path);
            abortIfNeeded(signal);
            doc = source === undefined
              ? null
              : buildDocument(await extractSearchText(source));
            cache.set(index, doc);
          }
          if (doc) {
            results.push(...matchesForDocument(doc, query, index, path, titleFor(book, path)));
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

export { extractVisibleText, buildDocument, normalizeQueryPart };
