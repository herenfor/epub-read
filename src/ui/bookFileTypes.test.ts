import { describe, expect, it } from "vitest";
import { supportedBookName } from "../core/documentFormats";
import { BOOK_FILE_TYPES, bookFileExtension, bookFileMime, bookPickerExtensions, nativeOnlyBookName, webBookAccept, type BookFileType } from "./bookFileTypes";
import { kindleFailureKind, kindleFailureNotice, kindleImportFailureKind, kindleOpenFailureKind, type KindleFailureKind } from "./kindleFormatNotice";

describe("book file types", () => {
  it("lists exactly the formats core accepts", () => {
    for (const extension of bookPickerExtensions()) expect(supportedBookName(`a.${extension}`)).toBe(true);
    for (const name of ["a.MOBI", "a.azw3"]) expect(nativeOnlyBookName(name)).toBe(true);
    expect(nativeOnlyBookName("a.epub")).toBe(false);
    expect(bookFileMime("a.azw3")).toBe("application/vnd.amazon.ebook");
  });

  it("keeps native-only formats out of the web file input", () => {
    expect(webBookAccept()).toBe(".epub,.txt,.cbz,.zip,application/epub+zip,text/plain,application/zip");
    expect(bookPickerExtensions()).toEqual(expect.arrayContaining(["mobi", "azw3"]));
    const extra: BookFileType[] = [...BOOK_FILE_TYPES, { extension: "x", mime: "application/x-test", nativeOnly: true }];
    expect(webBookAccept(extra)).not.toContain("x-test");
  });

  it("maps names to extension and MIME case-insensitively", () => {
    expect(bookFileExtension("书.FB2")).toBe("fb2");
    expect(bookFileExtension("archive.tar.gz")).toBeUndefined();
    expect(bookFileMime("a.CBZ")).toBe("application/zip");
    expect(bookFileMime("a.fb2")).toBe("application/x-fictionbook+xml");
    expect(bookFileMime("unknown")).toBe("application/epub+zip");
  });
});

describe("kindle failure notices", () => {
  it("gives every failure kind its own text; only cancel is not an error", () => {
    const kinds: KindleFailureKind[] = ["encrypted", "unsupported-variant", "corrupt", "source-unavailable", "cancelled", "budget"];
    const notices = kinds.map(kindleFailureNotice);
    expect(new Set(notices.map((notice) => notice.text)).size).toBe(kinds.length);
    expect(notices.filter((notice) => notice.kind === "warn").length).toBe(1);
    expect(kindleFailureNotice("cancelled").kind).toBe("warn");
  });

  it("maps frozen mobi.* codes; import items by the prefix only", () => {
    expect(kindleFailureKind("mobi.replica")).toBe("unsupported-variant");
    expect(kindleFailureKind("mobi.no_opf")).toBe("corrupt");
    expect(kindleFailureKind("mobi.internal")).toBeNull();
    expect(kindleOpenFailureKind({ code: "mobi.budget", message: "" })).toBe("budget");
    expect(kindleImportFailureKind("mobi.encrypted: 加密: 非零")).toBe("encrypted");
    expect(kindleImportFailureKind("mobi.cancelled: x")).toBe("cancelled");
    expect(kindleImportFailureKind("书籍已加密 mobi.encrypted")).toBeNull();
    expect(kindleImportFailureKind(null)).toBeNull();
  });
});
