import { describe, expect, it } from "vitest";
import { createCorpusChapter, type CorpusBlock } from "./corpus";
import { CORPUS_CHUNKER_VERSION, chunkCorpus } from "./chunking";

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
