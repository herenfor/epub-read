import { describe, expect, it } from "vitest";
import { createCorpusChapter, type CorpusBlock } from "./corpus";
import { CORPUS_CHUNKER_VERSION, EMBEDDING_CHUNKER_VERSION, chunkCorpus, embeddingChunkProfile } from "./chunking";

function block(contentType: CorpusBlock["contentType"], text: string): CorpusBlock {
  return {
    contentType,
    originalText: text,
    normalizedText: "",
    originalRange: { start: 0, end: text.length },
    textAnchor: { start: 0, end: Array.from(text).length, snippet: text },
  };
}

describe("deterministic corpus chunking", () => {
  it("respects structural blocks, exposes anchors and is deterministic", () => {
    const chapter = createCorpusChapter(
      { bookFingerprint: "fp-1", chapterPath: "text/ch1.xhtml", chapterTitle: "第一章", spineIndex: 0 },
      [block("heading", "第一章"), block("paragraph", "这是第一段。这里还有第二句。"), block("paragraph", "这是第二段。")],
    );
    const options = { bookFingerprint: "fp-1", maxCodePoints: 12, overlapCodePoints: 2 };
    const first = chunkCorpus(chapter, options);
    const second = chunkCorpus(chapter, options);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((chunk) => chunk.chunkId.startsWith("chunk_"))).toBe(true);
    expect(first[0]).toMatchObject({ chapterPath: "text/ch1.xhtml", chapterTitle: "第一章", spineIndex: 0 });
    expect(first.some((chunk) => chunk.contentType === "mixed")).toBe(true);
    expect(first.every((chunk) => chunk.textAnchor.end > chunk.textAnchor.start)).toBe(true);
  });

  it("changes identity when the fingerprint or chunker version changes", () => {
    const chapter = createCorpusChapter(
      { bookFingerprint: "fp-1", chapterPath: "ch.xhtml", chapterTitle: "章", spineIndex: 1 },
      [block("paragraph", "一段足够短的正文。")],
    );
    const base = chunkCorpus(chapter, { bookFingerprint: "fp-1" });
    const changedBook = chunkCorpus(chapter, { bookFingerprint: "fp-2" });
    const changedVersion = chunkCorpus(chapter, { bookFingerprint: "fp-1", chunkerVersion: "test-v2" });
    expect(base[0].chunkId).not.toBe(changedBook[0].chunkId);
    expect(base[0].chunkId).not.toBe(changedVersion[0].chunkId);
    expect(base[0].chunkerVersion).toBe(CORPUS_CHUNKER_VERSION);
  });

  it("maps long surrogate-pair blocks back to UTF-16 source offsets", () => {
    const text = "😀".repeat(140) + "。尾";
    const chapter = createCorpusChapter(
      { bookFingerprint: "fp-long", chapterPath: "long.xhtml", chapterTitle: "长", spineIndex: 0 },
      [block("paragraph", text)],
    );
    const chunks = chunkCorpus(chapter, { bookFingerprint: "fp-long", maxCodePoints: 31, overlapCodePoints: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.textAnchor.end > chunk.textAnchor.start)).toBe(true);
    expect(chunks[0].textAnchor.start).toBe(0);
    expect(chunks.at(-1)?.textAnchor.end).toBe(Array.from(text).length);
    expect(chunks.every((chunk) => chunk.originalText.length <= 62)).toBe(true);
  });
});

describe("embedding-bound chunk profile", () => {
  it("keeps every passage inside the model token budget for Chinese text", () => {
    // A long Chinese paragraph like a converted novel chapter: one code point is
    // roughly one token, so the lexical 1200-code-point default would be refused
    // by a 512-token model and fail the whole book.
    const paragraph = "这是一段用于测量分块长度的中文正文内容，句子长度接近真实网文段落。".repeat(40);
    const chapter = createCorpusChapter(
      { bookFingerprint: "fp-zh", chapterPath: "zh.xhtml", chapterTitle: "第一章", spineIndex: 0 },
      [block("paragraph", paragraph), block("paragraph", paragraph)],
    );
    const profile = embeddingChunkProfile(512);
    const chunks = chunkCorpus(chapter, { bookFingerprint: "fp-zh", ...profile });
    const longest = Math.max(...chunks.map((chunk) => Array.from(chunk.normalizedText).length));
    expect(chunks.length).toBeGreaterThan(1);
    expect(longest).toBeLessThanOrEqual(profile.maxCodePoints);
    expect(longest).toBeLessThanOrEqual(512);
    expect(chunks.every((chunk) => chunk.chunkerVersion === EMBEDDING_CHUNKER_VERSION)).toBe(true);
    expect(EMBEDDING_CHUNKER_VERSION).not.toBe(CORPUS_CHUNKER_VERSION);
  });

  it("stays inside a small budget and never asks for an empty overlap", () => {
    expect(embeddingChunkProfile(512)).toMatchObject({ maxCodePoints: 400, overlapCodePoints: 64 });
    const tiny = embeddingChunkProfile(64);
    expect(tiny.maxCodePoints).toBe(64);
    expect(tiny.overlapCodePoints).toBeGreaterThanOrEqual(1);
    expect(tiny.overlapCodePoints).toBeLessThan(tiny.maxCodePoints);
  });
});
