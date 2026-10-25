import { createArchiveClient, type ArchiveClient } from "../../../core/selectiveArchive";
import { disposeBook, loadBookFromArchive } from "../../../core/book";
import { CORPUS_NORMALIZER_VERSION, CORPUS_PARSER_VERSION } from "../../../core/corpus";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { getShelfStore, isTauriEnv } from "../../../ui/shelf";
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
export function createShelfToolBackend(): ReaderToolBackend {
  async function withBook<T>(bookId: string, signal: AbortSignal, work: (reader: ReturnType<typeof currentBookReader>) => Promise<T>) {
    const store = getShelfStore();
    const entry = (await store.list()).find(entry => entry.id === bookId);
    if (!entry) throw new ReaderToolError("BOOK_NOT_FOUND", "书籍已经离开书架");
    signal.throwIfAborted();
    let archive: ArchiveClient;
    try { archive = isTauriEnv() && store.openArchive ? await store.openArchive(bookId) : await createArchiveClient(await store.readBook(bookId)); }
    catch { signal.throwIfAborted(); throw new ReaderToolError("SOURCE_UNAVAILABLE", "原书当前不可读取，请检查来源"); }
    const close = () => archive.close();
    signal.addEventListener("abort", close, { once: true });
    let book: Awaited<ReturnType<typeof loadBookFromArchive>> | undefined;
    try {
      signal.throwIfAborted();
      book = await loadBookFromArchive(archive, { preloadCover: false });
      signal.throwIfAborted();
      const reader = currentBookReader(book, { bookHash: entry.contentHash ?? entry.id, title: entry.title,
        creator: entry.creator, spineIndex: book.spine.length - 1 }, true);
      return await work({ ...reader, async read(path, readSignal) {
        try { return await reader.read(path, readSignal); }
        finally {
          // This Book belongs only to the tool call. Release extracted chapter
          // bytes as we scan; the existing text cache retains at most 3 chapters.
          const resource = book?.resources.get(path);
          if (resource) { resource.data = new Uint8Array(0); resource.loaded = false; }
        }
      } });
    } finally { signal.removeEventListener("abort", close); if (book) disposeBook(book); else close(); }
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
