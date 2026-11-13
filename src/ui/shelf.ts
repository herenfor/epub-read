// Shelf repository facade: scoped/legacy/portable store selection and activation.

import { invoke } from "@tauri-apps/api/core";
import { createRepositoryReadinessRecovery } from "./portableState/repositoryReadinessRepair";
import { PortableShelfStore, activatePortableShelfStore } from "./portableState/shelfStoreAdapter";
import { PortableStateService } from "./portableState/service";
import { IndexedDbPortableStateStorage } from "./portableState/indexedDbStorage";
import { TauriPortableStateService } from "./portableState/tauriService";
import { IndexedDbShelfStore, TauriShelfStore } from "./shelf/stores";
import { uiText } from "./localization/UiLanguageProvider";
import type { PortableActivationResult, PortableStateDataService } from "./portableState/dataService";
import type { ProgressRuntimeStatus } from "./portableState/progressRuntimeGate";
import type { PortablePreferences } from "../core/portableState/portable-state-types";
import type { ThumbnailProvider } from "./thumbnail";
import type { ShelfStore } from "./shelf/types";

export type { Bookmark, ShelfEntry, LinkedImportItemResult, LinkedImportBatchResult, PortableProgressSelection, NoteEditContext, ShelfProgressPatch, ShelfSaveInput, ShelfSaveResult, PortableRecordsImportResult, ShelfStore } from "./shelf/types";
export type { ShelfSort, ShelfTimeSegment, ShelfFilterSelection, ShelfFacetOption, ShelfFacet, ShelfFilterFacets, ShelfFilterIndex, ShelfFilterModel } from "./shelf/entries";
export { sortShelfEntries, filterShelfEntries, UNKNOWN_SHELF_AUTHOR, normalizeShelfAuthor, normalizeShelfCreator, UNKNOWN_SHELF_LANGUAGE, normalizeShelfLanguage, SHELF_TIME_SEGMENTS, SHELF_TIME_SEGMENT_LABELS, shelfTimeSegment, getShelfTimeSegment, buildShelfFilterIndex, matchesShelfFilterSelection, buildShelfFilterFacets, filterShelfEntriesByFacets, createShelfFilterModel, applyShelfProgressPatch, normalizeMediaReadingAnchor, normalizeShelfEntryTextAnchors, readingAnchorFromShelfEntry, markShelfEntryOpened, formatShelfTime } from "./shelf/entries";

export async function deleteShelfBooks(
  store: Pick<ShelfStore, "deleteBook" | "deleteBooks">,
  ids: string[],
): Promise<{ deleted: string[]; failed: Array<{ id: string; error: string }> }> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return { deleted: [], failed: [] };
  if (store.deleteBooks) {
    try {
      await store.deleteBooks(uniqueIds);
      return { deleted: uniqueIds, failed: [] };
    } catch (error) {
      return { deleted: [], failed: uniqueIds.map((id) => ({ id, error: String(error) })) };
    }
  }
  const deleted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of uniqueIds) {
    try { await store.deleteBook(id); deleted.push(id); }
    catch (error) { failed.push({ id, error: String(error) }); }
  }
  return { deleted, failed };
}

export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 0.1.5 旧版 ID 算法；保留用于兼容与历史测试，新导入使用内容 SHA-256。 */
export function shelfIdFor(identifier: string, fileName: string, fileSize: number): string {
  const text = `${identifier}|${fileName}|${fileSize}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}


let cachedStore: ShelfStore | null = null;
let cachedLegacyStore: ShelfStore | null = null;
let cachedPortableStore: PortableShelfStore | null = null;
let portableDataService: PortableStateDataService | null = null;
let portableActivation: Promise<PortableActivationResult> | null = null;
let portableReadinessRecovery: ReturnType<typeof createRepositoryReadinessRecovery> | null = null;

/**
 * C5/C2: the native repository refuses a newer or unknown database. That
 * library must not be masked by the legacy JSON mode or a fresh one, so every
 * shelf read and write fails with this error until the next activation.
 */
export class LibraryDatabaseBlockedError extends Error {
  readonly code: string;

  constructor(code: LibraryDatabaseBlockedError["code"], detail: string) {
    super(uiText(code === "unsupported-database-version" ? "notice.portable.databaseTooNew"
      : code === "unrecognized-database-format" ? "notice.portable.databaseUnrecognized"
      : "notice.portable.databaseUnavailable", { error: detail }));
    this.name = "LibraryDatabaseBlockedError";
    this.code = code;
    this.cause = detail;
  }
}

function blockingDatabaseError(error: unknown): LibraryDatabaseBlockedError | null {
  if (!error || typeof error !== "object") return null;
  const { code, message, legacyFallbackAllowed } = error as { code?: unknown; message?: unknown; legacyFallbackAllowed?: unknown };
  if (code !== "unsupported-database-version" && code !== "unrecognized-database-format"
    && !(typeof code === "string" && legacyFallbackAllowed === false)) return null;
  return new LibraryDatabaseBlockedError(code, typeof message === "string" ? message : "");
}

function blockedShelfStore(error: LibraryDatabaseBlockedError): ShelfStore {
  return new Proxy({} as ShelfStore, {
    get(_target, property) {
      // Not a thenable; every store method rejects with the same error.
      if (property === "then" || typeof property === "symbol") return undefined;
      return async () => { throw error; };
    },
  });
}

function legacyShelfStore(): ShelfStore {
  if (!cachedLegacyStore) cachedLegacyStore = isTauriEnv() ? new TauriShelfStore() : new IndexedDbShelfStore();
  return cachedLegacyStore;
}

let scopedStore: ShelfStore | null = null;

/**
 * A shelf other than the library (see shelfSpaces) replaces the store while
 * it is open, so the shelf, reader and annotations use it unchanged. Null
 * returns to the library. Services that must stay library-wide check the
 * active space's policy instead of reading this store.
 */
export function setScopedShelfStore(store: ShelfStore | null): void {
  scopedStore = store;
}

export function getShelfStore(): ShelfStore {
  if (scopedStore) return scopedStore;
  if (!cachedStore) cachedStore = legacyShelfStore();
  return cachedStore;
}

/**
 * One-time CP-I activation. The legacy store stays in place until migration
 * and repository open both succeed; on failure the caller keeps the complete
 * old mode and receives a clear error.
 */
export async function activatePortableShelfState(): Promise<PortableActivationResult> {
  if (portableActivation) return portableActivation;
  const legacy = legacyShelfStore();
  const data = portableDataService ?? (isTauriEnv()
    ? new TauriPortableStateService()
    : new PortableStateService(new IndexedDbPortableStateStorage()));
  portableDataService = data;
  portableActivation = (async () => {
    try {
      const result = await activatePortableShelfStore(legacy, data);
      cachedPortableStore = new PortableShelfStore(legacy, data);
      cachedStore = cachedPortableStore;
      return result;
    } catch (error) {
      portableActivation = null;
      const blocked = blockingDatabaseError(error);
      cachedStore = blocked ? blockedShelfStore(blocked) : legacy;
      throw blocked ?? error;
    }
  })();
  return portableActivation;
}

/** Test/UI query: whether the portable facade is currently active. */
export function portableShelfStateActive(): boolean {
  return cachedPortableStore !== null;
}

/**
 * Explicit foreground recovery. Once the facade is active, recovery calls the
 * real data service activate instead of the already-fulfilled activation
 * promise. The read-only health command stays outside this recovery.
 */
export async function ensurePortableRepositoryReady(): Promise<ProgressRuntimeStatus> {
  if (!cachedPortableStore || !portableDataService) {
    // First transition from legacy still uses the existing migration entry.
    await activatePortableShelfState();
  }
  const data = portableDataService;
  if (!data) {
    return { repositoryGeneration: "legacy", repositoryReady: true };
  }
  if (!portableReadinessRecovery) {
    portableReadinessRecovery = createRepositoryReadinessRecovery({
      runtimeStatus: () => data.runtimeStatus(),
      activate: async () => {
        if (!data.activate) {
          throw Object.assign(new Error("当前存储后端不支持运行时激活"), { code: "runtime-not-ready" });
        }
        return data.activate();
      },
    });
  }
  return portableReadinessRecovery();
}

/** Read the preferences stored in the active portable repository after a file import. */
export async function readPortablePreferencesSnapshot(): Promise<PortablePreferences | undefined> {
  await activatePortableShelfState();
  if (!portableDataService) return undefined;
  const state = await portableDataService.snapshot();
  return state.preferences;
}

const thumbnailMimeByHash = new Map<string, string>();

/** 视口缩略图桥：所有路径、缓存位置和 ZIP 条目仍由 ShelfStore/Rust 控制。 */
export const shelfThumbnailProvider: ThumbnailProvider = {
  async readCachedThumbnail(descriptor) {
    const hash = descriptor.contentHash ?? descriptor.id;
    return getShelfStore().readThumbnail(
      hash,
      descriptor.thumbnailMime || thumbnailMimeByHash.get(hash)
    );
  },
  async readSourceCover(descriptor) {
    const bytes = await getShelfStore().readCover(descriptor.id);
    return bytes && bytes.byteLength > 0
      ? { bytes, mime: descriptor.coverMime || "image/jpeg" }
      : null;
  },
  async writeDerivedThumbnail(descriptor, asset) {
    const hash = descriptor.contentHash ?? descriptor.id;
    await getShelfStore().writeThumbnail(hash, asset);
    thumbnailMimeByHash.set(hash, asset.mime);
  },
};

/** 测试用：重置缓存的 store。 */
export function resetShelfStoreForTest(): void {
  scopedStore = null;
  cachedStore = null;
  cachedLegacyStore = null;
  cachedPortableStore = null;
  portableDataService = null;
  portableActivation = null;
  portableReadinessRecovery = null;
}

/**
 * Opens File Explorer with the book's file selected: the user's own file for a
 * linked book, the library copy for a managed one. Only the content hash is
 * sent; the native side resolves the path. "missing" means the file is gone.
 */
export async function revealShelfSource(contentHash: string): Promise<"revealed" | "missing"> {
  try {
    const result = await invoke<{ status: "revealed" | "missing" }>("linked_library_reveal_source", { contentHash });
    return result.status;
  } catch (error) {
    const message = (error as { message?: unknown } | null)?.message;
    throw new Error(typeof message === "string" && message ? message : String(error));
  }
}
