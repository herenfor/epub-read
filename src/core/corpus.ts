import { hasParserError, parseXmlText } from "./parseXml";
import { isElement, localNameOf, type XmlNodeLike } from "./xml";

/** Versions are part of every persisted derived-data identity. */
export const CORPUS_PARSER_VERSION = "visible-xhtml-v2";
export const CORPUS_NORMALIZER_VERSION = "nfkc-lower-anchor-v1";
export const BLOCK_BOUNDARY = "\u0000";
export const MAX_ANCHOR_SNIPPET_CODE_POINTS = 32;

const ANCHOR_WHITESPACE = /\p{White_Space}/u;
const EXCLUDED_TAGS = new Set(["script", "style", "noscript", "template", "head"]);
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "div", "dl",
  "dt", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "ul",
]);

export type CorpusContentType =
  | "body"
  | "heading"
  | "paragraph"
  | "list"
  | "blockquote"
  | "caption"
  | "footnote"
  | "toc"
  | "copyright"
  | "frontmatter";

export interface TextAnchor {
  /** Code-point offset in visible chapter text, with whitespace omitted. */
  start: number;
  /** Exclusive code-point offset in visible chapter text. */
  end: number;
  /** Whitespace-free text used to recover a range in the reader DOM. */
  snippet: string;
}

export interface CorpusBlock {
  contentType: CorpusContentType;
  /** Original visible text for this structural block. */
  originalText: string;
  /** Normalized text used by downstream indexes, with Unicode whitespace as single spaces. */
  normalizedText: string;
  /** UTF-16 range in the chapter's extracted text (before public newline rendering). */
  originalRange: { start: number; end: number };
  textAnchor: TextAnchor;
}

export interface CorpusChapter {
  bookFingerprint: string;
  chapterPath: string;
  chapterTitle: string;
  spineIndex: number;
  parserVersion: string;
  normalizerVersion: string;
  /** NUL-separated extracted text, matching the current search contract. */
  text: string;
  blocks: CorpusBlock[];
}

export interface SearchDocument {
  text: string;
  normalized: string;
  normalizedUnitToEntry: Uint32Array;
  rawStarts: Uint32Array;
  rawEnds: Uint32Array;
  anchorStarts: Uint32Array;
}

export interface ExtractCorpusOptions {
  /** Keep explicit footnotes as typed blocks. Search keeps the historical default false. */
  includeFootnotes?: boolean;
  parserVersion?: string;
  normalizerVersion?: string;
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

function isExcluded(element: XmlNodeLike, includeFootnotes: boolean): boolean {
  if (!isElement(element)) return false;
  const tag = localNameOf(element).toLowerCase();
  if (EXCLUDED_TAGS.has(tag) || (!includeFootnotes && isFootnoteElement(element))) return true;
  const candidate = element as XmlNodeLike & { hasAttribute?: (name: string) => boolean };
  const hasAttribute = (name: string): boolean => {
    if (typeof candidate.hasAttribute === "function") return candidate.hasAttribute(name);
    for (let i = 0; i < (element.attributes?.length ?? 0); i++) {
      if (element.attributes?.[i]?.name.toLowerCase() === name) return true;
    }
    return false;
  };
  if (hasAttribute("hidden")) return true;
  return (element.getAttribute("aria-hidden") ?? "").trim().toLowerCase() === "true";
}

function contentTypeFor(tag: string, footnote: boolean, element?: XmlNodeLike): CorpusContentType {
  if (footnote) return "footnote";
  const semanticType = element && isElement(element)
    ? `${element.getAttribute("epub:type") ?? ""} ${element.getAttribute("type") ?? ""}`.toLowerCase()
    : "";
  if (/(?:^|\s)(?:toc|table-of-contents|landmarks)(?:\s|$)/u.test(semanticType)) return "toc";
  if (/(?:^|\s)copyright(?:-page)?(?:\s|$)/u.test(semanticType)) return "copyright";
  if (/(?:^|\s)(?:frontmatter|front-matter)(?:\s|$)/u.test(semanticType)) return "frontmatter";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (["li", "dt", "dd", "ul", "ol"].includes(tag)) return "list";
  if (tag === "blockquote") return "blockquote";
  if (["caption", "figcaption"].includes(tag)) return "caption";
  if (["p", "pre"].includes(tag)) return "paragraph";
  return "body";
}

function isSemanticContainerType(type: CorpusContentType): boolean {
  return type === "footnote" || type === "toc" || type === "copyright" || type === "frontmatter";
}

/** Extract structural visible blocks without touching the renderer DOM. */
export function extractVisibleCorpus(root: XmlNodeLike, options: ExtractCorpusOptions = {}): CorpusBlock[] {
  const includeFootnotes = options.includeFootnotes ?? false;
  const blocks: Array<{ contentType: CorpusContentType; text: string }> = [];
  let current = "";
  let currentType: CorpusContentType = "body";
  const flush = (restoreType: CorpusContentType = "body"): void => {
    if (normalizeCorpusText(current)) blocks.push({ contentType: currentType, text: current });
    current = "";
    currentType = restoreType;
  };
  const walk = (node: XmlNodeLike, inheritedType: CorpusContentType): void => {
    if (node.nodeType === 3) {
      current += node.textContent ?? "";
      return;
    }
    if (!isElement(node) || isExcluded(node, includeFootnotes)) return;
    const tag = localNameOf(node).toLowerCase();
    if (tag === "br" || tag === "hr") {
      // A line break ends the current block but does not end its semantic
      // parent; text after <br> in a paragraph remains a paragraph.
      flush(inheritedType);
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) {
      flush(inheritedType);
      const ownType = contentTypeFor(tag, isFootnoteElement(node), node);
      // Explicit semantic containers (toc/copyright/frontmatter/footnote)
      // dominate generic child tags such as p/li so provenance is retained.
      const nextType = isSemanticContainerType(inheritedType)
        ? inheritedType
        : ownType === "body"
        ? inheritedType
        : ownType;
      currentType = nextType;
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], nextType);
      flush(inheritedType);
      return;
    }
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], inheritedType);
  };
  const documentElement = (root as unknown as { documentElement?: XmlNodeLike }).documentElement;
  walk(documentElement ?? root, "body");
  flush();
  return blocks.map((block) => ({
    contentType: block.contentType,
    originalText: block.text,
    normalizedText: normalizeCorpusText(block.text),
    originalRange: { start: 0, end: block.text.length },
    textAnchor: { start: 0, end: 0, snippet: anchorSnippet(block.text, 0) },
  }));
}

/** Search-compatible extracted text: block boundaries are private NULs. */
export function extractVisibleText(root: XmlNodeLike): string {
  // Keep the legacy search contract exact, including boundaries produced by
  // leading/trailing <br>/<hr>; the richer block extractor intentionally
  // omits empty blocks because they cannot be indexed or cited.
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
    if (!isElement(node) || isExcluded(node, false)) return;
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

export async function extractSearchText(source: string): Promise<string> {
  let document = await parseXmlText(source, "application/xml");
  if (hasParserError(document)) document = await parseXmlText(source, "text/html");
  return extractVisibleText(document);
}

/** NFKC/lower-case normalization; Unicode whitespace becomes one ASCII space. */
export function normalizeCorpusText(value: string): string {
  return Array.from(value.normalize("NFKC").toLowerCase())
    .filter((point) => point !== "\u00ad")
    .map((point) => /\p{White_Space}/u.test(point) ? " " : point)
    .join("")
    .replace(/ +/g, " ")
    .trim();
}

export function normalizeQueryPart(value: string): string {
  return Array.from(value.normalize("NFKC").toLowerCase())
    .filter((point) => point !== "\u00ad" && !/\p{White_Space}/u.test(point))
    .join("");
}

export function buildDocument(text: string): SearchDocument {
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
      if (ANCHOR_WHITESPACE.test(value) || value === "\u00ad") continue;
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
    text, normalized, normalizedUnitToEntry,
    rawStarts: Uint32Array.from(rawStarts), rawEnds: Uint32Array.from(rawEnds),
    anchorStarts: Uint32Array.from(anchorStarts),
  };
}

function anchorLength(value: string): number {
  return Array.from(value).filter((point) => point !== BLOCK_BOUNDARY && !ANCHOR_WHITESPACE.test(point)).length;
}

function anchorSnippet(value: string, start = 0): string {
  return Array.from(value.slice(start))
    .filter((point) => !ANCHOR_WHITESPACE.test(point))
    .slice(0, MAX_ANCHOR_SNIPPET_CODE_POINTS)
    .join("");
}

/** Turn parsed blocks into a chapter object with global, reader-compatible anchors. */
export function createCorpusChapter(
  metadata: Pick<CorpusChapter, "bookFingerprint" | "chapterPath" | "chapterTitle" | "spineIndex">,
  blocks: readonly CorpusBlock[],
  versions: Pick<CorpusChapter, "parserVersion" | "normalizerVersion"> = {
    parserVersion: CORPUS_PARSER_VERSION,
    normalizerVersion: CORPUS_NORMALIZER_VERSION,
  },
): CorpusChapter {
  const searchableBlocks = blocks.filter((block) => normalizeCorpusText(block.originalText).length > 0);
  const text = searchableBlocks.map((block) => block.originalText).join(BLOCK_BOUNDARY)
    .replace(new RegExp(`${BLOCK_BOUNDARY}+`, "g"), BLOCK_BOUNDARY);
  const built = buildDocument(text);
  const sourceBlocks = searchableBlocks.map((block) => block.originalText);
  let cursor = 0;
  const rebuilt = sourceBlocks.map((value, index) => {
    const start = text.indexOf(value, cursor);
    const actualStart = start < 0 ? cursor : start;
    const end = actualStart + value.length;
    cursor = end + (index < sourceBlocks.length - 1 ? 1 : 0);
    const anchorStart = anchorLength(text.slice(0, actualStart));
    const anchorEnd = anchorStart + anchorLength(value);
    return {
      ...searchableBlocks[index],
      normalizedText: normalizeCorpusText(value),
      originalRange: { start: actualStart, end },
      textAnchor: { start: anchorStart, end: anchorEnd, snippet: anchorSnippet(value) },
    };
  });
  // Keep the buildDocument call above as a size/offset validation even for empty chapters.
  void built;
  return { ...metadata, ...versions, text, blocks: rebuilt };
}

/** Parse and build one chapter for callers that own the EPUB resource bytes. */
export async function extractCorpusChapter(
  metadata: Pick<CorpusChapter, "bookFingerprint" | "chapterPath" | "chapterTitle" | "spineIndex">,
  source: string,
  options: ExtractCorpusOptions = {},
): Promise<CorpusChapter> {
  let document = await parseXmlText(source, "application/xml");
  if (hasParserError(document)) document = await parseXmlText(source, "text/html");
  const blocks = extractVisibleCorpus(document, options);
  return createCorpusChapter(metadata, blocks, {
    parserVersion: options.parserVersion ?? CORPUS_PARSER_VERSION,
    normalizerVersion: options.normalizerVersion ?? CORPUS_NORMALIZER_VERSION,
  });
}
