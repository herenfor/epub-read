import { describe, expect, it } from "vitest";
import { supportedBookName } from "../core/documentFormats";
import { BOOK_FILE_TYPES, bookFileExtension, bookFileMime, bookPickerExtensions, webBookAccept, type BookFileType } from "./bookFileTypes";
import { kindleFailureNotice, type KindleFailureKind } from "./kindleFormatNotice";

describe("book file types", () => {
  it("lists exactly the formats core accepts", () => {
    for (const extension of bookPickerExtensions()) expect(supportedBookName(`a.${extension}`)).toBe(true);
    // Not enabled until the native MOBI/AZW3 backend is complete.
    for (const name of ["a.mobi", "a.azw3"]) {
      expect(supportedBookName(name)).toBe(false);
      expect(bookFileExtension(name)).toBeUndefined();
    }
  });

  it("keeps native-only formats out of the web file input", () => {
    expect(webBookAccept()).toBe(".epub,.txt,.cbz,.zip,application/epub+zip,text/plain,application/zip");
    const withKindle: BookFileType[] = [...BOOK_FILE_TYPES, { extension: "azw3", mime: "application/vnd.amazon.ebook", nativeOnly: true }];
    expect(webBookAccept(withKindle)).not.toContain("azw3");
    expect(bookPickerExtensions(withKindle)).toContain("azw3");
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
});
