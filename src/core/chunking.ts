import {
  CORPUS_NORMALIZER_VERSION,
  type CorpusChapter,
  type CorpusBlock,
  type TextAnchor,
  normalizeCorpusText,
} from "./corpus";

/** Chunk version is intentionally separate from parser and normalizer versions. */
export const CORPUS_CHUNKER_VERSION = "structural-sentence-v1";
const DEFAULT_MAX_CODE_POINTS = 1200;
const DEFAULT_OVERLAP_CODE_POINTS = 120;

export interface DocumentChunk {
  bookFingerprint: string;
  chunkId: string;
  chapterPath: string;
  chapterTitle: string;
  spineIndex: number;
  contentType: CorpusBlock["contentType"] | "mixed";
  originalText: string;
  normalizedText: string;
  textAnchor: TextAnchor;
  parserVersion: string;
  normalizerVersion: string;
  chunkerVersion: string;
  /** Structural unit indexes used to make the ID and explain overlap. */
  unitStart: number;
  unitEnd: number;
}

export interface ChunkingOptions {
  bookFingerprint: string;
  maxCodePoints?: number;
  overlapCodePoints?: number;
  parserVersion?: string;
  normalizerVersion?: string;
  chunkerVersion?: string;
}

interface Unit {
  text: string;
  contentType: CorpusBlock["contentType"];
  anchor: TextAnchor;
  sourceStart: number;
  sourceEnd: number;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function nonWhitespaceLength(value: string): number {
  return Array.from(value).filter((point) => !/\p{White_Space}/u.test(point)).length;
}

function anchorSnippet(value: string): string {
  return Array.from(value).filter((point) => !/\p{White_Space}/u.test(point)).slice(0, 32).join("");
}

function anchorFor(block: CorpusBlock, rawStart: number, rawEnd: number): TextAnchor {
  const prefix = block.originalText.slice(0, rawStart);
  const text = block.originalText.slice(rawStart, rawEnd);
  const start = block.textAnchor.start + nonWhitespaceLength(prefix);
  return { start, end: start + nonWhitespaceLength(text), snippet: anchorSnippet(text) };
}

/** Split a block only at sentence punctuation when it exceeds the target size. */
function splitBlock(block: CorpusBlock, maxCodePoints: number): Unit[] {
  const points = Array.from(block.originalText);
  if (points.length <= maxCodePoints) {
    return [{
      text: block.originalText,
      contentType: block.contentType,
      anchor: block.textAnchor,
      sourceStart: 0,
      sourceEnd: block.originalText.length,
    }];
  }
  // Array.from gives code-point boundaries while this prefix table converts
  // them back to the UTF-16 offsets used by DOM ranges in linear time.
  const utf16Offsets = new Array<number>(points.length + 1);
  utf16Offsets[0] = 0;
  for (let i = 0; i < points.length; i++) {
    utf16Offsets[i + 1] = utf16Offsets[i] + points[i].length;
  }
  const units: Unit[] = [];
  let startPoint = 0;
  while (startPoint < points.length) {
    const hardEnd = Math.min(points.length, startPoint + maxCodePoints);
    let endPoint = hardEnd;
    // Prefer the last sentence boundary in this window. If none exists, the
    // hard limit is still a deterministic and safe fallback for long tokens.
    for (let i = hardEnd - 1; i >= startPoint; i--) {
      if (/[。！？!?；;.!?]/u.test(points[i])) {
        endPoint = i + 1;
        break;
      }
    }
    if (endPoint <= startPoint) endPoint = hardEnd;
    const sourceStart = utf16Offsets[startPoint];
    const sourceEnd = utf16Offsets[endPoint];
    const text = block.originalText.slice(sourceStart, sourceEnd);
    units.push({
      text,
      contentType: block.contentType,
      anchor: anchorFor(block, sourceStart, sourceEnd),
      sourceStart,
      sourceEnd,
    });
    startPoint = endPoint;
  }
  return units;
}

function unitsFor(chapter: CorpusChapter, maxCodePoints: number): Unit[] {
  return chapter.blocks.flatMap((block) => splitBlock(block, maxCodePoints));
}

function makeId(
  chapter: CorpusChapter,
  options: Required<Pick<ChunkingOptions, "bookFingerprint" | "parserVersion" | "normalizerVersion" | "chunkerVersion">>,
  unitStart: number,
  unitEnd: number,
  text: string,
): string {
  return `chunk_${fnv1a64(JSON.stringify([
    options.bookFingerprint, chapter.chapterPath, chapter.spineIndex,
    unitStart, unitEnd, text, options.parserVersion, options.normalizerVersion, options.chunkerVersion,
  ]))}`;
}

function chunkChapter(chapter: CorpusChapter, input: ChunkingOptions): DocumentChunk[] {
  const maxCodePoints = Math.max(1, Math.floor(input.maxCodePoints ?? DEFAULT_MAX_CODE_POINTS));
  const overlap = Math.max(0, Math.min(maxCodePoints - 1, Math.floor(input.overlapCodePoints ?? DEFAULT_OVERLAP_CODE_POINTS)));
  const options = {
    bookFingerprint: input.bookFingerprint,
    parserVersion: input.parserVersion ?? chapter.parserVersion,
    normalizerVersion: input.normalizerVersion ?? chapter.normalizerVersion ?? CORPUS_NORMALIZER_VERSION,
    chunkerVersion: input.chunkerVersion ?? CORPUS_CHUNKER_VERSION,
  };
  const units = unitsFor(chapter, maxCodePoints);
  const result: DocumentChunk[] = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let size = 0;
    while (end < units.length) {
      const added = Array.from(units[end].text).length + (end > start ? 1 : 0);
      if (end > start && size + added > maxCodePoints) break;
      size += added;
      end++;
      if (size >= maxCodePoints) break;
    }
    const selected = units.slice(start, end);
    const originalText = selected.map((unit) => unit.text).join("\n");
    const first = selected[0];
    const last = selected[selected.length - 1];
    const contentTypes = new Set(selected.map((unit) => unit.contentType));
    const textAnchor: TextAnchor = {
      start: first.anchor.start,
      end: last.anchor.end,
      snippet: anchorSnippet(originalText),
    };
    result.push({
      bookFingerprint: options.bookFingerprint,
      chunkId: makeId(chapter, options, start, end, originalText),
      chapterPath: chapter.chapterPath,
      chapterTitle: chapter.chapterTitle,
      spineIndex: chapter.spineIndex,
      contentType: contentTypes.size === 1 ? first.contentType : "mixed",
      originalText,
      normalizedText: normalizeCorpusText(originalText),
      textAnchor,
      parserVersion: options.parserVersion,
      normalizerVersion: options.normalizerVersion,
      chunkerVersion: options.chunkerVersion,
      unitStart: start,
      unitEnd: end,
    });
    if (end >= units.length) break;
    let overlapSize = 0;
    let nextStart = end;
    while (nextStart > start && overlapSize < overlap) {
      const candidate = units[nextStart - 1];
      const added = Array.from(candidate.text).length + (nextStart < end ? 1 : 0);
      if (overlapSize + added > overlap && nextStart < end - 1) break;
      overlapSize += added;
      nextStart--;
    }
    start = Math.max(start + 1, nextStart);
  }
  return result;
}

export function chunkCorpus(chapter: CorpusChapter, options: ChunkingOptions): DocumentChunk[];
export function chunkCorpus(chapters: readonly CorpusChapter[], options: ChunkingOptions): DocumentChunk[];
export function chunkCorpus(
  chapterOrChapters: CorpusChapter | readonly CorpusChapter[],
  options: ChunkingOptions,
): DocumentChunk[] {
  const chapters = Array.isArray(chapterOrChapters) ? chapterOrChapters : [chapterOrChapters];
  return chapters.flatMap((chapter) => chunkChapter(chapter, options));
}
