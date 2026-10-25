import { createShelfBookAccess, type ReaderBookAccess } from "./bookAccess";
import { CORPUS_NORMALIZER_VERSION, CORPUS_PARSER_VERSION } from "../../../core/corpus";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { getShelfStore } from "../../../ui/shelf";
import { effectiveFolderId, isFavorite } from "../../../ui/libraryOrganization";
import { currentBookReader } from "../companion/retrieval/currentBook";
import { rankLexicalHits } from "../companion/retrieval/ranking";
import type { ResolvedCrossBookSearchHit } from "../indexing/indexStore";
import { ReaderToolError, type ReaderPassage, type ReaderToolBackend } from "./contracts";

const corpusVersion = [CORPUS_PARSER_VERSION, CORPUS_NORMALIZER_VERSION, CORPUS_CHUNKER_VERSION].join(":");
const passage = (bookId: string, hit: ResolvedCrossBookSearchHit): ReaderPassage => ({ bookId, contentHash: hit.contentHash,
  chapterId: hit.chapterPath, spineIndex: hit.spineIndex, chunkId: hit.chunkId, corpusVersion,
  originalText: hit.originalText, anchor: hit.textAnchor });

/** Separate archive ownership: no renderer, markOpened, progress write or memory access. */
export function createShelfToolBackend(access: ReaderBookAccess = createShelfBookAccess()): ReaderToolBackend {
  function withBook<T>(id: string, signal: AbortSignal, work: (reader: ReturnType<typeof currentBookReader>) => Promise<T>) {
    return access(id, signal, (book, entry) => {
      const reader = currentBookReader(book, { bookHash: entry.contentHash ?? entry.id, title: entry.title,
        creator: entry.creator, spineIndex: book.spine.length - 1 }, true);
      return work({ ...reader, async read(path, readSignal) {
        try { return await reader.read(path, readSignal); }
        finally {
          const resource = book.resources.get(path);
          if (resource) { resource.data = new Uint8Array(0); resource.loaded = false; }
        }
      } });
    });
  }
  return {
    async list(signal) {
      const store = getShelfStore();
      const [books, organization] = await Promise.all([store.list(), store.getOrganization()]);
      signal.throwIfAborted();
      return books.map(entry => ({ bookId: entry.id, contentHash: entry.contentHash, title: entry.title, creator: entry.creator,
        available: entry.available !== false, favorite: isFavorite(organization, entry.contentHash ?? entry.id),
        folderId: effectiveFolderId(organization, entry.contentHash ?? entry.id) }));
    },
    chapters: (id, signal) => withBook(id, signal, async reader => reader.chapters.map(chapter => ({
      chapterId: chapter.chapterPath, title: chapter.title, spineIndex: chapter.spineIndex,
    }))),
    read: (id, chapter, signal) => withBook(id, signal, async reader => {
      if (!reader.chapters.some(item => item.chapterPath === chapter)) throw new ReaderToolError("CHAPTER_NOT_FOUND", "此书没有指定章节");
      return (await reader.read(chapter, signal)).map(hit => passage(id, hit));
    }),
    search: (id, query, limit, signal) => withBook(id, signal, async reader => {
      let best: ResolvedCrossBookSearchHit[] = [];
      let matches = 0;
      for (const chapter of reader.chapters) {
        signal.throwIfAborted();
        const hits = await reader.read(chapter.chapterPath, signal);
        const ranked = rankLexicalHits(hits, query);
        matches += ranked.length;
        best = rankLexicalHits([...best, ...ranked], query).slice(0, limit);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return { items: best.map(hit => passage(id, hit)), truncated: matches > best.length, scannedChapters: reader.chapters.length };
    }),
  };
}
