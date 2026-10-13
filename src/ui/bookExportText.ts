import type { BookSourceExportError, BookSourceExportResult } from "../platform/bookExportNativeBridge";
import type { SaveFileLocation } from "../platform/saveFileNativeBridge";
import type { ShelfNotice } from "./useShelfLibrary";
import { uiText } from "./localization/UiLanguageProvider";

/** A safe default save name for one book: its shelf file name, else its title. */
export function bookExportFileName(fileName: string | undefined, title: string): string {
  const name = (fileName?.trim() || title.trim()).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  if (/\.epub$/i.test(name)) return name;
  return `${name.replace(/[. ]+$/, "") || "book"}.epub`;
}

/** The saved file's name for notices; content URIs carry it as the last decoded path segment. */
export function bookExportTargetLabel(destination: SaveFileLocation): string {
  if (destination.kind === "path") return destination.path.split(/[\\/]/).pop() || destination.path;
  let decoded = destination.uri;
  try { decoded = decodeURIComponent(destination.uri); } catch { /* keep the raw URI */ }
  return decoded.split(/[/:]/).pop() || decoded;
}

function skippedReason(reason: string): string {
  switch (reason) {
    case "book-not-found": return uiText("bookExport.reason.notFound");
    case "source-unbound": return uiText("bookExport.reason.unbound");
    case "source-missing": return uiText("bookExport.reason.missing");
    case "source-unreadable": return uiText("bookExport.reason.unreadable");
    case "source-changed": return uiText("bookExport.reason.changed");
    default: return uiText("bookExport.reason.other");
  }
}

function skippedList(books: BookSourceExportResult["skippedBooks"]): string {
  const list = books.slice(0, 3)
    .map((book) => uiText("bookExport.skippedItem", { title: book.title || book.contentHash.slice(0, 8), reason: skippedReason(book.reason) }))
    .join(uiText("saveFile.listSeparator"));
  return books.length > 3 ? list + uiText("bookExport.skippedMore", { count: books.length }) : list;
}

/** Only `written` is success; partial success names what was left out. */
export function bookExportResultNotice(result: BookSourceExportResult, target: string): NonNullable<ShelfNotice> {
  if (result.status === "cancelled") return { kind: "warn", text: uiText("bookExport.cancelled") };
  if (result.status === "no-books") {
    return { kind: "warn", text: uiText("bookExport.noBooks", { list: skippedList(result.skippedBooks) }) };
  }
  if (result.skippedBooks.length > 0) {
    return {
      kind: "warn",
      text: uiText("bookExport.partial", {
        written: result.writtenBooks,
        requested: result.requestedBooks,
        file: target,
        list: skippedList(result.skippedBooks),
      }),
    };
  }
  return { kind: "ok", text: uiText("bookExport.done", { count: result.writtenBooks, file: target }) };
}

export function bookExportErrorNotice(error: BookSourceExportError): NonNullable<ShelfNotice> {
  const partial = error.partialOutputRetained ? uiText("bookExport.partialOutput") : "";
  if (error.code === "cancelled") return { kind: "warn", text: uiText("bookExport.cancelled") + partial };
  const detail = error.code === "insufficient-space" ? uiText("bookExport.error.space")
    : error.code === "busy" ? uiText("bookExport.error.busy")
      : error.code === "source-changed" ? uiText("bookExport.reason.changed")
        : error.message;
  return { kind: "error", text: uiText("bookExport.failed", { error: detail }) + partial };
}
