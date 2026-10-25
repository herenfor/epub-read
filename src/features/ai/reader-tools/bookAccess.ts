import { createArchiveClient, type ArchiveClient } from "../../../core/selectiveArchive";
import { disposeBook, loadBookFromArchive } from "../../../core/book";
import type { Book } from "../../../core/types";
import { getShelfStore, isTauriEnv, type ShelfEntry } from "../../../ui/shelf";
import { ReaderToolError } from "./contracts";

export interface ReaderBookAccessOptions {
  openNativeArchive?(contentHash: string, signal: AbortSignal): Promise<{ archive: ArchiveClient; released(): Promise<void> }>;
}
export type ReaderBookAccess = <T>(bookId: string, signal: AbortSignal, work: (book: Book, entry: ShelfEntry) => Promise<T>) => Promise<T>;

/** One source owner per operation. Native release is an awaited cleanup barrier. */
export function createShelfBookAccess(options: ReaderBookAccessOptions = {}): ReaderBookAccess {
  return async (bookId, signal, work) => {
    const store = getShelfStore();
    const entry = (await store.list()).find(entry => entry.id === bookId);
    if (!entry) throw new ReaderToolError("BOOK_NOT_FOUND", "书籍已经离开书架");
    signal.throwIfAborted();
    let archive: ArchiveClient;
    let released: (() => Promise<void>) | undefined;
    try {
      if (isTauriEnv() && options.openNativeArchive) {
        const owned = await options.openNativeArchive(entry.contentHash ?? entry.id, signal);
        archive = owned.archive; released = owned.released;
      } else archive = isTauriEnv() && store.openArchive ? await store.openArchive(bookId) : await createArchiveClient(await store.readBook(bookId)); }
    catch { signal.throwIfAborted(); throw new ReaderToolError("SOURCE_UNAVAILABLE", "原书当前不可读取，请检查来源"); }
    const close = () => archive.close();
    signal.addEventListener("abort", close, { once: true });
    let book: Awaited<ReturnType<typeof loadBookFromArchive>> | undefined;
    try {
      signal.throwIfAborted();
      book = await loadBookFromArchive(archive, { preloadCover: false });
      signal.throwIfAborted();
      return await work(book, entry);
    } finally { signal.removeEventListener("abort", close); if (book) disposeBook(book); else close(); await released?.(); }
  };
}
