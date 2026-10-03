import { describe, expect, it } from "vitest";
import type { ChapterState } from "../render/paginator";
import { resolveReaderLoadFeedback } from "./loadingFeedback";

const input = {
  visible: true,
  displayReady: false,
  displayedOnce: false,
  chapter: { status: "loading" } as ChapterState,
};

describe("reader loading feedback projection", () => {
  it("stays hidden outside a mounted reader", () => {
    expect(resolveReaderLoadFeedback({ ...input, visible: false })).toBeNull();
  });

  it("shows opening-position feedback until the existing display-ready boundary", () => {
    expect(resolveReaderLoadFeedback(input)).toEqual({
      kind: "loading",
      text: "准备阅读位置…",
    });
    expect(resolveReaderLoadFeedback({ ...input, displayReady: true, chapter: { status: "ready", pageCount: 1, currentPage: 0, empty: false } })).toBeNull();
  });

  it("labels cross-chapter loading and measurement from chapterState", () => {
    expect(resolveReaderLoadFeedback({
      ...input,
      displayedOnce: true,
      chapter: { status: "loading" },
    })?.text).toBe("正在加载章节…");
    expect(resolveReaderLoadFeedback({
      ...input,
      displayedOnce: true,
      chapter: { status: "measuring" },
    })?.text).toBe("正在准备排版…");
  });

  it("keeps empty ready as a successful terminal without a fake spinner", () => {
    expect(resolveReaderLoadFeedback({
      ...input,
      displayedOnce: true,
      displayReady: true,
      chapter: { status: "ready", pageCount: 1, currentPage: 0, empty: true },
    })).toEqual({ kind: "empty", text: "本章无可显示内容" });
  });

  it("preserves the original error terminal", () => {
    expect(resolveReaderLoadFeedback({
      ...input,
      displayedOnce: true,
      chapter: { status: "error", message: "章节资源缺失：lost.xhtml" },
    })).toEqual({
      kind: "error",
      text: "章节加载失败：章节资源缺失：lost.xhtml",
    });
  });
});
