/**
 * IndexedDB implementation of the portable-state storage boundary.
 *
 * It extends the existing browser shelf database instead of creating a second
 * shelf: old `meta`/`books`/`covers`/`organization` stores are preserved, and
 * the portable state gets separate stores whose writes share one transaction.
 * CP-I must keep the module's DB_VERSION in sync with the old `shelf.ts`
 * opener before both adapters are active.
 */
import type { OrganizationEnvelope } from "../libraryOrganization";
import type {
  AnnotationRow,
  BookmarkAnnotationRow,
  NoteAnnotationRow,
  PortableMetadataRow,
  PortableProgressRow,
  PortableStateStorage,
  PortableStateTransaction,
} from "./storage";

export const PORTABLE_STATE_DB_NAME = "epub-reader-shelf";
export const PORTABLE_STATE_DB_VERSION = 3;

const LEGACY_STORES = ["meta", "books", "covers", "organization"] as const;
const PORTABLE_STORES = ["portable_books", "portable_progress", "portable_annotations", "portable_meta"] as const;
const ALL_STORES = [...LEGACY_STORES, ...PORTABLE_STORES] as const;

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(PORTABLE_STATE_DB_NAME, PORTABLE_STATE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Preserve the existing browser shelf rows; only create missing stores.
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
      if (!db.objectStoreNames.contains("covers")) db.createObjectStore("covers", { keyPath: "id" });
      if (!db.objectStoreNames.contains("organization")) db.createObjectStore("organization");
      if (!db.objectStoreNames.contains("portable_books")) db.createObjectStore("portable_books", { keyPath: "hash" });
      if (!db.objectStoreNames.contains("portable_progress")) db.createObjectStore("portable_progress", { keyPath: "hash" });
      if (!db.objectStoreNames.contains("portable_annotations")) {
        const store = db.createObjectStore("portable_annotations", { keyPath: ["hash", "kind", "id"] });
        store.createIndex("byBook", "hash");
      }
      if (!db.objectStoreNames.contains("portable_meta")) db.createObjectStore("portable_meta", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error("无法打开可移植存档数据库"));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error("可移植存档数据库升级被其他页面阻塞"));
    };
  });
  return dbPromise;
}

/** Test-only reset for environments that provide a fresh `indexedDB`. */
export function resetPortableStateDbForTest(): void {
  dbPromise = null;
}

class IndexedDbPortableTransaction implements PortableStateTransaction {
  constructor(private readonly tx: IDBTransaction) {}

  private store(name: string): IDBObjectStore {
    return this.tx.objectStore(name);
  }

  async getEnvelope(): Promise<OrganizationEnvelope | null> {
    const value = await requestAsPromise<OrganizationEnvelope | undefined>(this.store("organization").get("current"));
    return value === undefined ? null : value;
  }

  async putEnvelope(envelope: OrganizationEnvelope): Promise<void> {
    await requestAsPromise(this.store("organization").put(envelope, "current"));
  }

  async getMetadata(hash: string): Promise<PortableMetadataRow | null> {
    const value = await requestAsPromise<PortableMetadataRow | undefined>(this.store("portable_books").get(hash));
    return value === undefined ? null : value;
  }

  async putMetadata(row: PortableMetadataRow): Promise<void> {
    await requestAsPromise(this.store("portable_books").put(row));
  }

  async listMetadata(): Promise<readonly PortableMetadataRow[]> {
    return requestAsPromise<PortableMetadataRow[]>(this.store("portable_books").getAll());
  }

  async getProgress(hash: string): Promise<PortableProgressRow | null> {
    const value = await requestAsPromise<PortableProgressRow | undefined>(this.store("portable_progress").get(hash));
    return value === undefined ? null : value;
  }

  async putProgress(row: PortableProgressRow): Promise<void> {
    await requestAsPromise(this.store("portable_progress").put(row));
  }

  async listProgress(): Promise<readonly PortableProgressRow[]> {
    return requestAsPromise<PortableProgressRow[]>(this.store("portable_progress").getAll());
  }

  async getBookmarkAnnotation(hash: string, id: string): Promise<BookmarkAnnotationRow | null> {
    const value = await requestAsPromise<BookmarkAnnotationRow | undefined>(
      this.store("portable_annotations").get([hash, "bookmark", id]),
    );
    return value === undefined ? null : value;
  }

  async getNoteAnnotation(hash: string, id: string): Promise<NoteAnnotationRow | null> {
    const value = await requestAsPromise<NoteAnnotationRow | undefined>(
      this.store("portable_annotations").get([hash, "note", id]),
    );
    return value === undefined ? null : value;
  }

  async putBookmarkAnnotation(row: BookmarkAnnotationRow): Promise<void> {
    await requestAsPromise(this.store("portable_annotations").put(row));
  }

  async putNoteAnnotation(row: NoteAnnotationRow): Promise<void> {
    await requestAsPromise(this.store("portable_annotations").put(row));
  }

  async listAnnotations(hash?: string): Promise<readonly AnnotationRow[]> {
    if (hash === undefined) {
      return requestAsPromise<AnnotationRow[]>(this.store("portable_annotations").getAll());
    }
    return requestAsPromise<AnnotationRow[]>(this.store("portable_annotations").index("byBook").getAll(hash));
  }

  async getMeta(key: string): Promise<unknown> {
    const row = await requestAsPromise<{ key: string; value: unknown } | undefined>(
      this.store("portable_meta").get(key),
    );
    return row?.value;
  }

  async putMeta(key: string, value: unknown): Promise<void> {
    await requestAsPromise(this.store("portable_meta").put({ key, value }));
  }

  async deleteMeta(key: string): Promise<void> {
    await requestAsPromise(this.store("portable_meta").delete(key));
  }
}

export class IndexedDbPortableStateStorage implements PortableStateStorage {
  async transaction<T>(work: (transaction: PortableStateTransaction) => Promise<T>): Promise<T> {
    const db = await openDatabase();
    const tx = db.transaction(ALL_STORES, "readwrite");
    const done = transactionDone(tx);
    try {
      const result = await work(new IndexedDbPortableTransaction(tx));
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* already aborted */ }
      try { await done; } catch { /* preserve the original error */ }
      throw error;
    } finally {
      // Keep the shared connection open. Closing it here would leave the
      // cached promise pointing at a closed IDBDatabase for the next call.
    }
  }
}
