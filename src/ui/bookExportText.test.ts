import { describe, expect, it } from "vitest";
import type { BookSourceExportError, BookSourceExportResult } from "../platform/bookExportNativeBridge";
import { bookExportErrorNotice, bookExportFileName, bookExportResultNotice, bookExportTargetLabel } from "./bookExportText";

function result(patch: Partial<BookSourceExportResult>): BookSourceExportResult {
  return {
    status: "written", jobId: "j", outputFormat: "zip", requestedBooks: 2, writtenBooks: 2,
    bookBytes: 10, outputBytes: 12, exportedBooks: [], skippedBooks: [], ...patch,
  };
}

function failure(code: string, partialOutputRetained = false, message = "raw"): BookSourceExportError {
  return Object.assign(new Error(message), { code, partialOutputRetained });
}

describe("book export text", () => {
  it("only reports success for written exports without skipped books", () => {
    expect(bookExportResultNotice(result({}), "books.zip")).toEqual({ kind: "ok", text: "已导出 2 本书的原文件（books.zip）" });
    const partial = bookExportResultNotice(result({ writtenBooks: 1, skippedBooks: [{ contentHash: "a".repeat(64), title: "甲", reason: "source-missing" }] }), "books.zip");
    expect(partial.kind).toBe("warn");
    expect(partial.text).toContain("1/2");
    expect(partial.text).toContain("《甲》（源文件找不到了）");
    const none = bookExportResultNotice(result({ status: "no-books", writtenBooks: 0, skippedBooks: [{ contentHash: "b".repeat(64), title: "", reason: "new-code" }] }), "x.zip");
    expect(none).toEqual({ kind: "warn", text: "没有导出任何书，也没有生成文件：《bbbbbbbb》（未导出）" });
    expect(bookExportResultNotice(result({ status: "cancelled" }), "x.zip").kind).toBe("warn");
  });

  it("says when the saved file may be incomplete and localizes known error codes", () => {
    expect(bookExportErrorNotice(failure("insufficient-space", true)).text).toBe("导出书籍失败：存储空间不足。保存的文件可能不完整，请删除后重试");
    expect(bookExportErrorNotice(failure("cancelled", true))).toEqual({ kind: "warn", text: "已取消导出书籍。保存的文件可能不完整，请删除后重试" });
    expect(bookExportErrorNotice(failure("storage-error")).text).toBe("导出书籍失败：raw");
  });

  it("suggests a safe .epub name and labels saved targets", () => {
    expect(bookExportFileName("a:b?.epub", "x")).toBe("a_b_.epub");
    expect(bookExportFileName("book.epub", "原书标题")).toBe("原书标题.epub");
    expect(bookExportFileName("原文件.epub", "别的标题")).toBe("原文件.epub");
    expect(bookExportFileName("", "书名. ")).toBe("书名.epub");
    expect(bookExportFileName("CON.epub", "x")).toBe("book.epub");
    expect(bookExportFileName("COM¹.epub", "x")).toBe("book.epub");
    expect(bookExportFileName("字".repeat(160) + ".epub", "x").length).toBe(85);
    expect(bookExportTargetLabel({ kind: "path", path: "C:\\Users\\me\\books.zip" })).toBe("books.zip");
    expect(bookExportTargetLabel({ kind: "uri", uri: "content://com.android.externalstorage.documents/document/primary%3ADownload%2Fa.epub" })).toBe("a.epub");
    expect(bookExportTargetLabel({ kind: "uri", uri: "content://com.android.providers.downloads.documents/document/314" })).toBe("所选文件");
  });
});
