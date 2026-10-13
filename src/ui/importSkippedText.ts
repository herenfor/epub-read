import type { ImportSkippedBook } from "../platform/saveFileNativeBridge";
import { uiPlural, uiText } from "./localization/UiLanguageProvider";

/** C6: why one incoming book was not accepted, localized by the stable reason code. */
export function importSkippedReasonText(book: ImportSkippedBook): string {
  if (book.reason === "not-local") return uiText("saveFile.import.reason.notLocal");
  if (book.reason === "attachment-import-failed") {
    return book.message
      ? uiText("saveFile.import.reason.attachmentFailedWith", { message: book.message })
      : uiText("saveFile.import.reason.attachmentFailed");
  }
  return uiText("saveFile.import.reason.other");
}

/** Up to `limit` skipped books with reasons, plus a total when the list is cut short. */
export function importSkippedList(books: readonly ImportSkippedBook[], total: number, limit = 3): string {
  const list = books.slice(0, limit)
    .map((book) => uiText("saveFile.import.skippedItem", {
      title: book.title || book.contentHash.slice(0, 8),
      reason: importSkippedReasonText(book),
    }))
    .join(uiText("saveFile.listSeparator"));
  return total > Math.min(books.length, limit) ? list + uiPlural("saveFile.import.more", total, { count: total }) : list;
}

/** Notice clause for an import result; empty when nothing was skipped. */
export function importSkippedNotice(skippedBookCount: number, skippedBooks: readonly ImportSkippedBook[]): string {
  const count = Math.max(skippedBookCount, skippedBooks.length);
  if (count === 0) return "";
  return uiPlural("notice.archive.skipped", count, { count, list: importSkippedList(skippedBooks, count) });
}
