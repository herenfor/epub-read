import { nativeIndexReader } from "../retrieval/indexed";
import { fuseHits } from "../retrieval/lexical";
import { indexStatusIsCurrent } from "../indexing/libraryIndexer";
import { listIndexedBooks, type IndexedBookStatus, type ResolvedCrossBookSearchHit } from "../indexing/indexStore";
import { CORPUS_PARSER_VERSION, CORPUS_NORMALIZER_VERSION } from "../../../core/corpus";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import type { ReaderToolBackend, ReaderSearchCoverage } from "./contracts";

interface IndexedSearchPort {
  list(): Promise<IndexedBookStatus[]>;
  search(queries: string[], scopes: { hash: string; maxSpineIndex: null }[], signal: AbortSignal): Promise<ResolvedCrossBookSearchHit[][]>;
}
const corpusVersion = [CORPUS_PARSER_VERSION, CORPUS_NORMALIZER_VERSION, CORPUS_CHUNKER_VERSION].join(":");

/** The service supplies already-authorized shelf records. Scope reaches SQL
 * before Top-K, and queries never open EPUBs or silently prepare an index. */
export function createIndexedSearchBackend(port: IndexedSearchPort = {
  list: listIndexedBooks, search: (queries, scopes, signal) => nativeIndexReader().search(queries, scopes, signal),
}): Pick<ReaderToolBackend, "searchLibrary"> {
  return { async searchLibrary(books, queries, limit, signal) {
    signal.throwIfAborted();
    const statuses = new Map((await port.list()).map(status => [status.contentHash, status]));
    signal.throwIfAborted();
    const coverage: ReaderSearchCoverage = { scopeBooks: books.length, indexedBooks: 0, missingIndexBooks: 0,
      outdatedIndexBooks: 0, unavailableBooks: 0, complete: false };
    const eligible = new Map<string, typeof books[number]>();
    for (const book of books) {
      const hash = book.contentHash ?? book.bookId;
      const status = statuses.get(hash);
      if (!book.available) coverage.unavailableBooks++;
      else if (!status) coverage.missingIndexBooks++;
      else if (!indexStatusIsCurrent(status)) coverage.outdatedIndexBooks++;
      else { coverage.indexedBooks++; eligible.set(hash, book); }
    }
    coverage.complete = coverage.indexedBooks === coverage.scopeBooks;
    if (!eligible.size) return { items: [], coverage, candidateLimitReached: false };
    const lists = await port.search(queries, [...eligible.keys()].map(hash => ({ hash, maxSpineIndex: null })), signal);
    signal.throwIfAborted();
    const candidateLimitReached = lists.some(list => list.length >= 80);
    const hits = fuseHits(lists.map(list => list.filter(hit => eligible.has(hit.contentHash))), limit + 1);
    return { coverage, candidateLimitReached, items: hits.map(hit => {
      const book = eligible.get(hit.contentHash)!;
      return { bookId: book.bookId, contentHash: hit.contentHash, title: book.title, creator: book.creator,
        chapterId: hit.chapterPath, chapterTitle: hit.chapterTitle, spineIndex: hit.spineIndex,
        chunkId: hit.chunkId, corpusVersion, originalText: hit.originalText, anchor: hit.textAnchor };
    }) };
  } };
}
