import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Book } from "../core/types";
import { createSearchSession } from "../core/search";
import { createChapterCountJob, type IdleScheduler } from "../ui/chapterCountJob";
import { ResourceServer } from "./resources";

const CHAPTER = "OEBPS/a.xhtml";
const BODY = "<html><body><p>远方的灯塔在夜里亮着。</p></body></html>";

/** One linear chapter whose XHTML is only decompressed on demand. */
function lazyBook(load: () => Promise<Uint8Array | null>): Book {
  const book: Book = {
    version: 3,
    opfPath: "OEBPS/content.opf",
    metadata: { title: "t", identifier: "t", language: "zh" },
    manifest: new Map([["a", { id: "a", href: "a.xhtml", mediaType: "application/xhtml+xml", properties: [] }]]),
    spine: [{ idref: "a", linear: true }],
    guide: [],
    toc: [],
    resources: new Map([[CHAPTER, { path: CHAPTER, data: new Uint8Array(0), mediaType: "application/xhtml+xml", loaded: false }]]),
    fixedLayout: false,
    issues: [],
    drmProtected: false,
  };
  book.ensureResources = async () => {
    const data = await load();
    const res = book.resources.get(CHAPTER)!;
    if (data) {
      res.data = data;
      res.loaded = true;
    }
  };
  return book;
}

function manualScheduler(): IdleScheduler & { flush(): void } {
  const queue: Array<() => void> = [];
  return {
    request(callback) {
      queue.push(callback);
      return queue.length;
    },
    cancel() {},
    flush() {
      const callbacks = queue.splice(0);
      for (const callback of callbacks) callback();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const parse = (text: string) => parseHTML(text).document as unknown as Document;

describe("on-demand chapter text", () => {
  it("first search on a not-yet-loaded chapter hits, and the read holder is released", async () => {
    const book = lazyBook(async () => new TextEncoder().encode(BODY));
    const server = new ResourceServer(book);
    const session = createSearchSession(book, { resourceServer: server, yieldToHost: async () => {} });
    const results = await session.search("灯塔");
    expect(results).toHaveLength(1);
    expect(server.mediaCacheStats.holders).toBe(0);
    session.dispose();
    server.revokeAll();
  });

  it("a failed read fails the query instead of caching an empty chapter", async () => {
    let fail = true;
    const book = lazyBook(async () => (fail ? null : new TextEncoder().encode(BODY)));
    const server = new ResourceServer(book);
    const session = createSearchSession(book, { resourceServer: server, yieldToHost: async () => {} });
    await expect(session.search("灯塔")).rejects.toThrow("章节正文读取失败");
    fail = false;
    expect(await session.search("灯塔")).toHaveLength(1);
    expect(server.mediaCacheStats.holders).toBe(0);
    session.dispose();
    server.revokeAll();
  });

  it("the count job gets a real weight on its first slice", async () => {
    const book = lazyBook(async () => new TextEncoder().encode(BODY));
    const server = new ResourceServer(book);
    const scheduler = manualScheduler();
    const counts: Array<[number, number]> = [];
    const errors: number[] = [];
    createChapterCountJob({
      book, server, generation: 1, scheduler, parse,
      onCount: (index, value) => counts.push([index, value]),
      onError: (index) => errors.push(index),
    });
    scheduler.flush();
    await settle();
    expect(errors).toEqual([]);
    expect(counts).toEqual([[0, Array.from("远方的灯塔在夜里亮着。").length]]);
    expect(server.mediaCacheStats.holders).toBe(0);
    server.revokeAll();
  });

  it("cancel during an in-flight read publishes nothing and releases the holder", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const book = lazyBook(async () => {
      await gate;
      return new TextEncoder().encode(BODY);
    });
    const server = new ResourceServer(book);
    const scheduler = manualScheduler();
    const calls: string[] = [];
    const job = createChapterCountJob({
      book, server, generation: 1, scheduler, parse,
      onCount: () => calls.push("count"),
      onError: () => calls.push("error"),
      onIssue: () => calls.push("issue"),
    });
    scheduler.flush();
    job.cancel();
    release();
    await settle();
    scheduler.flush();
    await settle();
    expect(calls).toEqual([]);
    expect(server.mediaCacheStats.holders).toBe(0);
    server.revokeAll();
  });
});
