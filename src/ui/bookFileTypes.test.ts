import { describe, expect, it } from "vitest";
import { supportedBookName } from "../core/documentFormats";
import { MOBI_FORMAT_ENABLED } from "../config/mobiFormat";
import { BOOK_FILE_TYPES, IMPORT_BOOK_FILE_TYPES, bookFileExtension, bookFileMime, bookPickerExtensions, importableBookFileTypes, nativeOnlyBookName, webBookAccept, type BookFileType } from "./bookFileTypes";
import { formatListKey } from "./bookFormatText";
import { kindleFailureIsFileProblem, kindleFailureKind, kindleFailureNotice, kindleImportFailureKind, kindleOpenFailureKind, type KindleFailureKind, mobiBookBlocked } from "./kindleFormatNotice";
import { uiText } from "./localization/UiLanguageProvider";

describe("book file types", () => {
  it("lists exactly the formats core accepts, with the MOBI switch on or off", () => {
    for (const mobi of [true, false]) {
      const types = importableBookFileTypes(BOOK_FILE_TYPES, mobi);
      for (const extension of bookPickerExtensions(types)) expect(supportedBookName(`a.${extension}`, mobi)).toBe(true);
      for (const name of ["a.epub", "a.fb2", "a.txt", "a.cbz", "a.zip", "a.AZW3"]) expect(supportedBookName(name, mobi)).toBe(true);
      expect(types.some((type) => type.extension === "mobi")).toBe(mobi);
      expect(types.some((type) => type.extension === "azw3")).toBe(true);
      expect(supportedBookName("a.MOBI", mobi)).toBe(mobi);
    }
    for (const name of ["a.MOBI", "a.azw3"]) expect(nativeOnlyBookName(name)).toBe(true);
    expect(nativeOnlyBookName("a.epub")).toBe(false);
  });

  it("defaults follow VITE_MOBI_FORMAT; unset means off", () => {
    const on = /^(?:1|on|true)$/i.test(String(import.meta.env.VITE_MOBI_FORMAT ?? ""));
    expect(MOBI_FORMAT_ENABLED).toBe(on);
    expect(bookPickerExtensions()).toEqual(on ? ["epub", "fb2", "txt", "cbz", "zip", "mobi", "azw3"] : ["epub", "fb2", "txt", "cbz", "zip", "azw3"]);
    expect(IMPORT_BOOK_FILE_TYPES).toEqual(importableBookFileTypes(BOOK_FILE_TYPES, on));
    expect(supportedBookName("a.mobi")).toBe(on);
  });

  it("keeps a shelved MOBI book's extension and MIME while import is off", () => {
    expect(bookFileExtension("a.MOBI")).toBe("mobi");
    expect(bookFileMime("a.azw3")).toBe("application/vnd.amazon.ebook");
    expect(bookFileMime("a.mobi")).toBe("application/x-mobipocket-ebook");
  });

  it("keeps native-only formats out of the web file input", () => {
    const accept = ".epub,.txt,.cbz,.zip,application/epub+zip,text/plain,application/zip";
    expect(webBookAccept()).toBe(accept);
    expect(webBookAccept(importableBookFileTypes(BOOK_FILE_TYPES, true))).toBe(accept);
    expect(bookPickerExtensions(importableBookFileTypes(BOOK_FILE_TYPES, true))).toEqual(expect.arrayContaining(["mobi", "azw3"]));
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

describe("format list texts follow the MOBI switch", () => {
  it("drops only MOBI from every listing text when off, and keeps the originals when on", () => {
    const keys = ["shelf.import.tip", "shelf.import.books.detail", "shelf.import.dropHint", "shelf.import.dropHint.booksOnly",
      "shelf.import.toFolder.tip", "notice.picker.epubFilter", "notice.drop.unsupported", "notice.drop.booksOnly"] as const;
    for (const key of keys) {
      expect(formatListKey(key, true)).toBe(key);
      const off = uiText(formatListKey(key, false), { name: "N" });
      const on = uiText(formatListKey(key, true), { name: "N" });
      expect(on).toContain("MOBI");
      expect(off).not.toContain("MOBI");
      expect(off).toContain("AZW3");
      expect(off).toContain("EPUB");
      expect(off).toContain("FB2");
    }
  });
});

describe("kindle failure notices", () => {
  it("gives every failure kind its own text; only cancel is not an error", () => {
    const kinds: KindleFailureKind[] = ["encrypted", "unsupported-variant", "corrupt", "source-unavailable", "cancelled", "budget", "disabled"];
    const notices = kinds.map(kindleFailureNotice);
    expect(new Set(notices.map((notice) => notice.text)).size).toBe(kinds.length);
    expect(notices.filter((notice) => notice.kind === "warn").length).toBe(2);
    expect(kindleFailureNotice("cancelled").kind).toBe("warn");
    expect(kindleFailureNotice("disabled").kind).toBe("warn");
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
    // ER-0150 backend refusal: same text as the frontend gate, no copy retry.
    expect(kindleOpenFailureKind({ code: "mobi.disabled", message: "" })).toBe("disabled");
    expect(kindleImportFailureKind("mobi.disabled: x")).toBe("disabled");
    expect(kindleFailureIsFileProblem("disabled")).toBe(true);
  });

  it("blocks opening only .mobi books, only when the switch is off; AZW3 always opens", () => {
    expect(mobiBookBlocked("a.MOBI", false)).toBe(true);
    expect(mobiBookBlocked("a.azw3", false)).toBe(false);
    expect(mobiBookBlocked("a.epub", false)).toBe(false);
    expect(mobiBookBlocked("a.mobi", true)).toBe(false);
    expect(mobiBookBlocked("a.mobi")).toBe(!MOBI_FORMAT_ENABLED);
  });
});
