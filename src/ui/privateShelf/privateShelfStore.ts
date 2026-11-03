/**
 * ER-0044 private shelf store. The portable facade (progress sessions,
 * annotations, organization) is reused unchanged; only its two backends are
 * replaced by the token-scoped private routes. Nothing here writes to the
 * library repository, its thumbnail cache, or cloud-sync change notices.
 */
import { createNativeArchiveClient, type ArchiveInvoke } from "../../platform/nativeArchiveClient";
import { privateShelfError, type PrivateShelfNative, type PrivateShelfOperation } from "../../platform/privateShelf";
import type { AndroidDocumentSelection, AndroidImportBatchResult, AndroidImportItemResult } from "../../platform/androidNativeBridge";
import type { ArchiveClient } from "../../core/selectiveArchive";
import type { EntityRef } from "../../core/portableState/portable-write-core";
import type { PortableBook, PortableStateV3 } from "../../core/portableState/portable-state-types";
import { portableSchemaVersion } from "../../core/portableState/portable-state-types";
import type { Stamp } from "../../core/portableState/portable-register-core";
import type { LibraryOrganization, OrganizationCommand } from "../libraryOrganization";
import type { LinkedImportBatchResult, LinkedImportItemResult, PortableRecordsImportResult, ShelfEntry, ShelfSaveResult, ShelfStore } from "../shelf";
import type { ThumbnailAsset } from "../thumbnail";
import type { PortableStateDataService, PortableLegacyImportResult } from "../portableState/dataService";
import {
  PortableStateError,
  type PortableAdoptSelection,
  type PortableDeleteResult,
  type PortableReadResult,
  type PortableWriteIntent,
  type PortableWriteResult,
} from "../portableState/service";
import { nativeError } from "../portableState/tauriService";
import { PortableShelfStore } from "../portableState/shelfStoreAdapter";
import type { ProgressRuntimeStatus } from "../portableState/progressRuntimeGate";

/** The part of the native ShelfProjection this store reads. */
interface PrivateProjection {
  readonly books: ReadonlyArray<{
    readonly bookHash: string;
    readonly metadata: { readonly title: string; readonly creator: string; readonly language?: string; readonly fileName: string; readonly addedAtMs: number };
  }>;
  readonly organization: LibraryOrganization;
}

type EntityKind = EntityRef["kind"];

function unsupported(what: string): never {
  throw new Error(`隐私书架不支持${what}`);
}

/** One unlocked session's route. A revoked token surfaces as code `locked`. */
export class PrivateShelfRoute {
  constructor(
    private readonly native: PrivateShelfNative,
    readonly sessionId: string,
    private readonly onLocked: () => void,
  ) {}

  async call<T>(operation: PrivateShelfOperation): Promise<T> {
    try {
      return await this.native.library<T>(this.sessionId, operation);
    } catch (error) {
      const converted = privateShelfError(error);
      if (converted.code === "locked") this.onLocked();
      // Repository codes (stale-basis…) become PortableStateError for the facade.
      try {
        nativeError({ code: converted.code, message: converted.message });
      } catch (portable) {
        if (portable instanceof PortableStateError) throw portable;
      }
      throw converted;
    }
  }

  async bytes(read: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    try {
      return await read();
    } catch (error) {
      const converted = privateShelfError(error);
      if (converted.code === "locked") this.onLocked();
      throw converted;
    }
  }

  archiveRead(archiveId: string, entryIndex: number, offset: number): Promise<ArrayBuffer> {
    return this.bytes(() => this.native.archiveRead(this.sessionId, archiveId, entryIndex, offset));
  }

  cover(bookHash: string): Promise<ArrayBuffer> {
    return this.bytes(() => this.native.cover(this.sessionId, bookHash));
  }
}

/** The portable command surface over private routes. Writes never notify cloud sync. */
export class PrivatePortableData implements PortableStateDataService {
  /** The private wire writes by entity kind; the facade writes by basis. */
  private readonly basisKinds = new Map<string, EntityKind>();

  constructor(private readonly route: PrivateShelfRoute) {}

  read(input: { readonly bookHash: string }): Promise<PortableReadResult> {
    return this.route.call({ kind: "read", bookHash: input.bookHash });
  }

  async adopt(input: { readonly readId: string; readonly entity: EntityRef; readonly selection: PortableAdoptSelection }): Promise<{ readonly basisId: string }> {
    const result = await this.route.call<{ basisId: string }>({ kind: "adopt", readId: input.readId, entity: input.entity, selection: input.selection });
    this.basisKinds.set(result.basisId, input.entity.kind);
    return result;
  }

  async write(input: { readonly basisId: string; readonly intent: PortableWriteIntent; readonly value: unknown; readonly updatedAtMs: number }): Promise<PortableWriteResult> {
    const kind = this.basisKinds.get(input.basisId);
    if (!kind) throw new PortableStateError("stale-basis", "隐私书架的写入基线已失效");
    const op = kind === "progress" ? "writeProgress" : kind === "bookmark" ? "writeBookmark" : "writeNote";
    const result = await this.route.call<PortableWriteResult>({
      kind: op, basisId: input.basisId, intent: input.intent, value: input.value, updatedAtMs: input.updatedAtMs,
    });
    this.basisKinds.set(result.nextBasisId, kind);
    return result;
  }

  async createAnnotation(input: { readonly bookHash: string; readonly kind: "bookmark" | "note"; readonly id: string; readonly value: unknown; readonly updatedAtMs: number }): Promise<PortableWriteResult> {
    const result = await this.route.call<PortableWriteResult>({
      kind: input.kind === "bookmark" ? "createBookmark" : "createNote",
      bookHash: input.bookHash, id: input.id, value: input.value, updatedAtMs: input.updatedAtMs,
    });
    this.basisKinds.set(result.nextBasisId, input.kind);
    return result;
  }

  deleteAnnotation(input: { readonly entity: EntityRef }): Promise<PortableDeleteResult> {
    const entity = input.entity;
    if (entity.kind === "progress") unsupported("删除阅读进度");
    return this.route.call({ kind: entity.kind === "bookmark" ? "deleteBookmark" : "deleteNote", bookHash: entity.bookHash, id: entity.id });
  }

  async release(input: { readonly basisId?: string; readonly readId?: string; readonly bookHash?: string }): Promise<null> {
    if (input.basisId !== undefined) {
      this.basisKinds.delete(input.basisId);
      return this.route.call({ kind: "releaseBasis", basisId: input.basisId });
    }
    if (input.readId !== undefined) return this.route.call({ kind: "releaseRead", readId: input.readId });
    if (input.bookHash !== undefined) return this.route.call({ kind: "releaseBook", bookHash: input.bookHash });
    return null;
  }

  async runtimeStatus(): Promise<ProgressRuntimeStatus> {
    return { repositoryGeneration: `private:${this.route.sessionId}`, repositoryReady: true };
  }

  list(): Promise<PrivateProjection> {
    return this.route.call({ kind: "list" });
  }

  async bookSnapshot(bookHash: string): Promise<PortableBook | undefined> {
    const read = await this.read({ bookHash });
    await this.release({ readId: read.readId }).catch(() => undefined);
    return read.book ?? undefined;
  }

  /** No whole-state command exists here: one read per book (private shelves stay small). */
  async snapshot(): Promise<PortableStateV3> {
    const projection = await this.list();
    const books: Record<string, PortableBook> = {};
    for (const { bookHash } of projection.books) {
      const book = await this.bookSnapshot(bookHash);
      if (book) books[bookHash] = book;
    }
    return { schemaVersion: portableSchemaVersion(books), books, organization: projection.organization };
  }

  async getOrganization(): Promise<LibraryOrganization> {
    return (await this.list()).organization;
  }

  applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization> {
    return this.route.call({ kind: "organize", command });
  }

  async listLocalVisibleHashes(): Promise<readonly string[]> {
    return [];
  }

  async setLocalVisible(): Promise<void> {
    // Visibility rows belong to archive imports, which the private shelf never runs.
  }

  mergeValidatedState(): Promise<PortableStateV3> { return unsupported("合并资料"); }
  mergeLegacyRecords(): Promise<PortableLegacyImportResult> { return unsupported("导入旧存档"); }
  mergeOrganization(): Promise<LibraryOrganization> { return unsupported("合并整理"); }
  reserveStamps(): Promise<Stamp> { return unsupported("预留版本号"); }
}

function entryFromProjection(book: PrivateProjection["books"][number]): ShelfEntry {
  const meta = book.metadata;
  return {
    id: book.bookHash,
    contentHash: book.bookHash,
    title: meta.title,
    creator: meta.creator,
    ...(meta.language ? { language: meta.language } : {}),
    fileName: meta.fileName,
    fileSize: 0,
    coverMime: "",
    addedAtMs: meta.addedAtMs,
    lastReadAtMs: 0,
    spineIndex: 0,
    page: 0,
    progressPct: 0,
    anchorIndex: null,
    anchorRatio: null,
    isNew: false,
    available: true,
  };
}

/**
 * The byte/binding side the facade calls "legacy": sources, covers and
 * thumbnails. Derived thumbnails stay in this object's memory.
 */
export class PrivateLocalStore implements ShelfStore {
  readonly archiveOnly = true;
  private readonly thumbnails = new Map<string, ThumbnailAsset>();

  constructor(private readonly route: PrivateShelfRoute, private readonly data: PrivatePortableData) {}

  async list(): Promise<ShelfEntry[]> {
    return (await this.data.list()).books.map(entryFromProjection);
  }

  private async entry(hash: string): Promise<ShelfEntry | undefined> {
    return (await this.list()).find((entry) => entry.id === hash);
  }

  private async importOne(source: { kind: "path"; path: string } | { kind: "document"; uri: string }) {
    const result = await this.route.call<{ bookHash: string; duplicate: boolean }>({ kind: "import", source });
    return { ...result, record: await this.entry(result.bookHash) };
  }

  async importPaths(paths: string[]): Promise<LinkedImportBatchResult> {
    const results: LinkedImportItemResult[] = [];
    for (const [inputIndex, path] of paths.entries()) {
      try {
        const { bookHash, duplicate, record } = await this.importOne({ kind: "path", path });
        results.push({ inputIndex, status: duplicate ? "duplicate" : "saved", contentHash: bookHash, ...(record ? { record } : {}) });
      } catch (error) {
        if ((error as { code?: unknown }).code === "locked") throw error;
        results.push({ inputIndex, status: "failed", error: String((error as Error).message ?? error) });
      }
    }
    return { results };
  }

  async importDocuments(documents: AndroidDocumentSelection[], onProgress: (completed: number, total: number) => void): Promise<AndroidImportBatchResult> {
    const results: AndroidImportItemResult[] = [];
    for (const [inputIndex, document] of documents.entries()) {
      try {
        const { bookHash, duplicate, record } = await this.importOne({ kind: "document", uri: document.uri });
        results.push({ inputIndex, status: duplicate ? "duplicate" : "saved", contentHash: bookHash, record: record ?? null, error: null });
      } catch (error) {
        if ((error as { code?: unknown }).code === "locked") throw error;
        results.push({ inputIndex, status: "failed", contentHash: null, record: null, error: String((error as Error).message ?? error) });
      }
      onProgress(inputIndex + 1, documents.length);
    }
    return { results };
  }

  async openArchive(id: string, textEncoding?: string): Promise<ArchiveClient> {
    // The archive client speaks the library's four archive commands; map them onto this session.
    const invoke: ArchiveInvoke = async <T,>(command: string, args: Record<string, unknown>): Promise<T> => {
      switch (command) {
        case "linked_library_archive_open":
          return this.route.call<T>({ kind: "archiveOpen", bookHash: args.contentHash, textEncoding: args.textEncoding ?? null });
        case "linked_library_archive_directory":
          return this.route.call<T>({ kind: "archiveDirectory", archiveId: args.sessionId, start: args.start });
        case "linked_library_archive_read":
          return await this.route.archiveRead(String(args.sessionId), Number(args.entryIndex), Number(args.offset)) as T;
        case "linked_library_archive_close":
          return this.route.call<T>({ kind: "archiveClose", archiveId: args.sessionId });
        default:
          throw new Error(`隐私书架不支持归档命令 ${command}`);
      }
    };
    return createNativeArchiveClient(id, invoke, undefined, textEncoding);
  }

  async readBook(): Promise<Uint8Array> {
    return unsupported("整本读取");
  }

  async readCover(id: string): Promise<Uint8Array | null> {
    const bytes = new Uint8Array(await this.route.cover(id));
    return bytes.byteLength > 0 ? bytes : null;
  }

  async markOpened(id: string): Promise<ShelfEntry> {
    const entry = await this.entry(id);
    if (!entry) throw new Error("隐私书架中没有这本书");
    return entry;
  }

  async readThumbnail(contentHash: string): Promise<ThumbnailAsset | null> {
    return this.thumbnails.get(contentHash) ?? null;
  }

  async writeThumbnail(contentHash: string, asset: ThumbnailAsset): Promise<void> {
    this.thumbnails.set(contentHash, asset);
  }

  async deleteThumbnail(contentHash: string): Promise<void> {
    this.thumbnails.delete(contentHash);
  }

  async deleteBook(id: string): Promise<void> {
    await this.route.call({ kind: "delete", bookHash: id });
    this.thumbnails.delete(id);
  }

  async deleteBooks(ids: string[]): Promise<void> {
    for (const id of ids) await this.deleteBook(id);
  }

  getOrganization(): Promise<LibraryOrganization> {
    return this.data.getOrganization();
  }

  applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization> {
    return this.data.applyOrganization(command);
  }

  runtimeStatus(): Promise<ProgressRuntimeStatus> {
    return this.data.runtimeStatus();
  }

  clear(): void {
    this.thumbnails.clear();
  }

  save(): Promise<ShelfSaveResult> { return unsupported("浏览器导入"); }
  setContentHash(): Promise<ShelfEntry> { return unsupported("补录内容指纹"); }
  updateProgress(): Promise<ShelfEntry> { return unsupported("旧版进度写入"); }
  setBookmarks(): Promise<ShelfEntry> { return unsupported("旧版书签写入"); }
  setNotes(): Promise<ShelfEntry> { return unsupported("旧版笔记写入"); }
  relink(): Promise<ShelfEntry> { return unsupported("重新关联原书"); }
  replacePortableRecords(): Promise<PortableRecordsImportResult> { return unsupported("导入旧存档"); }
  mergeOrganization(): Promise<LibraryOrganization> { return unsupported("合并整理"); }
}

/** The facade the shelf and reader use while the private shelf is open. */
export class PrivateShelfStore extends PortableShelfStore {
  readonly archiveOnly = true;

  constructor(private readonly local: PrivateLocalStore, data: PrivatePortableData) {
    super(local, data);
  }

  importDocuments(documents: AndroidDocumentSelection[], onProgress: (completed: number, total: number) => void): Promise<AndroidImportBatchResult> {
    return this.local.importDocuments(documents, onProgress);
  }

  clear(): void {
    this.local.clear();
  }
}

export function createPrivateShelfStore(native: PrivateShelfNative, sessionId: string, onLocked: () => void): PrivateShelfStore {
  const route = new PrivateShelfRoute(native, sessionId, onLocked);
  const data = new PrivatePortableData(route);
  return new PrivateShelfStore(new PrivateLocalStore(route, data), data);
}
