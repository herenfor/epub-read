import { spineItemPath } from "./book";
import { chunkCorpus, type ChunkingOptions, type DocumentChunk } from "./chunking";
import { extractCorpusChapter, type ExtractCorpusOptions } from "./corpus";
import { splitHref } from "./paths";
import type { Book, TocNode } from "./types";

export interface BookChunkBatch {
  spineIndex: number;
  chapterPath: string;
  chapterTitle: string;
  chunks: DocumentChunk[];
}

export interface BookCorpusIndexOptions {
  bookFingerprint: string;
  textFor(path: string): string | undefined | Promise<string | undefined>;
  signal?: AbortSignal;
  extract?: ExtractCorpusOptions;
  chunking?: Omit<ChunkingOptions, "bookFingerprint">;
}

/** Decode a manifest text resource without creating render-layer Blob URLs. */
export function textForBookResource(book: Book, path: string): string | undefined {
  const resource = book.resources.get(path);
  if (!resource) return undefined;
  const data = resource.data;
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.slice(2));
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.slice(2));
  }
  return new TextDecoder("utf-8").decode(data);
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("正文建库已取消");
  error.name = "AbortError";
  throw error;
}

function chapterTitleFor(book: Book, path: string): string {
  const target = splitHref(path).path;
  const visit = (nodes: readonly TocNode[]): string | undefined => {
    for (const node of nodes) {
      if (splitHref(node.href).path === target && node.label.trim()) return node.label.trim();
      const nested = visit(node.children);
      if (nested) return nested;
    }
    return undefined;
  };
  return visit(book.toc) ?? target.split("/").pop()?.replace(/\.[^.]+$/, "") ?? target;
}

/**
 * Produce one bounded chapter batch at a time. The caller owns scheduling and
 * persistence so the reader core never depends on SQLite or AI lifecycle code.
 */
export async function* iterateBookChunkBatches(
  book: Book,
  options: BookCorpusIndexOptions,
): AsyncGenerator<BookChunkBatch> {
  for (let spineIndex = 0; spineIndex < book.spine.length; spineIndex++) {
    abortIfNeeded(options.signal);
    if (!book.spine[spineIndex].linear) continue;
    const chapterPath = spineItemPath(book, spineIndex);
    if (!chapterPath) continue;
    const source = await options.textFor(chapterPath);
    abortIfNeeded(options.signal);
    if (source === undefined) throw new Error(`无法读取待索引章节：${chapterPath}`);
    const chapterTitle = chapterTitleFor(book, chapterPath);
    const corpus = await extractCorpusChapter({
      bookFingerprint: options.bookFingerprint,
      chapterPath,
      chapterTitle,
      spineIndex,
    }, source, options.extract);
    abortIfNeeded(options.signal);
    yield {
      spineIndex,
      chapterPath,
      chapterTitle,
      chunks: chunkCorpus(corpus, { bookFingerprint: options.bookFingerprint, ...options.chunking }),
    };
  }
}
