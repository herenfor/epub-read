import { expect, it } from "vitest";
import { createReaderToolService } from "./service";
import { createIndexedSearchBackend } from "./indexedSearch";
import { CORPUS_PARSER_VERSION, CORPUS_NORMALIZER_VERSION } from "../../../core/corpus";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import type { ReaderPassage, ReaderToolBackend } from "./contracts";
import type { IndexedBookStatus, ResolvedCrossBookSearchHit } from "../indexing/indexStore";

it("searches only granted current indexes, reports uncovered books and returns previews that expand to the same source", async () => {
  const books = ["allowed", "missing", "old", "offline", "forbidden"].map(bookId => ({ bookId, contentHash: bookId,
    title: bookId, creator: "author", available: bookId !== "offline", favorite: false, folderId: null }));
  const status = (contentHash: string): IndexedBookStatus => ({ contentHash, parserVersion: CORPUS_PARSER_VERSION,
    normalizerVersion: CORPUS_NORMALIZER_VERSION, chunkerVersion: CORPUS_CHUNKER_VERSION, chunkCount: 1, updatedAt: 1 });
  const hit = (contentHash: string): ResolvedCrossBookSearchHit => ({ contentHash, title: "index title", creator: "author",
    chapterPath: "c.xhtml", chapterTitle: "chapter", spineIndex: 0, chunkId: `chunk-${contentHash}`, contentType: "body",
    originalText: "前文".repeat(300) + "目标原文🙂" + "后文".repeat(300), normalizedText: "目标原文",
    textAnchor: { start: 0, end: 1206, snippet: "目标原文" } });
  let dispatched: unknown;
  let queriesDispatched: unknown;
  let sourceReads = 0;
  const indexed = createIndexedSearchBackend({
    list: async () => [status("allowed"), status("offline"), status("forbidden"), { ...status("old"), parserVersion: "old" }],
    search: async (queries, scopes) => { queriesDispatched = queries; dispatched = scopes; return [[hit("forbidden"), hit("allowed")], [hit("allowed")]]; },
  });
  const backend: ReaderToolBackend = { list: async () => books, chapters: async () => [],
    read: async () => { sourceReads++; return []; }, search: async () => { throw new Error("Must not scan EPUBs"); }, ...indexed };
  const service = createReaderToolService(backend, { clientId: "agent", bookIds: ["allowed", "missing", "old", "offline"], prepareIndex: false });
  const call = (args: Record<string, unknown>) => service.call({ requestId: "scope", name: "reader_search_library", arguments: args }, new AbortController().signal);
  const result = await call({ queries: ["目标原文", "  目标原文  "] });
  expect(dispatched).toEqual([{ hash: "allowed", maxSpineIndex: null }]);
  expect(queriesDispatched).toEqual(["目标原文"]);
  expect(result).toMatchObject({ ok: true, data: { coverage: { scopeBooks: 4, indexedBooks: 1,
    missingIndexBooks: 1, outdatedIndexBooks: 1, unavailableBooks: 1, complete: false }, items: [{ bookId: "allowed",
      title: "allowed", chunkId: "chunk-allowed", chapterId: "c.xhtml", excerptTruncated: true, anchor: hit("allowed").textAnchor }] } });
  const preview = (result as { data: { items: Array<{ excerpt: string; originalText?: string }> } }).data.items[0];
  expect(preview.excerpt).toContain("目标原文🙂");
  expect(hit("allowed").originalText).toContain(preview.excerpt);
  expect(preview).not.toHaveProperty("originalText");
  expect(sourceReads).toBe(0);
  expect(await call({ queries: ["目标原文"], bookIds: ["forbidden"] })).toMatchObject({ ok: false, error: { code: "BOOK_NOT_FOUND" } });
  const empty = await call({ queries: ["目标原文"], bookIds: [] });
  expect(empty).toMatchObject({ ok: true, data: { items: [], coverage: { scopeBooks: 0, indexedBooks: 0, complete: true } } });
  const unindexed = await call({ queries: ["目标原文"], bookIds: ["missing"] });
  expect(unindexed).toMatchObject({ ok: true, data: { items: [], coverage: { scopeBooks: 1, missingIndexBooks: 1, complete: false } } });
  expect(createReaderToolService({ ...backend, searchLibrary: undefined }).definitions.some(tool => tool.name === "reader_search_library")).toBe(false);
});

it("fits complete UTF-8 replies without skipping cursor positions or silently shortening original text", async () => {
  const chunks: ReaderPassage[] = Array.from({ length: 4 }, (_, index) => ({ bookId: "book", contentHash: "hash",
    chapterId: "c.xhtml", spineIndex: 0, chunkId: `chunk-${index}`, corpusVersion: "v1", originalText: "正文🙂\n".repeat(70),
    anchor: { start: index * 300, end: (index + 1) * 300, snippet: "正文" } }));
  const backend: ReaderToolBackend = { list: async () => [{ bookId: "book", title: "title", creator: "", available: true, favorite: false, folderId: null }],
    chapters: async () => [], read: async () => chunks, search: async () => ({ items: [], scannedChapters: 1, truncated: false }) };
  const service = createReaderToolService(backend);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await service.call({ requestId: "bytes", name: "reader_read_passages", maxResponseBytes: 2048,
      arguments: { bookId: "book", chapterId: "c.xhtml", limit: 4, ...(cursor ? { cursor } : {}) } }, new AbortController().signal);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(2048);
    expect(result.ok).toBe(true);
    const page = (result as { data: { items: ReaderPassage[]; nextCursor: string | null; offset: number; wholeChapter: boolean } }).data;
    expect(page.offset).toBe(seen.length);
    expect(page.wholeChapter).toBe(false);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0].originalText).toBe(chunks[0].originalText);
    seen.push(...page.items.map(item => item.chunkId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(chunks.map(chunk => chunk.chunkId));
  const tooSmall = await service.call({ requestId: "small", name: "reader_read_passages", maxResponseBytes: 1024,
    arguments: { bookId: "book", chapterId: "c.xhtml" } }, new AbortController().signal);
  expect(tooSmall).toMatchObject({ ok: false, error: { code: "RESPONSE_BUDGET_EXCEEDED" } });
  const error = await service.call({ requestId: "\u0000".repeat(128), name: "unknown", maxResponseBytes: 1024,
    arguments: {} }, new AbortController().signal);
  expect(new TextEncoder().encode(JSON.stringify(error)).byteLength).toBeLessThanOrEqual(1024);
});
