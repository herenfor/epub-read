import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { DocumentChunk } from "../../../core/chunking";
import { clearAllTextIndexes, listIndexedBooks, makeNativeIndexInput, replaceBookTextIndex, searchBookTextIndex } from "./indexStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const hash = "a".repeat(64);

function chunk(overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    bookFingerprint: hash,
    chunkId: "chunk-1",
    chapterPath: "Text/chapter.xhtml",
    chapterTitle: "第一章",
    spineIndex: 0,
    contentType: "paragraph",
    originalText: "测试正文",
    normalizedText: "测试正文",
    textAnchor: { start: 3, end: 7, snippet: "测试正文" },
    parserVersion: "parser-v1",
    normalizerVersion: "normalizer-v1",
    chunkerVersion: "chunker-v1",
    unitStart: 0,
    unitEnd: 1,
    ...overrides,
  };
}

describe("cross-book FTS bridge", () => {
  beforeEach(() => invokeMock.mockReset());

  it("maps stable chunks into one versioned native transaction", async () => {
    invokeMock.mockResolvedValue(1);
    const metadata = { contentHash: hash, title: "测试书", creator: "作者", language: "zh-CN" };
    const input = makeNativeIndexInput(metadata, [chunk()]);
    expect(input.parserVersion).toBe("parser-v1");
    expect(input.chunks[0].anchorJson).toBe('{"start":3,"end":7,"snippet":"测试正文"}');
    await expect(replaceBookTextIndex(metadata, [chunk()])).resolves.toBe(1);
    expect(invokeMock).toHaveBeenCalledWith("ai_index_replace", { input });
  });

  it("omits an empty legacy language instead of sending invalid native input", () => {
    const input = makeNativeIndexInput({
      contentHash: hash,
      title: "测试书",
      creator: "作者",
      language: "　 ",
    }, [chunk()]);
    expect(input).not.toHaveProperty("language");
  });

  it("rejects mixed fingerprints or versions before native writes", () => {
    const metadata = { contentHash: hash, title: "测试书", creator: "作者" };
    expect(() => makeNativeIndexInput(metadata, [])).toThrow("没有正文块");
    expect(() => makeNativeIndexInput(metadata, [chunk({ bookFingerprint: "b".repeat(64) })])).toThrow("内容指纹");
    expect(() => makeNativeIndexInput(metadata, [chunk(), chunk({ parserVersion: "parser-v2" })])).toThrow("parserVersion");
  });

  it("parses persisted anchors on search results", async () => {
    invokeMock.mockResolvedValue([{
      contentHash: hash,
      title: "测试书",
      creator: "作者",
      chunkId: "chunk-1",
      spineIndex: 0,
      chapterPath: "Text/chapter.xhtml",
      chapterTitle: "第一章",
      contentType: "paragraph",
      originalText: "测试正文",
      normalizedText: "测试正文",
      anchorJson: '{"start":3,"end":7,"snippet":"测试正文"}',
    }]);
    const hits = await searchBookTextIndex({ query: "　测 试正文　" });
    expect(hits[0].textAnchor).toEqual({ start: 3, end: 7, snippet: "测试正文" });
    expect(invokeMock).toHaveBeenCalledWith("ai_search", { input: { query: "测 试正文" } });
  });

  it("rejects corrupted native anchors and exposes indexed book status", async () => {
    invokeMock.mockResolvedValueOnce([{
      contentHash: hash, title: "书", creator: "", chunkId: "c", spineIndex: 0,
      chapterPath: "c.xhtml", contentType: "body", originalText: "正文", normalizedText: "正文",
      anchorJson: '{"start":-1,"end":2,"snippet":"正文"}',
    }]);
    await expect(searchBookTextIndex({ query: "正文" })).rejects.toThrow("锚点范围");
    invokeMock.mockResolvedValueOnce([{ contentHash: hash, parserVersion: "p", normalizerVersion: "n", chunkerVersion: "c", chunkCount: 2, updatedAt: 1 }]);
    await expect(listIndexedBooks()).resolves.toHaveLength(1);
    expect(invokeMock).toHaveBeenLastCalledWith("ai_index_status");
  });

  it("clears only the text-index boundary", async () => {
    invokeMock.mockResolvedValue(undefined);
    await clearAllTextIndexes();
    expect(invokeMock).toHaveBeenCalledWith("ai_index_clear_all");
  });
});
