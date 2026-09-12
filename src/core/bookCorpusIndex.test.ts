import { describe, expect, it } from "vitest";
import type { Book } from "./types";
import { iterateBookChunkBatches } from "./bookCorpusIndex";

function fakeBook(): Book {
  return {
    version: 3,
    opfPath: "content.opf",
    metadata: { title: "测试书", creator: "作者" },
    resources: new Map(),
    spine: [
      { idref: "one", linear: true },
      { idref: "skip", linear: false },
      { idref: "two", linear: true },
    ],
    manifest: new Map([
      ["one", { id: "one", href: "Text/one.xhtml", mediaType: "application/xhtml+xml" }],
      ["skip", { id: "skip", href: "Text/skip.xhtml", mediaType: "application/xhtml+xml" }],
      ["two", { id: "two", href: "Text/two.xhtml", mediaType: "application/xhtml+xml" }],
    ]),
    toc: [{ label: "第一章", href: "Text/one.xhtml", children: [] }],
    fixedLayout: false,
  } as unknown as Book;
}

describe("book corpus index producer", () => {
  it("streams only linear chapters with stable titles and anchors", async () => {
    const reads: string[] = [];
    const batches = [];
    for await (const batch of iterateBookChunkBatches(fakeBook(), {
      bookFingerprint: "a".repeat(64),
      textFor: (path) => {
        reads.push(path);
        return path.endsWith("one.xhtml")
          ? "<html><body><h1>标题</h1><p>第一段正文。</p></body></html>"
          : "<html><body><p>第二段正文。</p></body></html>";
      },
    })) batches.push(batch);
    expect(reads).toEqual(["Text/one.xhtml", "Text/two.xhtml"]);
    expect(batches.map((batch) => batch.chapterTitle)).toEqual(["第一章", "two"]);
    expect(batches[0].chunks[0].bookFingerprint).toBe("a".repeat(64));
    expect(batches[0].chunks[0].textAnchor.snippet).toContain("标题");
  });

  it("aborts before reading another chapter", async () => {
    const controller = new AbortController();
    const iterator = iterateBookChunkBatches(fakeBook(), {
      bookFingerprint: "b".repeat(64),
      signal: controller.signal,
      textFor: () => "<html><body><p>正文</p></body></html>",
    });
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails the book instead of silently committing a missing chapter", async () => {
    const iterator = iterateBookChunkBatches(fakeBook(), {
      bookFingerprint: "c".repeat(64),
      textFor: () => undefined,
    });
    await expect(iterator.next()).rejects.toThrow("无法读取待索引章节");
  });

  it("keeps image-only chapters as empty batches without emitting invalid chunks", async () => {
    const batches = [];
    for await (const batch of iterateBookChunkBatches(fakeBook(), {
      bookFingerprint: "d".repeat(64),
      textFor: (path) => path.endsWith("one.xhtml")
        ? "<html><body>\n<div><svg><image href='cover.jpg'/></svg></div>\n</body></html>"
        : "<html><body><p>后续正文</p></body></html>",
    })) batches.push(batch);
    expect(batches[0].chunks).toEqual([]);
    expect(batches[1].chunks).toHaveLength(1);
  });
});
