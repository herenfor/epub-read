import type { Book } from "../../../core/types";
import { getAppBuildSession } from "../../../config/appBuildSession";
import type { ResolvedCrossBookSearchHit } from "../indexing/indexStore";
import type { ChatSettings, ReadingContext } from "./types";
import type { LibraryBook, ReadingLibrary } from "./retrieval/contracts";
import { currentBookReader, chapterPage } from "./retrieval/currentBook";
import { nativeIndexReader } from "./retrieval/nativeIndex";
import { fuseHits, prepareQueries, rankLexicalHits } from "./retrieval/ranking";
export type { ReadingLibrary, LibraryBook } from "./retrieval/contracts";
export { chapterPage } from "./retrieval/currentBook";
export { fuseHits } from "./retrieval/ranking";

/** Coordinates the active scope and real retrieval adapters; policy/ranking/extraction stay separate. */
export function createReadingLibrary(book: Book, context: ReadingContext, shelf: readonly LibraryBook[], settings: ChatSettings): ReadingLibrary {
  const native = getAppBuildSession()?.source === "desktop";
  const books = [...shelf.filter(entry => entry.hash !== context.bookHash),
    { hash: context.bookHash, title: context.title, creator: context.creator, spineIndex: context.spineIndex }];
  const allowed = new Map(books.filter(entry => settings.scope === "library" || entry.hash === context.bookHash).map(entry => [entry.hash, entry]));
  const current = currentBookReader(book, context, settings.allowLaterChapters);
  const index = nativeIndexReader();
  const canRead = (hash: string, spineIndex: number) => {
    const entry = allowed.get(hash);
    return Boolean(entry && (settings.allowLaterChapters || spineIndex <= entry.spineIndex));
  };
  return {
    context, books, canRead, chapters: () => current.chapters,
    async search(inputQueries, bookHash, signal) {
      const queries = prepareQueries(inputQueries);
      if (!queries.length) return [];
      if (bookHash && !allowed.has(bookHash)) throw new Error("当前阅读范围不能查询这本书");
      if (native) {
        const indexed = await index.indexed();
        signal.throwIfAborted();
        if (settings.scope === "library" || indexed.has(context.bookHash)) {
          const scopes = [...allowed.values()].filter(entry => indexed.has(entry.hash) && (!bookHash || entry.hash === bookHash))
            .map(entry => ({ hash: entry.hash, maxSpineIndex: settings.allowLaterChapters ? null : entry.spineIndex }));
          if (!scopes.length) throw new Error("当前范围尚未建立有效的正文索引，请先在书架正文搜索中建库");
          return fuseHits(await index.search(queries, scopes, signal));
        }
      }
      if (settings.scope === "library") throw new Error("全书库查证需要 Windows 桌面版，并先在书架的正文搜索中建立索引");
      const lists: ResolvedCrossBookSearchHit[][] = queries.map(() => []);
      for (const chapter of current.chapters) {
        const hits = await current.read(chapter.chapterPath, signal);
        queries.forEach((query, i) => { lists[i] = rankLexicalHits([...lists[i], ...hits], query); });
        await new Promise(resolve => setTimeout(resolve, 0));
        signal.throwIfAborted();
      }
      return fuseHits(lists);
    },
    async read(bookHash, chapterPath, offset, signal, aroundChunkId) {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("原文块起点无效");
      if (!allowed.has(bookHash)) throw new Error("当前范围不能读取这本书");
      if (bookHash === context.bookHash) return chapterPage(await current.read(chapterPath, signal), offset, aroundChunkId);
      if (!native) throw new Error("跨书读取需要桌面版正文索引");
      const page = await index.read(bookHash, chapterPath, offset, signal, aroundChunkId);
      return { ...page, hits: page.hits.filter(hit => canRead(hit.contentHash, hit.spineIndex)) };
    },
  };
}
