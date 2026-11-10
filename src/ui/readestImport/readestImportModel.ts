/**
 * Pure decisions behind the Readest import: what each Readest book becomes on
 * the one list, how the reading-position rule applies, and what one book sends
 * to the commit. The hook owns the native session; nothing here performs I/O.
 */
import type { BookmarkValue, NoteValue, ProgressValue } from "../../core/portableState/portable-state-types";
import {
  READEST_COMMIT_MAX_RECORDS,
  type ReadestBookFile,
  type ReadestBookImportPayload,
  type ReadestImportOutcome,
  type ReadestTargetCandidate,
} from "../../platform/readestImportNativeBridge";
import type { ReadestLibraryBook } from "./readestBackup";
import type { ImportCandidate, ReadestBookPreview } from "./readestConvert";

/** A shelf book the native side can attach Readest records to. */
export interface LocalImportBook {
  id: string;
  bookHash: string;
  title: string;
  fileName: string;
  partialMd5: string;
  targetToken: string;
  /** Local reading position percentage, when there is one. */
  progressPct: number | null;
}

export const isLocalEpub = (fileName: string): boolean => /\.epub$/i.test(fileName);

/** Combine native candidate rows with shelf entries; failed rows are left out. */
export function localImportBooks(
  entries: ReadonlyArray<{ id: string; contentHash?: string; title: string; fileName: string }>,
  candidates: readonly ReadestTargetCandidate[],
): LocalImportBook[] {
  const byHash = new Map(candidates.map((row) => [row.bookHash, row]));
  const books: LocalImportBook[] = [];
  for (const entry of entries) {
    const row = entry.contentHash ? byHash.get(entry.contentHash) : undefined;
    if (!row?.partialMd5 || !row.targetToken || row.errorCode) continue;
    const display = row.progress?.display?.value ?? null;
    books.push({
      id: entry.id,
      bookHash: row.bookHash,
      title: entry.title,
      fileName: entry.fileName,
      partialMd5: row.partialMd5,
      targetToken: row.targetToken,
      progressPct: display ? display.progressPctHint : null,
    });
  }
  return books;
}

/** Which reading position wins when the book was read on both sides. */
export type PositionRule = "farther" | "readest" | "local";

export type RowKind = "new" | "existing" | "unavailable";

export type UnavailableReason =
  /** The source has no file for it: it only lives in Readest's cloud. */
  | "no-file"
  | "unsupported-format"
  /** Already on the shelf in a format whose records cannot be converted. */
  | "shelved-no-records";

/** One Readest book on the list. */
export interface ImportRow {
  readestHash: string;
  title: string;
  author: string;
  /** Upper-case format label (EPUB, MOBI, PDF, ...). */
  format: string;
  kind: RowKind;
  reason?: UnavailableReason;
  /** `existing`: the shelf book that is the same file. */
  local?: LocalImportBook;
  /** `new`: the book file in the source. */
  file?: ReadestBookFile;
  /** Position, bookmarks and notes can be converted (EPUB only). */
  records: boolean;
  selected: boolean;
}

/** Readest formats SeLis can open; anything else is "unsupported", not "missing". */
const READABLE_FORMATS = new Set(["EPUB", "MOBI", "AZW3", "FB2", "CBZ", "TXT"]);
const KIND_RANK: Record<RowKind, number> = { new: 0, existing: 1, unavailable: 2 };

const extension = (fileName: string): string => (/\.([^.]+)$/.exec(fileName)?.[1] ?? "").toUpperCase();

/**
 * The one list: new books come with their file, books already here only merge
 * records, the rest is shown with the reason. Books deleted in Readest are left
 * out. Everything that can be imported starts selected.
 */
export function importRows(
  library: readonly ReadestLibraryBook[],
  locals: readonly LocalImportBook[],
  files: readonly ReadestBookFile[],
): ImportRow[] {
  const localByDigest = new Map<string, LocalImportBook>();
  // The same file can only be one shelf book; keep the first on a digest clash.
  for (const local of locals) if (!localByDigest.has(local.partialMd5)) localByDigest.set(local.partialMd5, local);
  const fileByHash = new Map(files.map((file) => [file.readestHash, file]));
  const rows: ImportRow[] = [];
  for (const book of library) {
    if (book.deleted) continue;
    const base = { readestHash: book.hash, title: book.title, author: book.author };
    const local = localByDigest.get(book.hash);
    const file = fileByHash.get(book.hash);
    if (local) {
      const records = isLocalEpub(local.fileName);
      rows.push({
        ...base,
        format: extension(local.fileName) || book.format,
        local,
        records,
        ...(records
          ? { kind: "existing", selected: true }
          : { kind: "unavailable", reason: "shelved-no-records", selected: false }),
      });
    } else if (file) {
      rows.push({ ...base, format: extension(file.fileName) || book.format, kind: "new", file, records: isLocalEpub(file.fileName), selected: true });
    } else {
      const readable = !book.format || READABLE_FORMATS.has(book.format);
      rows.push({ ...base, format: book.format, kind: "unavailable", reason: readable ? "no-file" : "unsupported-format", records: false, selected: false });
    }
  }
  return rows.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

export interface SelectionSummary {
  newBooks: number;
  existing: number;
  /** Bytes of the new books' files. */
  bytes: number;
}

export function selectionSummary(rows: readonly ImportRow[]): SelectionSummary {
  const summary: SelectionSummary = { newBooks: 0, existing: 0, bytes: 0 };
  for (const row of rows) {
    if (!row.selected) continue;
    if (row.kind === "new") {
      summary.newBooks += 1;
      summary.bytes += row.file?.bytes ?? 0;
    } else if (row.kind === "existing") summary.existing += 1;
  }
  return summary;
}

/** New books are staged a few at a time so a large backup never needs its size twice over. */
export function stageChunks(rows: readonly ImportRow[], maxBooks = 8, maxBytes = 256 * 1024 * 1024): ImportRow[][] {
  const chunks: ImportRow[][] = [];
  let chunk: ImportRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = row.file?.bytes ?? 0;
    if (chunk.length > 0 && (chunk.length >= maxBooks || bytes + size > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(row);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** Whether Readest's position replaces the local one under the chosen rule. */
export function takesReadestPosition(rule: PositionRule, readestPct: number, localPct: number | null): boolean {
  if (localPct === null) return true;
  if (rule === "readest") return true;
  if (rule === "local") return false;
  return readestPct > localPct;
}

/** A record the conversion could not place; listed after the import, never sent. */
export interface UnplacedRecord {
  title: string;
  kind: "progress" | "bookmark" | "note";
  /** The text Readest captured there, when it kept one. */
  text: string | null;
}

const placed = (candidate: ImportCandidate<unknown>): boolean =>
  (candidate.grade === "exact" || candidate.grade === "approximate") && candidate.value !== null;

export interface BookPayload {
  /** Null when nothing of this book is sent. */
  payload: ReadestBookImportPayload | null;
  records: number;
  unplaced: UnplacedRecord[];
}

/** Everything the conversion placed is sent; only the position follows the rule. */
export function bookPayload(
  readestHash: string,
  title: string,
  local: Pick<LocalImportBook, "bookHash" | "targetToken" | "progressPct">,
  preview: ReadestBookPreview,
  rule: PositionRule,
): BookPayload {
  const unplaced: UnplacedRecord[] = [];
  const keep = <T,>(candidates: readonly ImportCandidate<T>[], kind: "bookmark" | "note") => {
    const sent: Array<{ sourceKey: string; value: T }> = [];
    for (const candidate of candidates) {
      if (placed(candidate)) sent.push({ sourceKey: candidate.sourceKey, value: candidate.value as T });
      else unplaced.push({ title, kind, text: candidate.source.text });
    }
    return sent;
  };
  const bookmarks = keep<BookmarkValue>(preview.bookmarks, "bookmark");
  const notes = keep<NoteValue>(preview.notes, "note");
  let progress: NonNullable<ProgressValue> | null = null;
  if (preview.progress) {
    const value = placed(preview.progress) ? preview.progress.value as NonNullable<ProgressValue> : null;
    if (!value) unplaced.push({ title, kind: "progress", text: null });
    else if (takesReadestPosition(rule, value.progressPctHint, local.progressPct)) progress = value;
  }
  const records = bookmarks.length + notes.length + (progress ? 1 : 0);
  if (records === 0 || records > READEST_COMMIT_MAX_RECORDS) return { payload: null, records, unplaced };
  return {
    payload: {
      bookHash: local.bookHash,
      readestHash,
      targetToken: local.targetToken,
      ...(progress ? { progress: { locator: progress.locator, progressPctHint: Math.round(progress.progressPctHint) } } : {}),
      bookmarks,
      notes,
    },
    records,
    unplaced,
  };
}

export interface FailedBook {
  title: string;
  reason: string;
}

/** What the result screen reports. */
export interface ImportResult {
  booksAdded: number;
  /** Chosen as new, but the same file was already on the shelf. */
  booksAlready: number;
  bookmarksAdded: number;
  notesAdded: number;
  progressWritten: number;
  /** Records the shelf already had from an earlier import. */
  skippedExisting: number;
  unplaced: UnplacedRecord[];
  /** Handwriting and notebook records, which have no counterpart here. */
  unsupported: number;
  failed: FailedBook[];
  /** The user stopped it; `notReached` books were left untouched. */
  stopped: boolean;
  notReached: number;
  /** A failure that ended the run early. */
  error: string | null;
}

export const emptyResult = (): ImportResult => ({
  booksAdded: 0, booksAlready: 0, bookmarksAdded: 0, notesAdded: 0, progressWritten: 0, skippedExisting: 0,
  unplaced: [], unsupported: 0, failed: [], stopped: false, notReached: 0, error: null,
});

export function addOutcome(result: ImportResult, outcome: ReadestImportOutcome): void {
  result.bookmarksAdded += outcome.bookmarksAdded;
  result.notesAdded += outcome.notesAdded;
  result.progressWritten += outcome.progressWritten;
  result.skippedExisting += outcome.skippedExisting;
}

/** Nothing went wrong and nothing was left behind. */
export const resultIsClean = (result: ImportResult): boolean =>
  !result.error && !result.stopped && result.failed.length === 0 && result.unplaced.length === 0;
