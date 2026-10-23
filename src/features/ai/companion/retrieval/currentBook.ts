import type { Book } from "../../../../core/types";
import { spineItemPath } from "../../../../core/book";
import { readBookResourceText } from "../../../../core/bookCorpusIndex";
import { extractCorpusChapter } from "../../../../core/corpus";
import { chunkCorpus } from "../../../../core/chunking";
import type { ResolvedCrossBookSearchHit } from "../../indexing/indexStore";
import type { ReadingContext } from "../types";
import type { ChapterPage } from "./contracts";

export function chapterPage(chunks: ResolvedCrossBookSearchHit[], offset: number, aroundChunkId?: string): ChapterPage {
  if (aroundChunkId) {
    const index = chunks.findIndex(chunk => chunk.chunkId === aroundChunkId);
    if (index < 0) throw new Error("命中段落已失效，请重新检索");
    offset = Math.max(0, index - 2);
  }
  const hits = chunks.slice(offset, offset + 8);
  return { hits, offset, nextOffset: offset + hits.length < chunks.length ? offset + hits.length : null };
}

/** Owns only a small text extraction cache, never renderer resources or pagination. */
export function currentBookReader(book: Book, context: ReadingContext, allowLaterChapters: boolean) {
  const paths = book.spine.map((_, index) => spineItemPath(book, index));
  const titles = new Map<string, string>();
  const visit = (nodes: Book["toc"]) => { for (const node of nodes) { titles.set(node.href.split("#")[0], node.label); visit(node.children); } };
  visit(book.toc);
  const cache = new Map<string, ResolvedCrossBookSearchHit[]>();
  const chapters = paths.flatMap((path, spineIndex) => path && (allowLaterChapters || spineIndex <= context.spineIndex)
    ? [{ chapterPath: path, spineIndex, title: titles.get(path) || path }] : []);
  return {
    chapters,
    async read(path: string, signal: AbortSignal): Promise<ResolvedCrossBookSearchHit[]> {
      signal.throwIfAborted();
      if (!chapters.some(chapter => chapter.chapterPath === path)) return [];
      const cached = cache.get(path);
      if (cached) return cached;
      const spineIndex = paths.indexOf(path);
      const html = await readBookResourceText(book, path, signal);
      if (html === undefined) throw new Error("无法读取这一章的原文");
      const corpus = await extractCorpusChapter({ bookFingerprint: context.bookHash, chapterPath: path,
        chapterTitle: titles.get(path) || path, spineIndex }, html);
      signal.throwIfAborted();
      const chunks = chunkCorpus(corpus, { bookFingerprint: context.bookHash }).map(chunk => ({
        contentHash: context.bookHash, title: context.title, creator: context.creator, chunkId: chunk.chunkId,
        spineIndex, chapterPath: path, chapterTitle: chunk.chapterTitle, contentType: chunk.contentType,
        originalText: chunk.originalText, normalizedText: chunk.normalizedText, textAnchor: chunk.textAnchor,
      }));
      cache.set(path, chunks);
      if (cache.size > 3) cache.delete(cache.keys().next().value!);
      return chunks;
    },
  };
}
