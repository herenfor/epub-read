import { describe, expect, it } from "vitest";
import {
  normalizeReaderNotes,
  validateReaderNote,
  type ReaderNote,
} from "./notes";

const note = (overrides: Partial<ReaderNote> = {}): ReaderNote => ({
  id: "note-1",
  spineIndex: 2,
  chapterPath: "Text/chapter.xhtml",
  startTextOffset: 10,
  endTextOffset: 14,
  startTextSnippet: "开始文字",
  endTextSnippet: "结束文字",
  selectedText: "开始 文字",
  content: "这里值得回看",
  createdAtMs: 100,
  updatedAtMs: 100,
  ...overrides,
});

describe("ReaderNote validation", () => {
  it("accepts whitespace in display text while matching normalized range length", () => {
    expect(validateReaderNote(note())).toEqual({ valid: true });
    expect(normalizeReaderNotes([note(), { ...note(), id: "bad", endTextOffset: 10 }])).toEqual([note()]);
  });

  it("rejects unsafe offsets and snippets while allowing wall-clock rollback", () => {
    expect(validateReaderNote(note({ startTextOffset: 7, endTextOffset: 6 })).valid).toBe(false);
    expect(validateReaderNote(note({ endTextSnippet: "有 空格" })).valid).toBe(false);
    expect(validateReaderNote(note({ selectedText: "x" })).valid).toBe(false);
    expect(validateReaderNote(note({ content: "x".repeat(10001) })).valid).toBe(false);
    expect(validateReaderNote(note({ createdAtMs: 3, updatedAtMs: 2 }))).toEqual({ valid: true });
  });
});
