/**
 * Adapts existing browser shelf rows to the portable v3 migration boundary.
 *
 * This module only reads metadata; it never writes, moves or rekeys the old
 * `books`/`covers` stores. A row whose `contentHash` is still missing is
 * returned as `pending-hash` and is never matched by title or deleted.
 */
import {
  legacyContentHash,
  portableBookFromLegacySource,
  type LegacyBookSource,
  type MigratedLegacyBook,
} from "../../core/portableState/legacy";
import type { Stamp } from "../../core/portableState/portable-register-core";
import { hasReadEvidence } from "../readEvidence";
import type { ShelfEntry } from "../shelf";

export interface LegacyMigrationOptions {
  /**
   * Only pass this when the actual EPUB is available. Returning null keeps an
   * unresolved legacy locator at version 0 instead of pretending chapter start.
   */
  readonly resolveChapterPath?: (spineIndex: number) => string | null;
}

export interface ReadyLegacyBook {
  readonly kind: "ready";
  readonly localEntryId: string;
  readonly contentHash: string;
  readonly source: LegacyBookSource;
}

export interface PendingHashLegacyBook {
  readonly kind: "pending-hash";
  readonly localEntryId: string;
  readonly title: string;
  readonly reason: "missing-content-hash";
}

export type LegacyBookCandidate = ReadyLegacyBook | PendingHashLegacyBook;

function chapterPathFor(
  entry: Partial<ShelfEntry>,
  options: LegacyMigrationOptions,
): string | null {
  const spineIndex = typeof entry.spineIndex === "number" && Number.isSafeInteger(entry.spineIndex) && entry.spineIndex >= 0
    ? entry.spineIndex
    : 0;
  return options.resolveChapterPath?.(spineIndex) ?? null;
}

function readingFields(entry: Partial<ShelfEntry>, options: LegacyMigrationOptions) {
  const resolvedChapterPath = chapterPathFor(entry, options);
  return {
    spineIndex: entry.spineIndex ?? 0,
    page: entry.page ?? 0,
    anchorIndex: entry.anchorIndex ?? null,
    anchorRatio: entry.anchorRatio ?? null,
    anchorTextOffset: entry.anchorTextOffset ?? null,
    anchorTextSnippet: entry.anchorTextSnippet ?? null,
    mediaAnchor: entry.mediaAnchor ?? null,
    ...(resolvedChapterPath === null ? {} : { resolvedChapterPath }),
  };
}

export function legacyShelfEntryToCandidate(
  entry: Partial<ShelfEntry> & { readonly id: string },
  options: LegacyMigrationOptions = {},
): LegacyBookCandidate {
  const contentHash = legacyContentHash(entry.contentHash) ?? legacyContentHash(entry.id);
  if (!contentHash) {
    return {
      kind: "pending-hash",
      localEntryId: entry.id,
      title: entry.title ?? "",
      reason: "missing-content-hash",
    };
  }

  const oldProgress = {
    ...readingFields(entry, options),
    progressPctHint: typeof entry.progressPct === "number" ? entry.progressPct : 0,
    updatedAtMs: typeof entry.lastReadAtMs === "number" ? entry.lastReadAtMs : entry.addedAtMs ?? 0,
  };

  const source: LegacyBookSource = {
    contentHash,
    localEntryId: entry.id,
    metadata: {
      title: entry.title ?? "",
      creator: entry.creator ?? "",
      ...(entry.language ? { language: entry.language } : {}),
      fileName: entry.fileName ?? "",
      addedAtMs: entry.addedAtMs ?? 0,
    },
    progress: hasReadEvidence(entry) ? oldProgress : null,
    bookmarks: (entry.bookmarks ?? []).map((bookmark) => ({
      id: bookmark.id,
      spineIndex: bookmark.spineIndex,
      page: bookmark.page,
      anchorIndex: bookmark.anchorIndex,
      anchorRatio: bookmark.anchorRatio,
      anchorTextOffset: bookmark.anchorTextOffset ?? null,
      anchorTextSnippet: bookmark.anchorTextSnippet ?? null,
      mediaAnchor: bookmark.mediaAnchor ?? null,
      text: bookmark.text,
      createdAtMs: bookmark.createdAtMs,
      ...(chapterPathFor(bookmark, options) === null ? {} : { resolvedChapterPath: chapterPathFor(bookmark, options)! }),
    })),
    notes: (entry.notes ?? []).map((note) => ({
      id: note.id,
      chapterPath: note.chapterPath,
      spineIndex: note.spineIndex,
      startTextOffset: note.startTextOffset,
      endTextOffset: note.endTextOffset,
      startTextSnippet: note.startTextSnippet,
      endTextSnippet: note.endTextSnippet,
      selectedText: note.selectedText,
      content: note.content,
      createdAtMs: note.createdAtMs,
      updatedAtMs: note.updatedAtMs,
    })),
  };

  return { kind: "ready", localEntryId: entry.id, contentHash, source };
}

export interface LegacyShelfMigrationPlan {
  readonly ready: readonly ReadyLegacyBook[];
  readonly pendingHash: readonly PendingHashLegacyBook[];
  /** Local byte/cover keys stay local; this map is the only bridge to v3 books. */
  readonly contentHashByLocalEntryId: Readonly<Record<string, string>>;
}

export function planLegacyShelfMigration(
  entries: readonly (Partial<ShelfEntry> & { readonly id: string })[],
  options: LegacyMigrationOptions = {},
): LegacyShelfMigrationPlan {
  const ready: ReadyLegacyBook[] = [];
  const pendingHash: PendingHashLegacyBook[] = [];
  const contentHashByLocalEntryId: Record<string, string> = {};
  const seenHashes = new Set<string>();
  for (const entry of entries) {
    const candidate = legacyShelfEntryToCandidate(entry, options);
    if (candidate.kind === "pending-hash") {
      pendingHash.push(candidate);
      continue;
    }
    if (seenHashes.has(candidate.contentHash)) continue;
    seenHashes.add(candidate.contentHash);
    ready.push(candidate);
    contentHashByLocalEntryId[candidate.localEntryId] = candidate.contentHash;
  }
  return { ready, pendingHash, contentHashByLocalEntryId };
}

export interface MigratedLegacyShelf {
  readonly books: readonly MigratedLegacyBook[];
  readonly pendingHash: readonly PendingHashLegacyBook[];
  readonly contentHashByLocalEntryId: Readonly<Record<string, string>>;
}

export function migrateLegacyShelfEntries(
  entries: readonly (Partial<ShelfEntry> & { readonly id: string })[],
  migrationStamp: Stamp,
  options: LegacyMigrationOptions = {},
): MigratedLegacyShelf {
  const plan = planLegacyShelfMigration(entries, options);
  return {
    books: plan.ready.map((candidate) => portableBookFromLegacySource(candidate.source, migrationStamp)),
    pendingHash: plan.pendingHash,
    contentHashByLocalEntryId: plan.contentHashByLocalEntryId,
  };
}
