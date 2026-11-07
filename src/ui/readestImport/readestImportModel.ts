/**
 * Pure decisions behind the Readest import dialog: which Readest book maps to
 * which local book, what each step shows, and what one commit sends. The hook
 * owns the native session; nothing here performs I/O.
 */
import type { BookmarkValue, NoteValue, ProgressValue } from "../../core/portableState/portable-state-types";
import {
  READEST_COMMIT_MAX_BOOKS,
  READEST_COMMIT_MAX_RECORDS,
  type ReadestBookImportPayload,
  type ReadestImportOutcome,
  type ReadestTargetCandidate,
} from "../../platform/readestImportNativeBridge";
import type { ReadestLibraryBook } from "./readestBackup";
import type { ImportCandidate, ReadestBookPreview } from "./readestConvert";

/** A local book that can receive Readest records (EPUB, bound, readable). */
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

export type MatchStatus =
  /** Exactly one local book has the same sampled digest. */
  | "matched"
  /** Several local books share the digest: the user picks one. */
  | "ambiguous"
  /** No local candidate; the user may pick a local book by hand. */
  | "unmatched"
  | "deleted"
  | "unsupported-format";

export interface MatchRow {
  readestHash: string;
  title: string;
  author: string;
  /** Readest's upper-case format name (EPUB, PDF, ...). */
  format: string;
  status: MatchStatus;
  /** Local book ids whose sampled digest equals this Readest hash. */
  candidates: string[];
  /** The local book the user (or the unique digest) chose. */
  chosen: string | null;
  selected: boolean;
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

/** Step 1: digest matches are candidates only, so more than one is never auto-chosen. */
export function matchRows(library: readonly ReadestLibraryBook[], locals: readonly LocalImportBook[]): MatchRow[] {
  const byDigest = new Map<string, string[]>();
  for (const local of locals) byDigest.set(local.partialMd5, [...(byDigest.get(local.partialMd5) ?? []), local.id]);
  const rank: Record<MatchStatus, number> = { matched: 0, ambiguous: 1, unmatched: 2, "unsupported-format": 3, deleted: 4 };
  return library
    .map((book): MatchRow => {
      const base = { readestHash: book.hash, title: book.title, author: book.author, format: book.format, candidates: [] as string[], chosen: null, selected: false };
      if (book.deleted) return { ...base, status: "deleted" };
      if (book.format && book.format !== "EPUB") return { ...base, status: "unsupported-format" };
      const candidates = byDigest.get(book.hash) ?? [];
      if (candidates.length === 1) return { ...base, status: "matched", candidates, chosen: candidates[0], selected: true };
      return { ...base, status: candidates.length ? "ambiguous" : "unmatched", candidates };
    })
    .sort((a, b) => rank[a.status] - rank[b.status]);
}

export const canImportRow = (row: MatchRow): boolean =>
  row.status !== "deleted" && row.status !== "unsupported-format";

/** Per-record choice in step 2. Unresolved and unsupported records are never selectable. */
export interface ReviewItem<T> {
  candidate: ImportCandidate<T>;
  selected: boolean;
}

export interface BookReview {
  readestHash: string;
  title: string;
  local: LocalImportBook;
  /** Null when the backup has no config for this book. */
  progress: ReviewItem<NonNullable<ProgressValue>> | null;
  bookmarks: ReviewItem<BookmarkValue>[];
  notes: ReviewItem<NoteValue>[];
  /** Book-level switch; items keep their own choices underneath. */
  selected: boolean;
}

export const isSelectable = (candidate: ImportCandidate<unknown>): boolean =>
  candidate.grade === "exact" || candidate.grade === "approximate";

const item = <T>(candidate: ImportCandidate<T>, selected = isSelectable(candidate)): ReviewItem<T> =>
  ({ candidate, selected: selected && isSelectable(candidate) });

/** Step 2 defaults: placed records on; the Readest position replaces a local one only when asked. */
export function bookReview(row: MatchRow, local: LocalImportBook, preview: ReadestBookPreview | null): BookReview {
  const progress = preview?.progress
    ? item(preview.progress as ImportCandidate<NonNullable<ProgressValue>>, local.progressPct === null)
    : null;
  return {
    readestHash: row.readestHash,
    title: row.title,
    local,
    progress,
    bookmarks: (preview?.bookmarks ?? []).map((candidate) => item(candidate)),
    notes: (preview?.notes ?? []).map((candidate) => item(candidate)),
    selected: true,
  };
}

export interface GradeCounts {
  exact: number;
  approximate: number;
  unresolved: number;
  unsupported: number;
}

export function gradeCounts(review: BookReview): GradeCounts {
  const counts: GradeCounts = { exact: 0, approximate: 0, unresolved: 0, unsupported: 0 };
  for (const { candidate } of [...review.bookmarks, ...review.notes]) counts[candidate.grade]++;
  return counts;
}

function chosen<T>(items: readonly ReviewItem<T>[]): Array<{ sourceKey: string; value: T }> {
  return items
    .filter((entry) => entry.selected && entry.candidate.value !== null)
    .map((entry) => ({ sourceKey: entry.candidate.sourceKey, value: entry.candidate.value as T }));
}

export type CommitPlan =
  | { ok: true; books: ReadestBookImportPayload[]; records: number; notChosen: number }
  | { ok: false; reason: "nothing-selected" | "too-many-books" | "too-many-records"; records: number };

/**
 * Only what the user ticked and conversion placed is sent — no CFI, grade or
 * source text. Limits are checked here so one commit stays one transaction.
 */
export function commitPlan(reviews: readonly BookReview[]): CommitPlan {
  const books: ReadestBookImportPayload[] = [];
  let records = 0;
  let notChosen = 0;
  for (const review of reviews) {
    const all = [...review.bookmarks, ...review.notes, ...(review.progress ? [review.progress] : [])];
    if (!review.selected) {
      notChosen += all.length;
      continue;
    }
    const bookmarks = chosen(review.bookmarks);
    const notes = chosen(review.notes);
    const progress = review.progress?.selected && review.progress.candidate.value ? review.progress.candidate.value : null;
    notChosen += all.length - bookmarks.length - notes.length - (progress ? 1 : 0);
    if (!bookmarks.length && !notes.length && !progress) continue;
    records += bookmarks.length + notes.length + (progress ? 1 : 0);
    books.push({
      bookHash: review.local.bookHash,
      readestHash: review.readestHash,
      targetToken: review.local.targetToken,
      ...(progress ? { progress: { locator: progress.locator, progressPctHint: Math.round(progress.progressPctHint) } } : {}),
      bookmarks,
      notes,
    });
  }
  if (!books.length) return { ok: false, reason: "nothing-selected", records };
  if (books.length > READEST_COMMIT_MAX_BOOKS) return { ok: false, reason: "too-many-books", records };
  if (records > READEST_COMMIT_MAX_RECORDS) return { ok: false, reason: "too-many-records", records };
  return { ok: true, books, records, notChosen };
}

export interface OutcomeSummary {
  added: number;
  progressWritten: number;
  skippedExisting: number;
  progressUnchanged: number;
  /** Records shown in the preview but not sent: unresolved, unsupported or unticked. */
  notImported: number;
}

export function outcomeSummary(outcome: ReadestImportOutcome, notChosen: number): OutcomeSummary {
  return {
    added: outcome.bookmarksAdded + outcome.notesAdded,
    progressWritten: outcome.progressWritten,
    skippedExisting: outcome.skippedExisting,
    progressUnchanged: outcome.progressUnchanged,
    notImported: notChosen,
  };
}
