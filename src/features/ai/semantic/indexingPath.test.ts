import { describe, expect, it } from "vitest";
import type { Book } from "../../../core/types";
import { iterateBookChunkBatches, textForBookResource } from "../../../core/bookCorpusIndex";
import { embeddingChunkProfile } from "../../../core/chunking";
import { runSemanticIndex } from "./indexer";
import { createPreviewSession } from "./previewSession";
import { MemorySemanticStore, policy } from "./testStore";

// End-to-end shape check for the real indexing path: the section's chunk
// iterator (with the model-derived profile) feeding runSemanticIndex.
function fakeBook(paragraphCount: number): Book {
  const paragraphs = Array.from({ length: paragraphCount }, (_, i) =>
    `<p>第${i}段。${"这是一段用于验收的中文正文内容，句子长度接近真实段落。".repeat(4)}</p>`).join("");
  const html = `<html><body><h1>第一章</h1>${paragraphs}</body></html>`;
  return {
    version: 3,
    opfPath: "content.opf",
    metadata: { title: "测试书", identifier: "id", language: "zh-CN" },
    manifest: new Map([["c", { id: "c", href: "c.xhtml", mediaType: "application/xhtml+xml", properties: [] }]]),
    spine: [{ idref: "c", linear: true }],
    guide: [],
    toc: [],
    resources: new Map([["c.xhtml", { path: "c.xhtml", mediaType: "application/xhtml+xml", data: new TextEncoder().encode(html) }]]),
    fixedLayout: false,
    issues: [],
    drmProtected: false,
  } as unknown as Book;
}

async function* chunksOf(book: Book, fingerprint: string, signal: AbortSignal, maxTokens = 512) {
  const chunking = embeddingChunkProfile(maxTokens);
  for await (const batch of iterateBookChunkBatches(book, {
    bookFingerprint: fingerprint,
    signal,
    chunking,
    textFor: (path) => textForBookResource(book, path),
  })) {
    yield batch.chunks;
  }
}

describe("semantic indexing over a real chunk iterator", () => {
  it("publishes a generation that actually contains the book's paragraphs", async () => {
    const book = fakeBook(20);
    const session = createPreviewSession();
    const store = new MemorySemanticStore();
    const fingerprint = "a".repeat(64);
    let observed = 0;

    const result = await runSemanticIndex({
      store,
      session,
      policy: policy(4),
      chunks: (passedSession, signal) => {
        expect(passedSession).toBe(session);
        return chunksOf(book, fingerprint, signal, passedSession.profile.maxTokens);
      },
      onProgress: (progress) => { observed = progress.stagedRows; },
    });

    expect(result.interrupted).toBe(false);
    expect(result.status.totalRows).toBeGreaterThan(0);
    expect(result.status.stagedRows).toBeGreaterThan(0);
    expect(observed).toBeGreaterThan(0);
    expect(result.status.complete).toBe(true);
    expect(result.status.generation).toBe(1);
    expect(result.status.completedRows).toBe(result.status.totalRows);
  });

  it("refuses to publish anything for a book with no readable chapters", async () => {
    const empty = { ...fakeBook(0), spine: [] } as unknown as Book;
    const session = createPreviewSession();
    const store = new MemorySemanticStore();
    await expect(runSemanticIndex({
      store,
      session,
      policy: policy(4),
      chunks: (passedSession, signal) => chunksOf(empty, "b".repeat(64), signal, passedSession.profile.maxTokens),
    })).rejects.toThrow("没有可索引的正文块");
  });
});
