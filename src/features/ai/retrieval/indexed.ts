import { invoke } from "@tauri-apps/api/core";
import { CORPUS_PARSER_VERSION, CORPUS_NORMALIZER_VERSION } from "../../../core/corpus";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { listIndexedBooks, parseTextAnchor, type CrossBookSearchHit } from "../indexing/indexStore";
export interface IndexedScope { hash: string; maxSpineIndex: number | null }
export interface IndexedChapterPage { hits: ResolvedCrossBookSearchHit[]; offset: number; nextOffset: number | null }
import type { ResolvedCrossBookSearchHit } from "../indexing/indexStore";

const versions = { parserVersion: CORPUS_PARSER_VERSION, normalizerVersion: CORPUS_NORMALIZER_VERSION, chunkerVersion: CORPUS_CHUNKER_VERSION };
const resolveHits = (hits: CrossBookSearchHit[]) => hits.map(({ anchorJson, ...hit }) => ({ ...hit, textAnchor: parseTextAnchor(anchorJson) }));

export function nativeIndexReader() {
  let indexed: Promise<Set<string>> | undefined;
  return {
    indexed() {
      return indexed ??= listIndexedBooks().then(statuses => new Set(statuses.filter(status => status.parserVersion === versions.parserVersion
        && status.normalizerVersion === versions.normalizerVersion && status.chunkerVersion === versions.chunkerVersion).map(status => status.contentHash)));
    },
    async search(queries: string[], scopes: IndexedScope[], signal: AbortSignal) {
      signal.throwIfAborted();
      const lists = await invoke<CrossBookSearchHit[][]>("ai_chat_search", { input: { queries, scopes, ...versions } });
      signal.throwIfAborted();
      return lists.map(resolveHits);
    },
    async read(bookHash: string, chapterPath: string, offset: number, signal: AbortSignal, aroundChunkId?: string): Promise<IndexedChapterPage> {
      const page = await invoke<{ hits: CrossBookSearchHit[]; offset: number; nextOffset: number | null }>("ai_chat_read_chapter",
        { input: { contentHash: bookHash, chapterPath, offset, aroundChunkId, ...versions } });
      signal.throwIfAborted();
      return { ...page, hits: resolveHits(page.hits) };
    },
  };
}
