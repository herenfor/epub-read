// Shelf storage implementations: IndexedDB and the native linked library.

import { invoke } from "@tauri-apps/api/core";
import { createNativeArchiveClient as createNativeLinkedArchiveClient } from "../../platform/nativeArchiveClient";
import { applyDirectoryPlacementBatch } from "../folderImport/placementBatch";
import { hasDuplicateReaderNoteIds, normalizeReaderNotes } from "../notes";
import { applyCommand, emptyOrganization, mergeIntoEnvelope, validateEnvelope, validateOrganization } from "../libraryOrganization";
import type { ArchiveClient } from "../../core/selectiveArchive";
import type { LibraryRecord } from "../libraryArchive";
import type { ThumbnailAsset } from "../thumbnail";
import type { DirectoryPlacementBatch, DirectoryPlacementBatchResult } from "../folderImport/placementBatch";
import type { ReaderNote } from "../notes";
import type { LibraryOrganization, OrganizationCommand, OrganizationEnvelope } from "../libraryOrganization";
import type { ShelfStore, ShelfEntry, ShelfSaveInput, ShelfSaveResult, LinkedImportBatchResult, ShelfProgressPatch, Bookmark, PortableRecordsImportResult } from "./types";
import { normalizeBookmarkTextAnchor, normalizeShelfEntryTextAnchors } from "./entries";

import { IS_AI_EDITION } from "../../config/edition";

// Keep the optional module out of the Core import graph, including dynamic chunks.
const cleanupBrowserPreparation = IS_AI_EDITION
  ? async (book: string) => (await import("../../features/ai/preparation/browserStore")).deleteBrowserPreparationForBook(book)
  : null;


export const DB_NAME = "epub-reader-shelf";
export const DB_VERSION = 3;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("covers")) {
        db.createObjectStore("covers", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("organization")) {
        db.createObjectStore("organization");
      }
      // CP-I: both legacy and portable state share this database/version. The
      // portable opener must not rely on a later version bump to create them.
      if (!db.objectStoreNames.contains("portable_books")) {
        db.createObjectStore("portable_books", { keyPath: "hash" });
      }
      if (!db.objectStoreNames.contains("portable_progress")) {
        db.createObjectStore("portable_progress", { keyPath: "hash" });
      }
      if (!db.objectStoreNames.contains("portable_annotations")) {
        const store = db.createObjectStore("portable_annotations", { keyPath: ["hash", "kind", "id"] });
        store.createIndex("byBook", "hash");
      }
      if (!db.objectStoreNames.contains("portable_meta")) {
        db.createObjectStore("portable_meta", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("无法打开书架数据库"));
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("书架数据库事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("书架数据库事务中止"));
  });
}

export function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("书架数据库请求失败"));
  });
}

export function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((b) => new Uint8Array(b));
}

export class IndexedDbShelfStore implements ShelfStore {
  async list(): Promise<ShelfEntry[]> {
    const db = await openDb();
    try {
      const all = await reqAsPromise(
        db.transaction("meta", "readonly").objectStore("meta").getAll()
      );
      return (all as ShelfEntry[])
        .filter((e) => e && typeof e.id === "string")
        .map(normalizeShelfEntryTextAnchors);
    } finally {
      db.close();
    }
  }

  async save(input: ShelfSaveInput): Promise<ShelfSaveResult> {
    const db = await openDb();
    try {
      const all = (await reqAsPromise(
        db.transaction("meta", "readonly").objectStore("meta").getAll()
      )) as ShelfEntry[];
      const contentHash = input.entry.contentHash;
      const duplicate = contentHash
        ? all.find((entry) => entry.contentHash === contentHash)
        : undefined;
      if (duplicate && duplicate.available !== false) {
        return { status: "duplicate", entry: duplicate };
      }
      const existing = all.find((entry) => entry.id === input.entry.id);
      if (existing && existing.contentHash !== contentHash) {
        throw new Error("书本 ID 冲突，已拒绝覆盖现有书籍");
      }
      const entry: ShelfEntry = {
        id: input.entry.id,
        title: input.entry.title,
        creator: input.entry.creator,
        language: existing?.language ?? input.entry.language,
        fileName: input.entry.fileName,
        fileSize: input.entry.fileSize,
        coverMime:
          input.coverMime ??
          input.entry.coverMime ??
          existing?.coverMime ??
          "",
        addedAtMs: existing?.addedAtMs ?? input.entry.addedAtMs ?? Date.now(),
        // Import time is not a reading event.  Recent sorting falls back to
        // addedAtMs until the first stable position is written.
        lastReadAtMs: existing?.lastReadAtMs ?? input.entry.lastReadAtMs ?? 0,
        spineIndex: existing?.spineIndex ?? input.entry.spineIndex ?? 0,
        page: existing?.page ?? input.entry.page ?? 0,
        progressPct: existing?.progressPct ?? input.entry.progressPct ?? 0,
        anchorIndex: existing?.anchorIndex ?? input.entry.anchorIndex ?? null,
        anchorRatio: existing?.anchorRatio ?? input.entry.anchorRatio ?? null,
        anchorTextOffset: existing?.anchorTextOffset ?? input.entry.anchorTextOffset ?? null,
        anchorTextSnippet: existing?.anchorTextSnippet ?? input.entry.anchorTextSnippet ?? null,
        mediaAnchor: existing?.mediaAnchor ?? input.entry.mediaAnchor ?? null,
        contentHash:
          contentHash ??
          (/^[a-f0-9]{64}$/i.test(input.entry.id) ? input.entry.id : undefined),
        isNew: existing?.isNew ?? input.entry.isNew ?? true,
        bookmarks: (existing?.bookmarks ?? input.entry.bookmarks ?? []).map(normalizeBookmarkTextAnchor),
        notes: normalizeReaderNotes(existing?.notes ?? input.entry.notes),
        available: true,
      };
      const tx = db.transaction(["meta", "books", "covers"], "readwrite");
      tx.objectStore("meta").put(entry);
      tx.objectStore("books").put({
        id: entry.id,
        bytes: new Blob([input.bytes.slice().buffer as ArrayBuffer]),
      });
      if (input.coverBytes && input.coverBytes.byteLength > 0) {
        tx.objectStore("covers").put({
          id: entry.id,
          mime: entry.coverMime,
          bytes: new Blob([input.coverBytes.slice().buffer as ArrayBuffer]),
        });
      } else if (!existing) {
        tx.objectStore("covers").delete(entry.id);
      }
      await txDone(tx);
      return { status: "saved", entry };
    } finally {
      db.close();
    }
  }

  async importPaths(): Promise<LinkedImportBatchResult> {
    throw new Error("浏览器预览无法持久引用本地路径，请使用文件选择器导入测试副本");
  }

  async readBook(id: string): Promise<Uint8Array> {
    const db = await openDb();
    try {
      const row = (await reqAsPromise(
        db.transaction("books", "readonly").objectStore("books").get(id)
      )) as { bytes?: Blob } | undefined;
      if (!row?.bytes) throw new Error("书架中没有这本书的数据");
      return await blobToBytes(row.bytes);
    } finally {
      db.close();
    }
  }

  async readCover(id: string): Promise<Uint8Array | null> {
    const db = await openDb();
    try {
      const row = (await reqAsPromise(
        db.transaction("covers", "readonly").objectStore("covers").get(id)
      )) as { bytes?: Blob } | undefined;
      return row?.bytes ? await blobToBytes(row.bytes) : null;
    } finally {
      db.close();
    }
  }

  async setContentHash(id: string, contentHash: string): Promise<ShelfEntry> {
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      const next: ShelfEntry = { ...current, contentHash };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async updateProgress(id: string, patch: ShelfProgressPatch): Promise<ShelfEntry> {
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      // A successful stable-position write is also a successful open.  Keep
      // this field merge narrow: markOpened remains a separate isNew-only op.
      const next: ShelfEntry = { ...current, ...patch, isNew: false };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async markOpened(id: string): Promise<ShelfEntry> {
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      const next: ShelfEntry = { ...current, isNew: false };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async setBookmarks(id: string, bookmarks: Bookmark[]): Promise<ShelfEntry> {
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      const next: ShelfEntry = { ...current, bookmarks };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async setNotes(id: string, notes: ReaderNote[]): Promise<ShelfEntry> {
    const normalized = normalizeReaderNotes(notes);
    if (normalized.length !== notes.length || hasDuplicateReaderNoteIds(normalized)) throw new Error("笔记数据无效或包含重复 ID，已拒绝保存");
    const db = await openDb();
    try {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.get(id))) as ShelfEntry | undefined;
      if (!current) throw new Error("书架中没有这本书");
      const next: ShelfEntry = { ...current, notes: normalized };
      store.put(next);
      await txDone(tx);
      return next;
    } finally {
      db.close();
    }
  }

  async relink(): Promise<ShelfEntry> {
    throw new Error("浏览器预览不支持重新定位本地源文件");
  }

  async replacePortableRecords(records: LibraryRecord[], organization?: LibraryOrganization): Promise<PortableRecordsImportResult> {
    const db = await openDb();
    try {
      const tx = db.transaction(["meta", "organization"], "readwrite");
      const store = tx.objectStore("meta");
      const current = (await reqAsPromise(store.getAll())) as ShelfEntry[];
      const byHash = new Map(
        current
          .filter((entry) => typeof entry.contentHash === "string")
          .map((entry) => [entry.contentHash as string, entry])
      );
      const next = records.map((record): ShelfEntry => {
        const local = byHash.get(record.contentHash);
        return {
          ...record,
          // 浏览器字节对象仍以旧 id 为 key；不能因导入存档改掉本地存储身份。
          id: local?.id ?? record.contentHash,
          fileSize: local?.fileSize ?? 0,
          coverMime: local?.coverMime ?? "",
          available: local ? local.available !== false : false,
          notes: normalizeReaderNotes(record.notes),
        };
      });
      for (const entry of next) store.put(entry);
      if (organization) {
        const orgStore = tx.objectStore("organization");
        const existing = await reqAsPromise<OrganizationEnvelope | undefined>(orgStore.get("current"));
        const envelope = existing ?? {
          deviceId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : "00000000-0000-4000-8000-000000000000",
          counter: 0,
          state: emptyOrganization(),
        };
        orgStore.put(mergeIntoEnvelope(validateEnvelope(envelope), organization), "current");
      }
      await txDone(tx);
      return { entries: next, skippedBookCount: 0, skippedBooks: [] };
    } finally {
      db.close();
    }
  }

  async readThumbnail(): Promise<ThumbnailAsset | null> {
    return null;
  }

  async writeThumbnail(): Promise<void> {
    // 浏览器测试后端不建立第二份派生缓存；封面仍受视口门控。
  }

  async deleteThumbnail(): Promise<void> {
    // IndexedDB 删除书籍时会一并删除原有封面对象。
  }

  async deleteBook(id: string): Promise<void> {
    const db = await openDb();
    try {
      if (cleanupBrowserPreparation) {
        const entry = await reqAsPromise<ShelfEntry | undefined>(db.transaction("meta").objectStore("meta").get(id));
        await cleanupBrowserPreparation(entry?.contentHash ?? id);
      }
      const tx = db.transaction(["meta", "books", "covers"], "readwrite");
      tx.objectStore("meta").delete(id);
      tx.objectStore("books").delete(id);
      tx.objectStore("covers").delete(id);
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  async getOrganization(): Promise<LibraryOrganization> {
    const db = await openDb();
    try {
      const tx = db.transaction("organization", "readonly");
      const existing = await reqAsPromise<OrganizationEnvelope | undefined>(
        tx.objectStore("organization").get("current"),
      );
      if (existing) {
        return validateEnvelope(existing).state;
      }
    } finally {
      db.close();
    }
    // 首次读取无数据：在写事务中初始化并落盘本机身份
    const dbWrite = await openDb();
    try {
      const tx = dbWrite.transaction("organization", "readwrite");
      const store = tx.objectStore("organization");
      const existing = await reqAsPromise<OrganizationEnvelope | undefined>(
        store.get("current"),
      );
      if (existing) {
        return validateEnvelope(existing).state;
      }
      const initial: OrganizationEnvelope = {
        deviceId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : "00000000-0000-4000-8000-000000000000",
        counter: 0,
        state: emptyOrganization(),
      };
      store.put(initial, "current");
      await txDone(tx);
      return initial.state;
    } finally {
      dbWrite.close();
    }
  }

  async applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization> {
    return this.writeOrganization((envelope, knownHashes) => {
      const next = applyCommand(envelope, command, knownHashes);
      return { envelope: next, value: next.state };
    });
  }

  async commitDirectoryPlacementBatch(batch: DirectoryPlacementBatch): Promise<DirectoryPlacementBatchResult> {
    return this.writeOrganization((envelope, knownHashes) => {
      const applied = applyDirectoryPlacementBatch(envelope, batch, knownHashes);
      return { envelope: applied.envelope, value: applied.result };
    });
  }

  /**
   * Read the envelope and known hashes, compute, and put the next envelope in
   * one meta+organization transaction. A throwing compute aborts: nothing lands.
   */
  private async writeOrganization<T>(
    compute: (envelope: OrganizationEnvelope, knownHashes: ReadonlySet<string>) => { envelope: OrganizationEnvelope; value: T },
  ): Promise<T> {
    const db = await openDb();
    try {
      const tx = db.transaction(["meta", "organization"], "readwrite");
      const metaStore = tx.objectStore("meta");
      const orgStore = tx.objectStore("organization");

      let envelope = await reqAsPromise<OrganizationEnvelope | undefined>(
        orgStore.get("current"),
      );
      if (!envelope) {
        envelope = {
          deviceId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : "00000000-0000-4000-8000-000000000000",
          counter: 0,
          state: emptyOrganization(),
        };
      } else {
        envelope = validateEnvelope(envelope);
      }

      const allEntries = (await reqAsPromise(metaStore.getAll())) as ShelfEntry[];
      const knownHashes = new Set<string>();
      for (const entry of allEntries) {
        const hash =
          typeof entry.contentHash === "string" && entry.contentHash.length > 0
            ? entry.contentHash
            : typeof entry.id === "string" && /^[a-f0-9]{64}$/i.test(entry.id)
            ? entry.id
            : undefined;
        if (hash) {
          knownHashes.add(hash.toLowerCase());
        }
      }

      let computed: { envelope: OrganizationEnvelope; value: T };
      try {
        computed = compute(envelope, knownHashes);
      } catch (error) {
        try { tx.abort(); } catch { /* already finished */ }
        throw error;
      }
      orgStore.put(computed.envelope, "current");
      await txDone(tx);
      return computed.value;
    } finally {
      db.close();
    }
  }

  async mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization> {
    const validatedIncoming = validateOrganization(incoming);
    const db = await openDb();
    try {
      const tx = db.transaction("organization", "readwrite");
      const orgStore = tx.objectStore("organization");

      let envelope = await reqAsPromise<OrganizationEnvelope | undefined>(
        orgStore.get("current"),
      );
      if (!envelope) {
        envelope = {
          deviceId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : "00000000-0000-4000-8000-000000000000",
          counter: 0,
          state: emptyOrganization(),
        };
      } else {
        envelope = validateEnvelope(envelope);
      }

      const nextEnvelope = mergeIntoEnvelope(envelope, validatedIncoming);
      orgStore.put(nextEnvelope, "current");
      await txDone(tx);
      return nextEnvelope.state;
    } finally {
      db.close();
    }
  }
}

// ---- Tauri 链接式实现（仅保存源路径绑定，不复制 EPUB 正文） ----

export class TauriShelfStore implements ShelfStore {
  async list(): Promise<ShelfEntry[]> {
    const entries = await invoke<ShelfEntry[]>("linked_library_list_records");
    return entries.map(normalizeShelfEntryTextAnchors);
  }

  async save(): Promise<ShelfSaveResult> {
    throw new Error("桌面版必须通过源文件路径导入，不能复制 EPUB 到应用目录");
  }

  async importPaths(paths: string[], copyToLibrary = false): Promise<LinkedImportBatchResult> {
    return invoke<LinkedImportBatchResult>("linked_library_import_paths", { paths, copyToLibrary });
  }

  async readBook(id: string): Promise<Uint8Array> {
    const buf = await invoke<ArrayBuffer>("linked_library_read_source_raw", {
      contentHash: id,
    });
    return new Uint8Array(buf);
  }

  async openArchive(id: string, textEncoding?: string): Promise<ArchiveClient> {
    return createNativeLinkedArchiveClient(id, invoke, undefined, textEncoding);
  }

  async readCover(id: string): Promise<Uint8Array | null> {
    const buf = await invoke<ArrayBuffer>("linked_library_read_cover_raw", {
      contentHash: id,
    });
    return buf.byteLength > 0 ? new Uint8Array(buf) : null;
  }

  async setContentHash(id: string, contentHash: string): Promise<ShelfEntry> {
    if (id !== contentHash) throw new Error("链接式书库的 ID 必须等于内容指纹");
    const entry = (await this.list()).find((item) => item.id === id);
    if (!entry) throw new Error("书架中没有这本书");
    return entry;
  }

  async updateProgress(id: string, patch: ShelfProgressPatch): Promise<ShelfEntry> {
    return invoke<ShelfEntry>("linked_library_update_progress", {
      contentHash: id,
      lastReadAtMs: patch.lastReadAtMs,
      spineIndex: patch.spineIndex,
      page: patch.page,
      progressPct: patch.progressPct,
      anchorIndex: patch.anchorIndex,
      anchorRatio: patch.anchorRatio,
      anchorTextOffset: patch.anchorTextOffset,
      anchorTextSnippet: patch.anchorTextSnippet,
      mediaAnchor: patch.mediaAnchor ?? null,
    });
  }

  async markOpened(id: string): Promise<ShelfEntry> {
    return invoke<ShelfEntry>("linked_library_mark_opened", { contentHash: id });
  }

  async setBookmarks(id: string, bookmarks: Bookmark[]): Promise<ShelfEntry> {
    return invoke<ShelfEntry>("linked_library_update_bookmarks", {
      contentHash: id,
      bookmarks,
    });
  }

  async setNotes(id: string, notes: ReaderNote[]): Promise<ShelfEntry> {
    const normalized = normalizeReaderNotes(notes);
    if (normalized.length !== notes.length || hasDuplicateReaderNoteIds(normalized)) throw new Error("笔记数据无效或包含重复 ID，已拒绝保存");
    return invoke<ShelfEntry>("linked_library_update_notes", {
      contentHash: id,
      notes: normalized,
    });
  }

  async relink(id: string, sourcePath: string): Promise<ShelfEntry> {
    return invoke<ShelfEntry>("linked_library_relink", {
      contentHash: id,
      sourcePath,
    });
  }

  async replacePortableRecords(records: LibraryRecord[], organization?: LibraryOrganization): Promise<PortableRecordsImportResult> {
    const entries = await invoke<ShelfEntry[]>("linked_library_replace_records", { records });
    if (organization) await this.mergeOrganization(organization);
    return { entries, skippedBookCount: 0, skippedBooks: [] };
  }

  async readThumbnail(contentHash: string, mime?: string): Promise<ThumbnailAsset | null> {
    const buf = await invoke<ArrayBuffer>("linked_library_thumbnail_read", { contentHash });
    if (buf.byteLength === 0) return null;
    return { bytes: new Uint8Array(buf), mime: mime || "image/webp" };
  }

  async writeThumbnail(contentHash: string, asset: ThumbnailAsset): Promise<void> {
    await invoke("linked_library_thumbnail_write_raw", asset.bytes, {
      headers: {
        "x-content-hash": contentHash,
        "x-thumbnail-mime": asset.mime,
      },
    });
  }

  async deleteThumbnail(contentHash: string): Promise<void> {
    await invoke("linked_library_thumbnail_delete", { contentHash });
  }

  async deleteBook(id: string): Promise<void> {
    await invoke("linked_library_delete_record", { contentHash: id });
  }

  async deleteBooks(ids: string[]): Promise<void> {
    await invoke("linked_library_delete_records", { contentHashes: ids });
  }

  async getOrganization(): Promise<LibraryOrganization> {
    return invoke<LibraryOrganization>("linked_library_get_organization");
  }

  async applyOrganization(command: OrganizationCommand): Promise<LibraryOrganization> {
    return invoke<LibraryOrganization>("linked_library_apply_organization", { command });
  }

  async mergeOrganization(incoming: LibraryOrganization): Promise<LibraryOrganization> {
    return invoke<LibraryOrganization>("linked_library_merge_organization", { incoming });
  }
}
