import { expect, it } from "vitest";
import { createReaderToolService } from "./service";
import type { ReaderPassage, ReaderToolBackend } from "./contracts";

it("keeps original identities across pages, rejects a cursor from another query and never mutates caller arguments", async () => {
  const chunks: ReaderPassage[] = Array.from({ length: 3 }, (_, index) => ({ bookId: "book", contentHash: "source",
    chapterId: "章节.xhtml", spineIndex: 0, chunkId: `chunk-${index}`, corpusVersion: "v1",
    originalText: `原文段落${index}`, anchor: { start: index * 5, end: index * 5 + 5, snippet: "原文段落" } }));
  const backend: ReaderToolBackend = {
    list: async () => [{ bookId: "book", title: "测试书", creator: "", available: true, favorite: false, folderId: null }],
    chapters: async () => [{ chapterId: "章节.xhtml", title: "第一章", spineIndex: 0 }],
    read: async () => chunks, search: async () => ({ items: chunks, truncated: false, scannedChapters: 1 }),
  };
  const service = createReaderToolService(backend);
  const call = (name: string, args: Record<string, unknown>) => service.call({ requestId: "fixture", name, arguments: args }, new AbortController().signal);
  const first = await call("reader_read_passages", { bookId: "book", chapterId: "章节.xhtml", limit: 1 });
  expect(first.ok).toBe(true);
  const page = (first as { data: { items: ReaderPassage[]; nextCursor: string } }).data;
  const next = await call("reader_read_passages", { bookId: "book", chapterId: "章节.xhtml", cursor: page.nextCursor, limit: 1 });
  expect(next).toMatchObject({ ok: true, data: { items: [chunks[1]], wholeChapter: false } });
  expect(page.items[0]).toEqual(chunks[0]);
  const other = await call("reader_read_passages", { bookId: "book", chapterId: "另一章.xhtml", cursor: page.nextCursor });
  expect(other).toMatchObject({ ok: false, error: { code: "CURSOR_EXPIRED" } });
  const args = { bookId: "book", chapterId: "章节.xhtml", aroundChunkId: "chunk-2" };
  await call("reader_read_passages", args);
  expect(args).not.toHaveProperty("cursor");
  expect(service.definitions.some(tool => tool.name.includes("memory") || tool.name.includes("conversation"))).toBe(false);
});

it("keeps library and index results inside the host grant and requires separate preparation permission", async () => {
  const backend: ReaderToolBackend = {
    list: async () => ["allowed", "hidden"].map(bookId => ({ bookId, title: bookId, creator: "", available: true, favorite: false, folderId: null })),
    chapters: async () => [], read: async () => [], search: async () => ({ items: [], truncated: false, scannedChapters: 0 }),
    indexStatus: async books => books.map(book => ({ bookId: book.bookId, state: "missing", chunkCount: 0 })),
    prepareIndex: async bookId => ({ bookId, taskId: "task", state: "running", progress: 0, reused: false }),
  };
  const service = createReaderToolService(backend, { clientId: "fixture", bookIds: ["allowed"], prepareIndex: false });
  const call = (name: string, args = {}) => service.call({ requestId: "grant", name, arguments: args }, new AbortController().signal);
  expect(await call("reader_find_books")).toMatchObject({ ok: true, data: { items: [{ bookId: "allowed" }] } });
  expect(await call("reader_get_index_status")).toMatchObject({ ok: true, data: { items: [{ bookId: "allowed", state: "missing" }] } });
  expect(await call("reader_get_book", { bookId: "hidden" })).toMatchObject({ ok: false, error: { code: "BOOK_NOT_FOUND" } });
  expect(await call("reader_prepare_index", { bookId: "allowed" })).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED" } });
  const empty = createReaderToolService(backend, { clientId: "none", bookIds: [], prepareIndex: false });
  expect(await empty.call({ requestId: "none", name: "reader_find_books", arguments: {} }, new AbortController().signal))
    .toMatchObject({ ok: true, data: { items: [] } });
});
