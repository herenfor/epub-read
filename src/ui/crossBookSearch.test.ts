import { describe, expect, it } from "vitest";
import { presentCrossBookHit } from "./crossBookSearch";

describe("cross-book search presentation", () => {
  it("maps a normalized match back to original highlight and an exact text anchor", () => {
    const result = presentCrossBookHit({
      contentHash: "a".repeat(64),
      title: "测试书",
      creator: "作者",
      chunkId: "chunk-1",
      spineIndex: 2,
      chapterPath: "Text/chapter.xhtml",
      chapterTitle: "第一章",
      contentType: "paragraph",
      originalText: "前文　ＡＢＣ 测试　后文",
      normalizedText: "前文 abc 测试 后文",
      textAnchor: { start: 100, end: 112, snippet: "前文ABC测试后文" },
    }, "abc 测试");
    expect(result.snippet.slice(result.matchRanges![0].start, result.matchRanges![0].end)).toBe("ＡＢＣ 测试");
    expect(result.hit.textAnchor.start).toBe(102);
    expect(result.hit.textAnchor.snippet).toBe("ＡＢＣ测试后文");
  });

  it("retains an unavailable reason without losing the source hit", () => {
    const result = presentCrossBookHit({
      contentHash: "b".repeat(64), title: "书", creator: "", chunkId: "c", spineIndex: 0,
      chapterPath: "c.xhtml", contentType: "body", originalText: "正文", normalizedText: "正文",
      textAnchor: { start: 0, end: 2, snippet: "正文" },
    }, "正文", "源文件不可用");
    expect(result.disabledReason).toBe("源文件不可用");
    expect(result.hit.contentHash).toBe("b".repeat(64));
  });
});
