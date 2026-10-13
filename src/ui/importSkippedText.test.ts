import { describe, expect, it } from "vitest";
import { importSkippedList, importSkippedNotice } from "./importSkippedText";

const hash = (char: string) => char.repeat(64);

describe("import skipped text", () => {
  it("is empty when nothing was skipped", () => {
    expect(importSkippedNotice(0, [])).toBe("");
  });

  it("names each book with its localized reason and keeps the failure detail", () => {
    const text = importSkippedNotice(2, [
      { contentHash: hash("a"), title: "甲", reason: "not-local" },
      { contentHash: hash("b"), title: "", reason: "attachment-import-failed", message: "磁盘已满" },
    ]);
    expect(text).toContain("2");
    expect(text).toContain("《甲》（本机没有这本书）");
    expect(text).toContain("《bbbbbbbb》（附带的书籍文件导入失败：磁盘已满）");
  });

  it("shows three books and the backend total when the list is longer", () => {
    const books = ["a", "b", "c", "d"].map((char) => ({ contentHash: hash(char), title: char, reason: "not-local" }));
    const list = importSkippedList(books, 5);
    expect(list).toContain("《c》");
    expect(list).not.toContain("《d》");
    expect(list).toContain("5");
  });
});
