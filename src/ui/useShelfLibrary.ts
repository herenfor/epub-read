import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { getShelfStore, deleteShelfBooks, type ShelfEntry, type ShelfProgressPatch } from "./shelf";
import { emptyOrganization, type LibraryOrganization, type OrganizationCommand, type ShelfScope } from "./libraryOrganization";
import { createLibraryReader, LIBRARY_LOADING, LibraryReadInterruptedError, libraryReadFailed, libraryReadSucceeded, type LibraryLoadState } from "./libraryLoad";
import { uiText, uiPlural } from "./localization/UiLanguageProvider";
import { sha256Hex } from "./importBooks";
import type { RuntimeCapabilities } from "../platform/runtimeCapabilities";
import type { LocalProgressCheckpoints } from "./localProgressCheckpoint";

export type ShelfNotice = { kind: "ok" | "warn" | "error"; text: string } | null;

// Initialization and effects have separate hooks to retain their original App order.
export function useShelfEntriesState() {
  const [shelfEntries, setShelfEntriesState] = useState<ShelfEntry[]>([]);
  // Every external projection write invalidates an in-flight list snapshot,
  // including progress, notes and bookmarks of books already on the shelf.
  const shelfWritesRef = useRef(0);
  const setShelfEntries = useCallback<Dispatch<SetStateAction<ShelfEntry[]>>>((next) => {
    shelfWritesRef.current += 1;
    setShelfEntriesState(next);
  }, []);
  // First real read of the library: loading / failed / ready (see ui/libraryLoad).
  const [libraryLoad, setLibraryLoad] = useState<LibraryLoadState>(LIBRARY_LOADING);
  const [shelfError, setShelfError] = useState<string | null>(null);
  return { shelfEntries, setShelfEntriesState, shelfWritesRef, setShelfEntries, libraryLoad, setLibraryLoad, shelfError, setShelfError };
}

export function useShelfNoticeState() {
  const [shelfNotice, setShelfNotice] = useState<ShelfNotice>(null);
  const [shelfNoticeFading, setShelfNoticeFading] = useState(false);
  return { shelfNotice, setShelfNotice, shelfNoticeFading, setShelfNoticeFading };
}

export function useShelfOrganizationState() {
  // ---- 收藏与文件夹 ----
  const [organization, setOrganizationState] = useState<LibraryOrganization>(emptyOrganization);
  const organizationWritesRef = useRef(0);
  const setOrganization = useCallback<Dispatch<SetStateAction<LibraryOrganization>>>((next) => {
    organizationWritesRef.current += 1;
    setOrganizationState(next);
  }, []);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  // The organization read has answered (either way): only then may an empty list mean an empty shelf.
  const [organizationSettled, setOrganizationSettled] = useState(false);
  const [shelfScope, setShelfScope] = useState<ShelfScope>({ type: "root" });
  const organizationRef = useRef<LibraryOrganization>(organization);
  organizationRef.current = organization;
  const organizationBusyRef = useRef(false);
  return { organization, setOrganizationState, organizationWritesRef, setOrganization, organizationError, setOrganizationError, organizationSettled, setOrganizationSettled, shelfScope, setShelfScope, organizationRef, organizationBusyRef };
}

export function useShelfContentHashes(shelfEntries: ShelfEntry[]) {
  const contentHashByIdRef = useRef(new Map<string, string>());
  const entryByContentHashRef = useRef(new Map<string, ShelfEntry>());
  const currentShelfIds = new Set(shelfEntries.map((entry) => entry.id));
  for (const [id, hash] of contentHashByIdRef.current) {
    if (!currentShelfIds.has(id)) {
      contentHashByIdRef.current.delete(id);
      entryByContentHashRef.current.delete(hash);
    }
  }
  for (const entry of shelfEntries) {
    if (!entry.contentHash) continue;
    contentHashByIdRef.current.set(entry.id, entry.contentHash);
    entryByContentHashRef.current.set(entry.contentHash, entry);
  }
  return { contentHashByIdRef, entryByContentHashRef };
}

type EntriesState = ReturnType<typeof useShelfEntriesState>;
type OrganizationState = ReturnType<typeof useShelfOrganizationState>;
type SetNotice = Dispatch<SetStateAction<ShelfNotice>>;

const shelfStoreIds = new WeakMap<object, number>();
let shelfStoreIdSeq = 0;
/**
 * Identity of the repository behind library reads: the facade's store
 * instance (activation swaps it) plus the runtime generation the store
 * reports, which changes when the native repository is reopened or replaced
 * (a restore) even though the JS instance stays. The status check is
 * read-only; if it fails, only the instance is compared.
 */
async function shelfRepositoryKey(): Promise<string> {
  const store = getShelfStore();
  let id = shelfStoreIds.get(store);
  if (id === undefined) {
    id = ++shelfStoreIdSeq;
    shelfStoreIds.set(store, id);
  }
  let generation = "unknown";
  try {
    generation = (await store.runtimeStatus?.())?.repositoryGeneration ?? "none";
  } catch {
    /* Diagnostics-only failure: fall back to the instance identity. */
  }
  return `${id}:${generation}`;
}

/** Library read errors as shown on the shelf; the "kept changing" case gets its own wording. */
function libraryReadErrorText(error: unknown): string {
  return error instanceof LibraryReadInterruptedError ? uiText("notice.shelf.readInterrupted") : String(error);
}

/** Read gates retain their original publish counters and refresh behavior. */
export function useShelfLibrary({
  entriesState: { setShelfEntriesState, shelfWritesRef, setLibraryLoad },
  organizationState: { setOrganizationState, organizationWritesRef, organizationError, setOrganizationError, setOrganizationSettled },
  setShelfNotice, onListPublished, onListFailed,
}: {
  entriesState: EntriesState;
  organizationState: OrganizationState;
  setShelfNotice: SetNotice;
  onListPublished(entries: ShelfEntry[]): void;
  onListFailed(error: unknown): void;
}) {
  // ---- 书库读取：首次读取、失败重试共用同一读取入口 ----
  // Readers are created once; what they publish into is refreshed every render.
  const libraryReadDepsRef = useRef<{
    publishList(entries: ShelfEntry[]): void;
    failList(error: unknown): void;
    publishOrganization(org: LibraryOrganization): void;
    failOrganization(error: unknown): void;
  } | null>(null);
  libraryReadDepsRef.current = {
    publishList(entries) {
      setShelfEntriesState(entries);
      setLibraryLoad(libraryReadSucceeded());
      onListPublished(entries);
    },
    failList(error) {
      setLibraryLoad((previous) => libraryReadFailed(previous, libraryReadErrorText(error)));
      onListFailed(error);
    },
    publishOrganization(org) {
      setOrganizationState(org);
      setOrganizationError(null);
      setOrganizationSettled(true);
    },
    failOrganization(error) {
      // Keep the folders already known; writes stay blocked while organizationError is set.
      setOrganizationError(uiText("notice.organization.readFailed", { error: libraryReadErrorText(error) }));
      setOrganizationSettled(true);
      setShelfNotice({ kind: "error", text: uiText("notice.organization.readFailedWrites", { error: libraryReadErrorText(error) }) });
    },
  };
  const [libraryReader] = useState(() => createLibraryReader<ShelfEntry[]>({
    read: () => getShelfStore().list(),
    writeCount: () => shelfWritesRef.current,
    repository: shelfRepositoryKey,
    publish: (entries) => libraryReadDepsRef.current!.publishList(entries),
    fail: (error) => libraryReadDepsRef.current!.failList(error),
  }));
  const [organizationReader] = useState(() => createLibraryReader<LibraryOrganization>({
    read: () => getShelfStore().getOrganization(),
    writeCount: () => organizationWritesRef.current,
    repository: shelfRepositoryKey,
    publish: (org) => libraryReadDepsRef.current!.publishOrganization(org),
    fail: (error) => libraryReadDepsRef.current!.failOrganization(error),
  }));
  /** Retry from the shelf: the same real reads, never activation/migration again; a second tap joins the read in flight. */
  const retryLibraryLoad = useCallback((): void => {
    void libraryReader.load();
    if (organizationError) void organizationReader.load();
  }, [libraryReader, organizationReader, organizationError]);

  /**
   * Authoritative re-read after imports and sync. It goes through the same
   * publish gate as the first read and supersedes any read still in flight;
   * a newer refresh, a write during the read or teardown keeps this one from
   * publishing. Books and folders fail independently; only a list failure
   * rejects, so callers keep their own error wording.
   */
  const refreshShelfProjection = useCallback(async (): Promise<void> => {
    const [list] = await Promise.all([libraryReader.refresh(), organizationReader.refresh()]);
    if (list.kind === "failed") throw list.error;
  }, [libraryReader, organizationReader]);

  return { libraryReader, organizationReader, retryLibraryLoad, refreshShelfProjection };
}

export function useShelfOrganizationActions({
  runtime, shelfEntriesRef, shelfBusyRef,
  organizationState: { organizationBusyRef, organizationError, setOrganization },
  setShelfEntries, setShelfNotice,
}: {
  runtime: RuntimeCapabilities;
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  shelfBusyRef: MutableRefObject<boolean>;
  organizationState: OrganizationState;
  setShelfEntries: EntriesState["setShelfEntries"];
  setShelfNotice: SetNotice;
}) {
  const resolveContentHashForEntry = useCallback(async (entry: ShelfEntry): Promise<string> => {
    if (entry.contentHash && /^[a-f0-9]{64}$/.test(entry.contentHash)) {
      return entry.contentHash;
    }
    if (/^[a-f0-9]{64}$/.test(entry.id)) {
      return entry.id;
    }
    if (entry.available === false) {
      throw new Error(`《${entry.title}》文件失联且无指纹，${runtime.platform === "android" ? "请重新导入文件" : "请重新关联文件"}后再加入分类或收藏`);
    }
    try {
      const buf = await getShelfStore().readBook(entry.id);
      const hash = await sha256Hex(buf);
      const updated = await getShelfStore().setContentHash(entry.id, hash);
      setShelfEntries((prev) => prev.map((item) => (item.id === entry.id ? updated : item)));
      return hash;
    } catch (err) {
      throw new Error(`无法读取《${entry.title}》计算内容指纹：${String(err)}`);
    }
  }, []);

  const handleApplyOrganization = useCallback(
    async (command: OrganizationCommand): Promise<void> => {
      if (organizationBusyRef.current || shelfBusyRef.current) {
        return;
      }
      if (organizationError) {
        setShelfNotice({
          kind: "error",
          text: uiText("notice.organization.readFailedLocked"),
        });
        throw new Error("收藏与文件夹处于错误状态，已禁用修改");
      }
      organizationBusyRef.current = true;
      try {
        let finalCommand = command;
        if ("contentHashes" in command) {
          const resolvedHashes: string[] = [];
          for (const idOrHash of command.contentHashes) {
            const entry = shelfEntriesRef.current.find(
              (e) => e.id === idOrHash || e.contentHash === idOrHash
            );
            if (!entry) throw new Error("所选书籍在书架中不存在");
            const hash = await resolveContentHashForEntry(entry);
            resolvedHashes.push(hash);
          }
          finalCommand = { ...command, contentHashes: resolvedHashes } as OrganizationCommand;
        }
        const nextOrg = await getShelfStore().applyOrganization(finalCommand);
        setOrganization(nextOrg);
      } catch (error) {
        setShelfNotice({ kind: "error", text: uiText("notice.operationFailed", { error: String(error) }) });
        throw error;
      } finally {
        organizationBusyRef.current = false;
      }
    },
    [organizationError, resolveContentHashForEntry]
  );

  return { resolveContentHashForEntry, handleApplyOrganization };
}

export function useShelfDeletion({
  shelfBusyRef, nativeImportRef, shelfEntriesRef, localCheckpointsRef,
  setShelfBusyMessage, setShelfBusy, setShelfEntries, setCurrentShelfId, setShelfError, setShelfNotice,
  refreshOrganization,
}: {
  shelfBusyRef: MutableRefObject<boolean>;
  nativeImportRef: MutableRefObject<string | null>;
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  localCheckpointsRef: MutableRefObject<Pick<LocalProgressCheckpoints<ShelfProgressPatch>, "remove"> | null>;
  setShelfBusyMessage: Dispatch<SetStateAction<string>>;
  setShelfBusy: Dispatch<SetStateAction<boolean>>;
  setShelfEntries: EntriesState["setShelfEntries"];
  setCurrentShelfId: Dispatch<SetStateAction<string | null>>;
  setShelfError: EntriesState["setShelfError"];
  setShelfNotice: SetNotice;
  /** C5: deletion also purges the book's favorite and folder placement; re-read them so a reimport starts clean. */
  refreshOrganization?: () => Promise<unknown>;
}) {
  const handleShelfDelete = useCallback(async (id: string) => {
    if (shelfBusyRef.current || nativeImportRef.current) {
      if (nativeImportRef.current) setShelfNotice({ kind: "warn", text: uiText("notice.delete.importing") });
      return;
    }
    shelfBusyRef.current = true;
    setShelfBusyMessage(uiText("notice.delete.removing"));
    setShelfBusy(true);
    const checkpointEntry = shelfEntriesRef.current.find((entry) => entry.id === id);
    try {
      await getShelfStore().deleteBook(id);
      if (checkpointEntry) {
        localCheckpointsRef.current?.remove(checkpointEntry.contentHash ?? checkpointEntry.id);
      }
      setShelfEntries((prev) => prev.filter((e) => e.id !== id));
      setCurrentShelfId((curr) => (curr === id ? null : curr));
      setShelfError(null);
      void refreshOrganization?.().catch(() => undefined);
    } catch (e) {
      setShelfError(uiText("notice.delete.failed", { error: String(e) }));
    } finally {
      shelfBusyRef.current = false;
      setShelfBusy(false);
    }
  }, [refreshOrganization]);

  const handleShelfDeleteMany = useCallback(async (ids: string[]) => {
    if (shelfBusyRef.current || ids.length === 0) return;
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.delete.importing") });
      return;
    }
    shelfBusyRef.current = true;
    setShelfBusyMessage(uiText("notice.delete.removing"));
    setShelfBusy(true);
    const checkpointEntries = shelfEntriesRef.current.filter((entry) => ids.includes(entry.id));
    try {
      const { deleted, failed } = await deleteShelfBooks(getShelfStore(), ids);
      const deletedIds = new Set(deleted);
      for (const entry of checkpointEntries) {
        if (deletedIds.has(entry.id)) {
          localCheckpointsRef.current?.remove(entry.contentHash ?? entry.id);
        }
      }
      setShelfEntries((prev) => prev.filter((entry) => !deletedIds.has(entry.id)));
      setCurrentShelfId((curr) => (curr && deletedIds.has(curr) ? null : curr));
      if (deleted.length > 0) void refreshOrganization?.().catch(() => undefined);
      if (failed.length === 0) {
        setShelfError(null);
        setShelfNotice({ kind: "ok", text: uiPlural("notice.delete.done", deleted.length, { count: deleted.length }) });
      } else {
        setShelfError(uiText("notice.delete.partial", { count: failed.length, errors: [...new Set(failed.map((item) => item.error))].join(uiText("notice.sep")) }));
      }
    } finally {
      shelfBusyRef.current = false;
      setShelfBusy(false);
    }
  }, [refreshOrganization]);

  return { handleShelfDelete, handleShelfDeleteMany };
}

export function useShelfNoticeLifetime({ shelfNotice, setShelfNotice, setShelfNoticeFading }: ReturnType<typeof useShelfNoticeState>) {
  // 导入结果 toast：展示 3 秒后用 1 秒淡出，期间不拦截鼠标
  useEffect(() => {
    if (!shelfNotice) {
      setShelfNoticeFading(false);
      return;
    }
    setShelfNoticeFading(false);
    const fadeTimer = window.setTimeout(() => setShelfNoticeFading(true), 3000);
    const closeTimer = window.setTimeout(() => setShelfNotice(null), 4000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(closeTimer);
    };
  }, [shelfNotice]);

}
