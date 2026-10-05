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
  NoteEditContext,
  PortableProgressSelection,
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
import type { ArchiveClient } from "../../core/selectiveArchive";

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
    }, patch.chapterPath ?? null),
    progressPctHint: patch.progressPct,
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

interface ProgressReadingSession {
  readId: string;
  basisId: string;
  chosenStamp: Stamp | null;
  invalid: boolean;
}

export class PortableShelfStore implements ShelfStore {
  private readonly progressSessions = new Map<string, ProgressReadingSession>();
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
    if (!local) {
      // An archive-imported "waiting for source" row has no byte binding yet.
      return { ...projectShelfEntry(hash, book, undefined), id: hash, available: false };
    }
    return projectShelfEntry(hash, book, local);
  }

  async list(): Promise<ShelfEntry[]> {
    const [localEntries, state, visibleHashes] = await Promise.all([
      this.localEntries(),
      this.data.snapshot(),
      this.data.listLocalVisibleHashes().catch(() => [] as readonly string[]),
    ]);
    const visible = new Set(visibleHashes);
    const localHashes = new Set<string>();
    for (const entry of localEntries) {
      const hash = hashForLocalEntry(entry);
      if (hash) localHashes.add(hash);
    }
    const projected = projectShelfEntriesFromState(state, localEntries)
      .filter((entry) => {
        const hash = entry.contentHash ?? entry.id;
        return localHashes.has(hash) || visible.has(hash);
      })
      .map((entry) => {
        const hash = entry.contentHash ?? entry.id;
        if (!localHashes.has(hash) && visible.has(hash)) {
          return { ...entry, id: hash, fileSize: 0, coverMime: "", available: false } as ShelfEntry;
        }
        return entry;
      });
    const localOnly = localEntries.filter((entry) => {
      const hash = hashForLocalEntry(entry);
      return hash === null || !hasBook(state, hash);
    });
    // Local-only rows include pending-hash records and they remain visible in
    // the legacy path until hashing can supply identity.
    return [...projected, ...localOnly];
  }

  async save(input: ShelfSaveInput): Promise<ShelfSaveResult> {
    const result = await this.legacy.save(input);
    // Duplicate imports may be legacy rows that never entered v3.
    await this.mergeEntries([result.entry]);
    const hash = hashForLocalEntry(result.entry);
    if (!hash) return result;
    return { ...result, entry: await this.currentProjectedEntry(hash) };
  }

  async importPaths(paths: string[]): Promise<LinkedImportBatchResult> {
    const batch = await this.legacy.importPaths(paths);
    const records = batch.results
      .filter((item) => item.record && (item.status === "saved" || item.status === "duplicate"))
      .map((item) => item.record!);
    if (records.length > 0) await this.mergeEntries(records);
    const projected = new Map<string, ShelfEntry>();
    for (const record of records) {
      const hash = hashForLocalEntry(record);
      if (!hash || projected.has(hash)) continue;
      projected.set(hash, await this.currentProjectedEntry(hash));
    }
    return {
      results: batch.results.map((item) => {
        if (!item.record) return item;
        const hash = hashForLocalEntry(item.record);
        const entry = hash ? projected.get(hash) : undefined;
        return entry ? { ...item, record: entry } : item;
      }),
    };
  }

  async importRecords(records: ShelfEntry[]): Promise<ShelfEntry[]> {
    if (records.length === 0) return [];
    await this.mergeEntries(records);
    const state = await this.data.snapshot();
    return records.map((record) => {
      const hash = hashForLocalEntry(record);
      return hash ? projectShelfEntry(hash, state.books[hash], record) : record;
    });
  }

  private async observeBookAnnotations(id: string): Promise<void> {
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
  }

  async readBook(id: string): Promise<Uint8Array> {
    await this.observeBookAnnotations(id);
    return this.legacy.readBook(id);
  }

  async openArchive(id: string): Promise<ArchiveClient> {
    await this.observeBookAnnotations(id);
    const create = this.legacy.openArchive?.bind(this.legacy);
    if (!create) throw new Error("当前书库后端不支持按需归档读取");
    return create(id);
  }

  async readCover(id: string): Promise<Uint8Array | null> {
    return this.legacy.readCover(id);
  }

  async setContentHash(id: string, contentHash: string): Promise<ShelfEntry> {
    const entry = await this.legacy.setContentHash(id, contentHash);
    await this.mergeEntries([entry]);
    const hash = hashForLocalEntry(entry);
    if (!hash) return entry;
    return this.currentProjectedEntry(hash);
  }

  /**
   * B3: adopt the user-selected progress version (or explicit empty snapshot)
   * against the same repository read that the App is using for restore. The
   * readId/basisId stay paired until close or a stale invalidation.
   */
  async beginProgressSession(id: string, selection: PortableProgressSelection): Promise<void> {
    const entry = await this.localEntryFor(id);
    if (!entry) throw new Error("书架中没有这本书");
    const hash = hashForLocalEntry(entry);
    if (!hash) return;
    await this.closeProgressSession(id).catch(() => undefined);
    const read = await this.data.read({ bookHash: hash });
    if (!read.book) {
      await this.data.release({ readId: read.readId }).catch(() => undefined);
      throw new Error("可移植资料库中没有这本书");
    }
    try {
      const adopted = await this.data.adopt({
        readId: read.readId,
        entity: { bookHash: hash, kind: "progress" },
        selection,
      });
      this.progressSessions.set(hash, {
        readId: read.readId,
        basisId: adopted.basisId,
        chosenStamp: selection.kind === "chosen" ? selection.stamp : null,
        invalid: false,
      });
    } catch (error) {
      await this.data.release({ readId: read.readId }).catch(() => undefined);
      throw error;
    }
  }

  async closeProgressSession(id: string): Promise<void> {
    const entry = await this.localEntryFor(id);
    const hash = hashForLocalEntry(entry ?? { id, contentHash: undefined });
    if (!hash) return;
    this.progressSessions.delete(hash);
    this.observedAnnotationIds.delete(hash);
    await this.data.release({ bookHash: hash }).catch(() => undefined);
  }

  /**
   * A stale sample cannot silently adopt the merged latest version. Re-adopt
   * only the last version this session actually displayed/wrote; if that event
   * is no longer a trustworthy frontier, mark the session invalid and require
   * a real reopen/selection instead of confirming a background branch.
   */
  private async rebindProgressSessionAfterStale(
    hash: string,
    session: ProgressReadingSession,
  ): Promise<void> {
    await this.data.release({ readId: session.readId }).catch(() => undefined);
    const read = await this.data.read({ bookHash: hash });
    if (!read.book) {
      await this.data.release({ readId: read.readId }).catch(() => undefined);
      session.invalid = true;
      return;
    }
    const selection: PortableProgressSelection = session.chosenStamp
      ? { kind: "chosen", stamp: session.chosenStamp }
      : { kind: "empty" };
    try {
      const adopted = await this.data.adopt({
        readId: read.readId,
        entity: { bookHash: hash, kind: "progress" },
        selection,
      });
      session.readId = read.readId;
      session.basisId = adopted.basisId;
      session.invalid = false;
    } catch (error) {
      await this.data.release({ readId: read.readId }).catch(() => undefined);
      if (error instanceof PortableStateError &&
          (error.code === "stale-basis" || error.code === "stale-choice" || error.code === "invalid-choice")) {
        session.invalid = true;
        return;
      }
      throw error;
    }
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
    const session = this.progressSessions.get(hash);
    if (!session) throw new Error("阅读进度会话未开始");
    if (session.invalid) {
      throw new PortableStateError("stale-basis", "进度基线已过期，请关闭并重新打开书籍");
    }

    const value = progressValueFromPatch(patch);
    const updatedAtMs = Math.max(patch.lastReadAtMs, Date.now());
    try {
      const basisId = session.basisId;
      const result = await this.data.write({
        basisId,
        intent: "auto",
        value,
        updatedAtMs,
      });
      session.basisId = result.nextBasisId;
      if (result.status === "written") {
        // The projection can include a background merge after this write.
        // Keep the version we actually wrote as the displayed session basis.
        const written = latestVersion(result.state.versions as readonly Version<ProgressValue>[]);
        if (written) session.chosenStamp = written.stamp;
      }
      return this.currentProjectedEntry(hash);
    } catch (error) {
      if (
        error instanceof PortableStateError &&
        (error.code === "stale-basis" || error.code === "stale-choice")
      ) {
        await this.data.release({ basisId: session.basisId }).catch(() => undefined);
        await this.rebindProgressSessionAfterStale(hash, session);
        return this.currentProjectedEntry(hash);
      }
      throw error;
    }
  }

  async markOpened(id: string): Promise<ShelfEntry> {
    const entry = await this.legacy.markOpened(id);
    const hash = hashForLocalEntry(entry);
    if (!hash) return entry;
    return this.currentProjectedEntry(hash);
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

  async createBookmark(id: string, bookmark: Bookmark): Promise<ShelfEntry> {
    const hash = await this.hashForId(id);
    if (!hash) {
      const current = await this.localEntryFor(id);
      return this.legacy.setBookmarks(id, [...(current?.bookmarks ?? []), bookmark]);
    }
    const created = await this.data.createAnnotation({
      bookHash: hash,
      kind: "bookmark",
      id: bookmark.id,
      value: bookmarkValueFromBookmark(bookmark),
      updatedAtMs: Math.max(bookmark.createdAtMs, Date.now()),
    });
    await this.data.release({ basisId: created.nextBasisId }).catch(() => undefined);
    return this.currentProjectedEntry(hash);
  }

  async deleteBookmark(id: string, bookmarkId: string): Promise<ShelfEntry> {
    const hash = await this.hashForId(id);
    if (!hash) {
      const current = await this.localEntryFor(id);
      return this.legacy.setBookmarks(id, (current?.bookmarks ?? []).filter((bookmark) => bookmark.id !== bookmarkId));
    }
    await this.data.deleteAnnotation({ entity: { bookHash: hash, kind: "bookmark", id: bookmarkId } });
    return this.currentProjectedEntry(hash);
  }

  async createNote(id: string, note: ReaderNote): Promise<ShelfEntry> {
    const hash = await this.hashForId(id);
    if (!hash) {
      const current = await this.localEntryFor(id);
      return this.legacy.setNotes(id, [...(current?.notes ?? []), note]);
    }
    const created = await this.data.createAnnotation({
      bookHash: hash,
      kind: "note",
      id: note.id,
      value: noteValueFromNote(note),
      updatedAtMs: Math.max(note.createdAtMs, note.updatedAtMs ?? note.createdAtMs),
    });
    await this.data.release({ basisId: created.nextBasisId }).catch(() => undefined);
    return this.currentProjectedEntry(hash);
  }

  /** B2: read/adopt the displayed note version once and keep the context. */
  async beginNoteEdit(
    id: string,
    noteId: string,
    chosenStamp: Stamp,
  ): Promise<NoteEditContext | null> {
    const hash = await this.hashForId(id);
    if (!hash) return null;
    const read = await this.data.read({ bookHash: hash });
    if (!read.book) {
      await this.data.release({ readId: read.readId }).catch(() => undefined);
      throw new Error("可移植资料库中没有这本书");
    }
    const entity = { bookHash: hash, kind: "note" as const, id: noteId };
    try {
      const adopted = await this.data.adopt({
        readId: read.readId,
        entity,
        selection: { kind: "chosen", stamp: chosenStamp },
      });
      return { readId: read.readId, basisId: adopted.basisId };
    } catch (error) {
      await this.data.release({ readId: read.readId }).catch(() => undefined);
      throw error;
    }
  }

  /** B2: write through the editor's adopted basis only. */
  async writeNoteEdit(id: string, note: ReaderNote, context: NoteEditContext): Promise<ShelfEntry> {
    const hash = await this.hashForId(id);
    if (!hash) throw new Error("笔记编辑上下文缺少内容指纹");
    const result = await this.data.write({
      basisId: context.basisId,
      intent: "edit",
      value: noteValueFromNote(note),
      updatedAtMs: Math.max(note.createdAtMs, note.updatedAtMs ?? note.createdAtMs),
    });
    if (result.nextBasisId !== context.basisId) context.basisId = result.nextBasisId;
    return this.currentProjectedEntry(hash);
  }

  async endNoteEdit(context: NoteEditContext): Promise<void> {
    await this.data.release({ basisId: context.basisId }).catch(() => undefined);
    await this.data.release({ readId: context.readId }).catch(() => undefined);
  }

  async deleteNote(id: string, noteId: string): Promise<ShelfEntry> {
    const hash = await this.hashForId(id);
    if (!hash) {
      const current = await this.localEntryFor(id);
      return this.legacy.setNotes(id, (current?.notes ?? []).filter((note) => note.id !== noteId));
    }
    await this.data.deleteAnnotation({ entity: { bookHash: hash, kind: "note", id: noteId } });
    return this.currentProjectedEntry(hash);
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
    // R4 short fix: relinking returns the v3 projection for this hash, so a
    // rebound book never opens with the legacy JSON's stale position.
    const hash = hashForLocalEntry(entry);
    if (!hash) return entry;
    return this.currentProjectedEntry(hash);
  }

  async replacePortableRecords(records: LibraryRecord[], organization?: LibraryOrganization): Promise<ShelfEntry[]> {
    // R3: the repository merges records, missing entities, organization and
    // local waiting-for-source visibility in one transaction. Do not touch the
    // legacy whole-record array first.
    await this.data.mergeLegacyRecords({ records, ...(organization ? { organization } : {}) });
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
    const hash = await this.hashForId(id);
    await this.legacy.deleteBook(id);
    if (hash) await this.data.setLocalVisible(hash, false).catch(() => undefined);
  }

  async deleteBooks(ids: string[]): Promise<void> {
    const hashes = (await Promise.all(ids.map((id) => this.hashForId(id)))).filter(
      (hash): hash is string => hash !== null,
    );
    if (this.legacy.deleteBooks) {
      await this.legacy.deleteBooks(ids);
    } else {
      for (const id of ids) await this.legacy.deleteBook(id);
    }
    for (const hash of hashes) await this.data.setLocalVisible(hash, false).catch(() => undefined);
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
