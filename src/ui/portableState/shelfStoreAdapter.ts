/**
 * CP-I ShelfStore facade over the portable v3 repository.
 *
 * Local byte/cover/thumbnail/binding operations stay on the existing
 * ShelfStore implementation. Portable metadata, progress, annotations and
 * organization are projected from the repository; the local store remains the
 * visibility/binding authority so a deleted local binding never resurrects a
 * portable record into the shelf.
 */
import type {
  Bookmark,
  LinkedImportBatchResult,
  ShelfEntry,
  ShelfProgressPatch,
  ShelfSaveInput,
  ShelfSaveResult,
  ShelfStore,
} from "../shelf";
import type { ReaderNote } from "../notes";
import type { LibraryRecord } from "../libraryArchive";
import type { LibraryOrganization } from "../libraryOrganization";
import type { ThumbnailAsset } from "../thumbnail";
import {
  legacyLocatorFromReadingFields,
  modernChapterStartLocator,
  modernMediaLocator,
  modernTextLocator,
  portableBookFromLegacySource,
} from "../../core/portableState/legacy";
import { latestVersion } from "../../core/portableState/projection";
import type {
  BookmarkValue,
  Locator,
  NoteValue,
  PortableBook,
  PortableStateV3,
  ProgressValue,
} from "../../core/portableState/portable-state-types";
import type { Stamp, Version } from "../../core/portableState/portable-register-core";
import { planLegacyShelfMigration } from "./legacyShelf";
import { projectShelfEntriesFromState, projectShelfEntry } from "./projection";
import { PortableStateError, type PortableAdoptSelection } from "./service";
import type { PortableActivationResult, PortableMergeOptions, PortableStateDataService } from "./dataService";

const HASH_RE = /^[0-9a-f]{64}$/;
const TEXT_PROFILE = "visible-codepoints-no-whitespace-v1" as const;


function hashForLocalEntry(entry: Pick<ShelfEntry, "id" | "contentHash">): string | null {
  const candidates = [entry.contentHash, entry.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && HASH_RE.test(candidate)) return candidate;
  }
  return null;
}

function mediaTag(value: unknown): "img" | "svg" | "video" | null {
  return value === "img" || value === "svg" || value === "video" ? value : null;
}

function locatorFromReadingFields(
  fields: {
    readonly spineIndex: number;
    readonly page: number;
    readonly anchorIndex: number | null;
    readonly anchorRatio: number | null;
    readonly anchorTextOffset?: number | null;
    readonly anchorTextSnippet?: string | null;
    readonly mediaAnchor?: { readonly index: number; readonly tag: string; readonly signature: string; readonly ratio: number } | null;
  },
  chapterPath?: string | null,
): Locator {
  const media = fields.mediaAnchor;
  const tag = media ? mediaTag(media.tag) : null;
  if (chapterPath) {
    if (
      fields.anchorTextOffset !== undefined &&
      fields.anchorTextOffset !== null &&
      fields.anchorTextSnippet
    ) {
      return modernTextLocator({
        chapterPath,
        spineIndexHint: fields.spineIndex,
        offset: fields.anchorTextOffset,
        snippet: fields.anchorTextSnippet,
      });
    }
    if (media && tag) {
      return modernMediaLocator({
        chapterPath,
        spineIndexHint: fields.spineIndex,
        signature: media.signature,
        indexHint: media.index,
        tag,
        ratio: media.ratio,
      });
    }
    return modernChapterStartLocator(chapterPath, fields.spineIndex);
  }
  return legacyLocatorFromReadingFields({
    spineIndex: fields.spineIndex,
    page: fields.page,
    anchorIndex: fields.anchorIndex,
    anchorRatio: fields.anchorRatio,
    anchorTextOffset: fields.anchorTextOffset ?? null,
    anchorTextSnippet: fields.anchorTextSnippet ?? null,
    mediaAnchor: media ?? null,
  });
}

function bookmarkValueFromBookmark(input: Bookmark, fallbackChapterPath?: string | null): BookmarkValue {
  return {
    locator: locatorFromReadingFields(
      {
        spineIndex: input.spineIndex,
        page: input.page,
        anchorIndex: input.anchorIndex,
        anchorRatio: input.anchorRatio,
        anchorTextOffset: input.anchorTextOffset ?? null,
        anchorTextSnippet: input.anchorTextSnippet ?? null,
        mediaAnchor: input.mediaAnchor ?? null,
      },
      input.chapterPath ?? fallbackChapterPath ?? null,
    ),
    text: input.text,
    createdAtMs: input.createdAtMs,
  };
}

function noteValueFromNote(input: ReaderNote): NoteValue {
  return {
    chapterPath: input.chapterPath,
    spineIndexHint: input.spineIndex,
    textProfile: TEXT_PROFILE,
    startTextOffset: input.startTextOffset,
    endTextOffset: input.endTextOffset,
    startTextSnippet: input.startTextSnippet,
    endTextSnippet: input.endTextSnippet,
    selectedText: input.selectedText,
    content: input.content,
    createdAtMs: input.createdAtMs,
  };
}

function progressValueFromPatch(patch: ShelfProgressPatch): ProgressValue {
  return {
    locator: locatorFromReadingFields({
      spineIndex: patch.spineIndex,
      page: patch.page,
      anchorIndex: patch.anchorIndex,
      anchorRatio: patch.anchorRatio,
      anchorTextOffset: patch.anchorTextOffset,
      anchorTextSnippet: patch.anchorTextSnippet,
      mediaAnchor: patch.mediaAnchor ?? null,
    }, null),
    progressPctHint: patch.progressPct,
  };
}

function recordToLegacyEntry(record: LibraryRecord): ShelfEntry {
  return {
    id: record.contentHash,
    title: record.title,
    creator: record.creator,
    ...(record.language ? { language: record.language } : {}),
    fileName: record.fileName,
    fileSize: 0,
    coverMime: "",
    addedAtMs: record.addedAtMs,
    lastReadAtMs: record.lastReadAtMs,
    spineIndex: record.spineIndex,
    page: record.page,
    progressPct: record.progressPct,
    anchorIndex: record.anchorIndex,
    anchorRatio: record.anchorRatio,
    anchorTextOffset: record.anchorTextOffset,
    anchorTextSnippet: record.anchorTextSnippet,
    ...(record.mediaAnchor ? { mediaAnchor: record.mediaAnchor } : {}),
    contentHash: record.contentHash,
    isNew: record.isNew,
    bookmarks: record.bookmarks.map((bookmark) => ({ ...bookmark })),
    notes: (record.notes ?? []).map((note) => ({ ...note })),
  };
}

function totalAnnotations(book: PortableBook): number {
  return Object.keys(book.bookmarks).length + Object.keys(book.notes).length;
}

async function buildMigrationBooks(
  entries: readonly ShelfEntry[],
  data: PortableStateDataService,
): Promise<{ books: Record<string, PortableBook>; localEntryIds: Record<string, string>; annotations: number }> {
  const plan = planLegacyShelfMigration(entries, {});
  const books: Record<string, PortableBook> = {};
  const localEntryIds: Record<string, string> = {};
  let annotations = 0;
  for (const ready of plan.ready) {
    const stamp: Stamp = await data.reserveStamps(1);
    const migrated = portableBookFromLegacySource(ready.source, stamp);
    books[migrated.contentHash] = migrated.book;
    localEntryIds[migrated.contentHash] = migrated.localEntryId;
    annotations += totalAnnotations(migrated.book);
  }
  return { books, localEntryIds, annotations };
}

function stateWithBooks(
  books: Record<string, PortableBook>,
  organization: LibraryOrganization,
): PortableStateV3 {
  return { schemaVersion: 3, books, organization };
}

function hasBook(state: PortableStateV3, hash: string | null): boolean {
  return hash !== null && state.books[hash] !== undefined;
}

/**
 * Web migration needs the same service caller; native reaches the Rust
 * `portable_state_activate` command through `data.activate`.
 */
export async function activatePortableShelfStore(
  legacy: ShelfStore,
  data: PortableStateDataService,
): Promise<PortableActivationResult> {
  if (data.activate) return data.activate();

  // Ensure the legacy organization envelope exists and is reused as the
  // installation identity in the shared browser database.
  const organization = await legacy.getOrganization();
  const state = await data.snapshot();
  const localEntries = await legacy.list();

  const hasLocalHashes = localEntries.some((entry) => hashForLocalEntry(entry) !== null);
  if (Object.keys(state.books).length > 0 || !hasLocalHashes) {
    return {
      status: Object.keys(state.books).length > 0 ? "already-migrated" : "fresh",
      books: Object.keys(state.books).length,
      annotations: Object.values(state.books).reduce((sum, book) => sum + totalAnnotations(book), 0),
    };
  }

  const migrated = await buildMigrationBooks(localEntries, data);
  if (Object.keys(migrated.books).length === 0) {
    return { status: "fresh", books: 0, annotations: 0 };
  }
  await data.mergeValidatedState(stateWithBooks(migrated.books, organization), {
    migrationMark: "shelf-store-v1",
  });
  return {
    status: "migrated",
    books: Object.keys(migrated.books).length,
    annotations: migrated.annotations,
  };
}

interface ObservedAnnotationIds {
  bookmarks: Set<string>;
  notes: Set<string>;
}

export class PortableShelfStore implements ShelfStore {
  private readonly progressBasisByHash = new Map<string, string>();
  private readonly observedAnnotationIds = new Map<string, ObservedAnnotationIds>();

  constructor(
    private readonly legacy: ShelfStore,
    private readonly data: PortableStateDataService,
  ) {}

  private async readSnapshot(hash: string): Promise<PortableBook> {
    const read = await this.data.read({ bookHash: hash });
    const book = read.book;
    await this.data.release({ readId: read.readId }).catch(() => undefined);
    if (!book) throw new Error("可移植资料库中没有这本书");
    return book;
  }

  private async localEntries(): Promise<ShelfEntry[]> {
    return this.legacy.list();
  }

  private async localEntryFor(id: string): Promise<ShelfEntry | undefined> {
    const entries = await this.localEntries();
    return entries.find((entry) => entry.id === id || entry.contentHash === id);
  }

  private async hashForId(id: string): Promise<string | null> {
    const entry = await this.localEntryFor(id);
    return entry ? hashForLocalEntry(entry) : null;
  }

  /** Merge one local row into v3 without replacing existing portable state. */
  private async mergeEntries(
    entries: readonly ShelfEntry[],
    organization?: LibraryOrganization,
    options: PortableMergeOptions = {},
  ): Promise<number> {
    const current = await this.data.snapshot();
    const missing = entries.filter((entry) => {
      const hash = hashForLocalEntry(entry);
      return hash !== null && !hasBook(current, hash);
    });
    if (missing.length === 0) return 0;
    const built = await buildMigrationBooks(missing, this.data);
    if (Object.keys(built.books).length === 0) return 0;
    await this.data.mergeValidatedState(
      stateWithBooks(built.books, organization ?? await this.data.getOrganization()),
      options,
    );
    return Object.keys(built.books).length;
  }

  private async currentProjectedEntry(hash: string): Promise<ShelfEntry> {
    const state = await this.data.snapshot();
    const local = await this.localEntryFor(hash);
    const book = state.books[hash];
    if (!book) {
      if (!local) throw new Error("资料库与本地绑定中都不存在这本书");
      return local;
    }
    return projectShelfEntry(hash, book, local);
  }

  async list(): Promise<ShelfEntry[]> {
    const [localEntries, state] = await Promise.all([this.localEntries(), this.data.snapshot()]);
    const localHashes = new Set<string>();
    for (const entry of localEntries) {
      const hash = hashForLocalEntry(entry);
      if (hash) localHashes.add(hash);
    }
    const projected = projectShelfEntriesFromState(state, localEntries)
      .filter((entry) => localHashes.has(entry.contentHash ?? entry.id));
    const localOnly = localEntries.filter((entry) => {
      const hash = hashForLocalEntry(entry);
      return hash === null || !hasBook(state, hash);
    });
    // Local-only rows include pending-hash records and they remain visible in
    // the legacy path until hashing can upgrade them.
    return [...projected, ...localOnly];
  }

  async save(input: ShelfSaveInput): Promise<ShelfSaveResult> {
    const result = await this.legacy.save(input);
    if (result.status === "saved") {
      await this.mergeEntries([result.entry]);
    } else {
      // Duplicate imports may be legacy rows that never entered v3.
      await this.mergeEntries([result.entry]);
    }
    return result;
  }

  async importPaths(paths: string[]): Promise<LinkedImportBatchResult> {
    const batch = await this.legacy.importPaths(paths);
    const records = batch.results
      .filter((item) => item.record && (item.status === "saved" || item.status === "duplicate"))
      .map((item) => item.record!);
    if (records.length > 0) await this.mergeEntries(records);
    return batch;
  }

  async importRecords(records: ShelfEntry[]): Promise<void> {
    if (records.length > 0) await this.mergeEntries(records);
  }

  async readBook(id: string): Promise<Uint8Array> {
    // Capture what this open session has actually seen. Later whole-array
    // bookmark/note calls may only tombstone ids from this observed set;
    // background-merged annotations never disappear as a stale-array side
    // effect.
    try {
      const hash = await this.hashForId(id);
      if (hash) {
        const book = await this.readSnapshot(hash);
        this.observedAnnotationIds.set(hash, {
          bookmarks: new Set(Object.keys(book.bookmarks)),
          notes: new Set(Object.keys(book.notes)),
        });
      }
    } catch {
      // Local binding/bytes remain readable; the repository may be between
      // migration attempts. Deletion safety falls back to the read snapshot.
    }
    return this.legacy.readBook(id);
  }

  async readCover(id: string): Promise<Uint8Array | null> {
    return this.legacy.readCover(id);
  }

  async setContentHash(id: string, contentHash: string): Promise<ShelfEntry> {
    const entry = await this.legacy.setContentHash(id, contentHash);
    await this.mergeEntries([entry]);
    return entry;
  }

  async updateProgress(id: string, patch: ShelfProgressPatch): Promise<ShelfEntry> {
    const entry = await this.localEntryFor(id);
    if (!entry) throw new Error("书架中没有这本书");
    const hash = hashForLocalEntry(entry);
    if (!hash) {
      // Pending-hash legacy rows cannot enter v3; keep the existing local
      // progress path until lazy hashing supplies identity.
      return this.legacy.updateProgress(id, patch);
    }
    const value = progressValueFromPatch(patch);
    const updatedAtMs = Math.max(patch.lastReadAtMs, Date.now());
    try {
      const basisId = await this.progressBasis(hash);
      const result = await this.data.write({
        basisId,
        intent: "auto",
        value,
        updatedAtMs,
      });
      if (result.nextBasisId !== basisId) this.progressBasisByHash.set(hash, result.nextBasisId);
    } catch (error) {
      if (error instanceof PortableStateError && error.code === "stale-basis") {
        this.progressBasisByHash.delete(hash);
        const retry = await this.progressBasis(hash);
        const result = await this.data.write({
          basisId: retry,
          intent: "auto",
          value,
          updatedAtMs,
        });
        if (result.nextBasisId !== retry) this.progressBasisByHash.set(hash, result.nextBasisId);
      } else {
        throw error;
      }
    }
    return this.currentProjectedEntry(hash);
  }

  private async progressBasis(hash: string): Promise<string> {
    const cached = this.progressBasisByHash.get(hash);
    if (cached) return cached;
    const read = await this.data.read({ bookHash: hash });
    const versions = read.book?.progress.versions ?? [];
    let selection: PortableAdoptSelection;
    if (versions.length === 0) {
      selection = { kind: "empty" };
    } else {
      // The shelf projection displays the latest candidate; after a successful
      // real navigation this session adopts that displayed version.
      const latest = latestVersion(versions);
      selection = latest ? { kind: "chosen", stamp: latest.stamp } : { kind: "empty" };
    }
    const adopted = await this.data.adopt({
      readId: read.readId,
      entity: { bookHash: hash, kind: "progress" },
      selection,
    });
    await this.data.release({ readId: read.readId }).catch(() => undefined);
    this.progressBasisByHash.set(hash, adopted.basisId);
    return adopted.basisId;
  }

  async markOpened(id: string): Promise<ShelfEntry> {
    return this.legacy.markOpened(id);
  }

  private async writeAnnotation<T extends "bookmark" | "note">(
    readId: string,
    entity: { bookHash: string; kind: T; id: string },
    value: BookmarkValue | NoteValue,
    updatedAtMs: number,
  ): Promise<void> {
    const current: readonly Version<BookmarkValue | NoteValue>[] = entity.kind === "bookmark"
      ? (await this.currentAnnotationVersions(entity)) as readonly Version<BookmarkValue>[]
      : (await this.currentAnnotationVersions(entity)) as readonly Version<NoteValue>[];
    const latest = latestVersion(current);
    const selection: PortableAdoptSelection = latest ? { kind: "chosen", stamp: latest.stamp } : { kind: "empty" };
    const adopted = await this.data.adopt({ readId, entity, selection });
    try {
      await this.data.write({
        basisId: adopted.basisId,
        intent: "edit",
        value,
        updatedAtMs,
      });
    } finally {
      await this.data.release({ basisId: adopted.basisId }).catch(() => undefined);
    }
  }

  private async currentAnnotationVersions(entity: {
    readonly bookHash: string;
    readonly kind: "bookmark" | "note";
    readonly id: string;
  }): Promise<readonly Version<BookmarkValue | NoteValue>[]> {
    const state = await this.data.snapshot();
    const book = state.books[entity.bookHash];
    if (!book) return [];
    if (entity.kind === "bookmark") {
      return (book.bookmarks[entity.id]?.versions ?? []) as readonly Version<BookmarkValue>[];
    }
    return (book.notes[entity.id]?.versions ?? []) as readonly Version<NoteValue>[];
  }

  async setBookmarks(id: string, bookmarks: Bookmark[]): Promise<ShelfEntry> {
    const hash = await this.hashForId(id);
    if (!hash) return this.legacy.setBookmarks(id, bookmarks);
    const read = await this.data.read({ bookHash: hash });
    if (!read.book) throw new Error("可移植资料库中没有这本书");
    const incoming = new Set(bookmarks.map((bookmark) => bookmark.id));
    const observed = this.observedAnnotationIds.get(hash)?.bookmarks
      ?? new Set(Object.keys(read.book.bookmarks));
    try {
      for (const bookmark of bookmarks) {
        const entity = { bookHash: hash, kind: "bookmark" as const, id: bookmark.id };
        const value = bookmarkValueFromBookmark(bookmark);
        if (!read.book.bookmarks[bookmark.id]) {
          await this.data.createAnnotation({
            bookHash: hash,
            kind: "bookmark",
            id: bookmark.id,
            value,
            updatedAtMs: Math.max(bookmark.createdAtMs, Date.now()),
          });
        } else {
          await this.writeAnnotation(read.readId, entity, value, Math.max(bookmark.createdAtMs, Date.now()));
        }
      }
      for (const currentId of Object.keys(read.book.bookmarks)) {
        if (!incoming.has(currentId) && observed.has(currentId)) {
          await this.data.deleteAnnotation({
            entity: { bookHash: hash, kind: "bookmark", id: currentId },
          });
        }
      }
      this.observedAnnotationIds.set(hash, {
        bookmarks: incoming,
        notes: this.observedAnnotationIds.get(hash)?.notes ?? new Set(Object.keys(read.book.notes)),
      });
    } finally {
      await this.data.release({ readId: read.readId }).catch(() => undefined);
    }
    return this.currentProjectedEntry(hash);
  }

  async setNotes(id: string, notes: ReaderNote[]): Promise<ShelfEntry> {
    const hash = await this.hashForId(id);
    if (!hash) return this.legacy.setNotes(id, notes);
    const read = await this.data.read({ bookHash: hash });
    if (!read.book) throw new Error("可移植资料库中没有这本书");
    const incoming = new Set(notes.map((note) => note.id));
    const observed = this.observedAnnotationIds.get(hash)?.notes
      ?? new Set(Object.keys(read.book.notes));
    try {
      for (const note of notes) {
        const entity = { bookHash: hash, kind: "note" as const, id: note.id };
        const value = noteValueFromNote(note);
        if (!read.book.notes[note.id]) {
          await this.data.createAnnotation({
            bookHash: hash,
            kind: "note",
            id: note.id,
            value,
            updatedAtMs: Math.max(note.createdAtMs, note.updatedAtMs ?? note.createdAtMs),
          });
        } else {
          await this.writeAnnotation(
            read.readId,
            entity,
            value,
            Math.max(note.createdAtMs, note.updatedAtMs ?? note.createdAtMs),
          );
        }
      }
      for (const currentId of Object.keys(read.book.notes)) {
        if (!incoming.has(currentId) && observed.has(currentId)) {
          await this.data.deleteAnnotation({
            entity: { bookHash: hash, kind: "note", id: currentId },
          });
        }
      }
      this.observedAnnotationIds.set(hash, {
        bookmarks: this.observedAnnotationIds.get(hash)?.bookmarks ?? new Set(Object.keys(read.book.bookmarks)),
        notes: incoming,
      });
    } finally {
      await this.data.release({ readId: read.readId }).catch(() => undefined);
    }
    return this.currentProjectedEntry(hash);
  }

  async relink(id: string, sourcePath: string): Promise<ShelfEntry> {
    const entry = await this.legacy.relink(id, sourcePath);
    await this.mergeEntries([entry]);
    return entry;
  }

  async replacePortableRecords(records: LibraryRecord[], organization?: LibraryOrganization): Promise<ShelfEntry[]> {
    await this.legacy.replacePortableRecords(records);
    const current = await this.data.snapshot();
    const entries = records
      .map(recordToLegacyEntry)
      .filter((entry) => {
        const hash = hashForLocalEntry(entry);
        return hash !== null && !hasBook(current, hash);
      });
    const built = await buildMigrationBooks(entries, this.data);
    // Always run through mergeValidatedState so an archive import never
    // replaces or re-imports a progress entity that already exists in v3;
    // metadata for new books and organization still commit in one transaction.
    await this.data.mergeValidatedState(
      stateWithBooks(built.books, organization ?? current.organization),
      { migrationMark: "legacy-json-import-v1" },
    );
    return this.list();
  }

  async readThumbnail(contentHash: string, mime?: string): Promise<ThumbnailAsset | null> {
    return this.legacy.readThumbnail(contentHash, mime);
  }

  async writeThumbnail(contentHash: string, asset: ThumbnailAsset): Promise<void> {
    return this.legacy.writeThumbnail(contentHash, asset);
  }

  async deleteThumbnail(contentHash: string): Promise<void> {
    return this.legacy.deleteThumbnail(contentHash);
  }

  async deleteBook(id: string): Promise<void> {
    // Local binding/visibility only. The portable record and any incoming
    // tombstones stay intact; if a future sync re-creates the binding the
    // book can reappear from the same record.
    return this.legacy.deleteBook(id);
  }

  async deleteBooks(ids: string[]): Promise<void> {
    if (this.legacy.deleteBooks) return this.legacy.deleteBooks(ids);
    for (const id of ids) await this.legacy.deleteBook(id);
  }

  async getOrganization(): Promise<LibraryOrganization> {
    return this.data.getOrganization();
  }

  async applyOrganization(command: Parameters<ShelfStore["applyOrganization"]>[0]): Promise<LibraryOrganization> {
    return this.data.applyOrganization(command);
  }

  async mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization> {
    return this.data.mergeOrganization(incoming);
  }
}
