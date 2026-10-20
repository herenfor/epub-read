import { invoke } from "@tauri-apps/api/core";
import type { Book } from "../../../core/types";
import { spineItemPath } from "../../../core/book";
import { readBookResourceText } from "../../../core/bookCorpusIndex";
import { extractCorpusChapter, normalizeCorpusText, CORPUS_PARSER_VERSION, CORPUS_NORMALIZER_VERSION } from "../../../core/corpus";
import { chunkCorpus, CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { listIndexedBooks, parseTextAnchor, type CrossBookSearchHit, type ResolvedCrossBookSearchHit } from "../indexing/indexStore";
import type { ChatSettings, Evidence, ReadingContext } from "./types";

export interface LibraryBook {
  hash: string;
  title: string;
  creator: string;
  spineIndex: number;
}
export interface ReadingLibrary {
  context: ReadingContext;
  books: readonly LibraryBook[];
  search(queries: string[], bookHash: string | undefined, signal: AbortSignal): Promise<ResolvedCrossBookSearchHit[]>;
  read(bookHash: string, chapterPath: string, offset: number, signal: AbortSignal, aroundChunkId?: string): Promise<ChapterPage>;
  chapters(): Array<{ chapterPath: string; spineIndex: number; title: string }>;
}
export interface ChapterPage { hits: ResolvedCrossBookSearchHit[]; offset: number; nextOffset: number | null }

export function chapterPage(chunks: ResolvedCrossBookSearchHit[], offset: number, aroundChunkId?: string): ChapterPage {
  if (aroundChunkId) {
    const index = chunks.findIndex(chunk => chunk.chunkId === aroundChunkId);
    if (index < 0) throw new Error("命中段落已失效，请重新检索");
    offset = Math.max(0, index - 2);
  }
  const hits = chunks.slice(offset, offset + 8);
  return { hits, offset, nextOffset: offset + hits.length < chunks.length ? offset + hits.length : null };
}

/** Fuse query-specific rankings rather than treating an entire question as a literal phrase. */
export function fuseHits(lists: readonly (readonly ResolvedCrossBookSearchHit[])[], limit = 12): ResolvedCrossBookSearchHit[] {
  const scored = new Map<string, { hit: ResolvedCrossBookSearchHit; score: number }>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((hit, rank) => {
      const key = `${hit.contentHash}:${hit.chunkId}`;
      if (seen.has(key)) return;
      seen.add(key);
      const entry = scored.get(key) ?? { hit, score: 0 };
      entry.score += 1 / (60 + rank + 1);
      scored.set(key, entry);
    });
  }
  const result: ResolvedCrossBookSearchHit[] = [];
  for (const { hit } of [...scored.values()].sort((a, b) => b.score - a.score)) {
    if (result.some(other => other.contentHash === hit.contentHash && other.chapterPath === hit.chapterPath
      && Math.max(other.textAnchor.start, hit.textAnchor.start) < Math.min(other.textAnchor.end, hit.textAnchor.end)
      && Math.min(other.textAnchor.end, hit.textAnchor.end) - Math.max(other.textAnchor.start, hit.textAnchor.start)
        > 0.8 * Math.min(other.textAnchor.end - other.textAnchor.start, hit.textAnchor.end - hit.textAnchor.start))) continue;
    result.push(hit);
    if (result.length >= limit) break;
  }
  return result;
}

export function evidenceFor(hit: ResolvedCrossBookSearchHit, id: string): Evidence {
  return {
    id, bookHash: hit.contentHash, bookTitle: hit.title, chapterPath: hit.chapterPath,
    chapterTitle: hit.chapterTitle || hit.chapterPath, spineIndex: hit.spineIndex, text: hit.originalText, hit,
    citation: { spineIndex: hit.spineIndex, chapterPath: hit.chapterPath, chapterTitle: hit.chapterTitle || hit.chapterPath,
      snippet: hit.originalText, snippetMatchRanges: [], originalRange: { start: 0, end: hit.originalText.length },
      textOffset: hit.textAnchor.start, textSnippet: hit.textAnchor.snippet, matchedText: hit.originalText, matchType: "phrase" },
  };
}

export function createReadingLibrary(book: Book, context: ReadingContext, shelf: readonly LibraryBook[], settings: ChatSettings): ReadingLibrary {
  const native = getAppBuildSession()?.source === "desktop";
  const books = [...shelf.filter(entry => entry.hash !== context.bookHash),
    { hash: context.bookHash, title: context.title, creator: context.creator, spineIndex: context.spineIndex }];
  const paths = book.spine.map((_, index) => spineItemPath(book, index));
  const titles = new Map<string, string>();
  const visit = (nodes: Book["toc"]) => { for (const node of nodes) { titles.set(node.href.split("#")[0], node.label); visit(node.children); } };
  visit(book.toc);
  const cache = new Map<string, ResolvedCrossBookSearchHit[]>();
  let indexed: Set<string> | undefined;
  const permitted = (hit: ResolvedCrossBookSearchHit) => {
    const entry = books.find(candidate => candidate.hash === hit.contentHash);
    return Boolean(entry && (settings.scope === "library" || hit.contentHash === context.bookHash)
      && (settings.allowLaterChapters || hit.spineIndex <= entry.spineIndex));
  };
  const resolveHits = (hits: CrossBookSearchHit[]) => hits.map(({ anchorJson, ...hit }) => ({ ...hit, textAnchor: parseTextAnchor(anchorJson) }));
  async function currentChapter(path: string, signal: AbortSignal): Promise<ResolvedCrossBookSearchHit[]> {
    signal.throwIfAborted();
    const cached = cache.get(path);
    if (cached) return cached;
    const spineIndex = paths.indexOf(path);
    if (spineIndex < 0 || (!settings.allowLaterChapters && spineIndex > context.spineIndex)) return [];
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
  }
  return {
    context, books,
    chapters: () => paths.flatMap((path, spineIndex) => path && (settings.allowLaterChapters || spineIndex <= context.spineIndex)
      ? [{ chapterPath: path, spineIndex, title: titles.get(path) || path }] : []),
    async search(inputQueries, bookHash, signal) {
      const queries = [...new Set(inputQueries.map(query => normalizeCorpusText(query.trim())).filter(Boolean))].slice(0, 6);
      if (!queries.length) return [];
      if (bookHash && !books.some(entry => entry.hash === bookHash)) throw new Error("书库中没有这个书籍身份");
      if (settings.scope === "book" && bookHash && bookHash !== context.bookHash) throw new Error("当前只允许查询正在阅读的书");
      const target = settings.scope === "book" ? context.bookHash : bookHash;
      if (native) {
        indexed ??= new Set((await listIndexedBooks()).filter(status => status.parserVersion === CORPUS_PARSER_VERSION
          && status.normalizerVersion === CORPUS_NORMALIZER_VERSION && status.chunkerVersion === CORPUS_CHUNKER_VERSION)
          .map(status => status.contentHash));
        signal.throwIfAborted();
        if (settings.scope === "library" || indexed.has(context.bookHash)) {
          const lists = await Promise.all(queries.map(async query => {
            signal.throwIfAborted();
            const hits = await invoke<CrossBookSearchHit[]>("ai_chat_search", { input: {
              query, limit: 80, contentHash: target, parserVersion: CORPUS_PARSER_VERSION,
              normalizerVersion: CORPUS_NORMALIZER_VERSION, chunkerVersion: CORPUS_CHUNKER_VERSION,
            } });
            signal.throwIfAborted();
            return resolveHits(hits).filter(hit => indexed!.has(hit.contentHash) && permitted(hit));
          }));
          return fuseHits(lists);
        }
      }
      if (settings.scope === "library") throw new Error("全书库查证需要 Windows 桌面版，并先在书架的正文搜索中建立索引");
      const lists = queries.map(() => [] as ResolvedCrossBookSearchHit[]);
      for (const path of paths) {
        if (!path) continue;
        const hits = await currentChapter(path, signal);
        hits.forEach(hit => queries.forEach((query, i) => { if (hit.normalizedText.includes(query)) lists[i].push(hit); }));
        // Yield between chapters; no render resources or pagination are created.
        await new Promise(resolve => setTimeout(resolve, 0));
        signal.throwIfAborted();
      }
      return fuseHits(lists);
    },
    async read(bookHash, chapterPath, offset, signal, aroundChunkId) {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("原文块起点无效");
      if (bookHash === context.bookHash) return chapterPage(await currentChapter(chapterPath, signal), offset, aroundChunkId);
      if (!native || settings.scope !== "library" || !books.some(entry => entry.hash === bookHash)) {
        throw new Error("当前范围不能读取这本书");
      }
      const page = await invoke<{ hits: CrossBookSearchHit[]; offset: number; nextOffset: number | null }>("ai_chat_read_chapter", { input: { contentHash: bookHash, chapterPath, offset, aroundChunkId,
        parserVersion: CORPUS_PARSER_VERSION, normalizerVersion: CORPUS_NORMALIZER_VERSION, chunkerVersion: CORPUS_CHUNKER_VERSION } });
      signal.throwIfAborted();
      return { ...page, hits: resolveHits(page.hits).filter(permitted) };
    },
  };
}
