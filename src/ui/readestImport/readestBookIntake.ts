/**
 * Adds staged Readest books to the active shelf through the importers every
 * other import uses: the path importer on desktop (always as a library copy,
 * the staged file is temporary) and the document importer on Android.
 */
import { importDocuments, type AndroidDocumentSelection } from "../../platform/androidNativeBridge";
import type { ReadestStagedBook } from "../../platform/readestImportNativeBridge";
import type { ShelfEntry, ShelfStore } from "../shelf";

export interface IntakeItem {
  status: "saved" | "duplicate" | "failed";
  entry: ShelfEntry | null;
  /** A staging error code, or the importer's own message. */
  errorCode: string | null;
  error: string | null;
}

type IntakeStore = Pick<ShelfStore, "importPaths" | "importDocuments" | "importRecords">;

interface ImportedItem {
  inputIndex: number;
  status: string;
  record?: ShelfEntry | null;
  error?: string | null;
}

export async function intakeStagedBooks(
  store: IntakeStore,
  staged: readonly ReadestStagedBook[],
  requestId: string,
): Promise<Map<string, IntakeItem>> {
  const items = new Map<string, IntakeItem>();
  const ready: ReadestStagedBook[] = [];
  for (const book of staged) {
    if (book.errorCode || (!book.path && !book.uri)) {
      items.set(book.readestHash, { status: "failed", entry: null, errorCode: book.errorCode ?? "no-file", error: null });
    } else ready.push(book);
  }
  if (ready.length === 0) return items;

  let results: ImportedItem[];
  if (ready.every((book) => book.path)) {
    results = (await store.importPaths(ready.map((book) => book.path!), true)).results;
  } else {
    const documents: AndroidDocumentSelection[] = ready.map((book) => (book.fileName ? { uri: book.uri!, fileName: book.fileName } : { uri: book.uri! }));
    results = (store.importDocuments
      ? await store.importDocuments(documents, () => undefined)
      : await importDocuments(requestId, documents, () => undefined)).results;
  }

  const accepted = results.flatMap((item) => (item.status !== "failed" && item.status !== "cancelled" && item.record ? [item.record] : []));
  // The repository projection carries the versions later steps read.
  const projected = accepted.length > 0 && store.importRecords ? await store.importRecords(accepted) : accepted;
  const byId = new Map(projected.map((entry) => [entry.id, entry]));
  for (const item of results) {
    const book = ready[item.inputIndex];
    if (!book) continue;
    const ok = (item.status === "saved" || item.status === "duplicate") && item.record;
    items.set(book.readestHash, ok
      ? { status: item.status as "saved" | "duplicate", entry: byId.get(item.record!.id) ?? item.record!, errorCode: null, error: null }
      : { status: "failed", entry: null, errorCode: item.status === "cancelled" ? "cancelled" : null, error: item.error ?? null });
  }
  for (const book of ready) {
    if (!items.has(book.readestHash)) items.set(book.readestHash, { status: "failed", entry: null, errorCode: null, error: null });
  }
  return items;
}
