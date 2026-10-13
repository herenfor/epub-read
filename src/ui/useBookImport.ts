import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { loadBook, DrmError } from "../core/book";
import type { DirectoryImportPort } from "../core/folderImport/contract";
import type { RuntimeCapabilities } from "../platform/runtimeCapabilities";
import { cancelDocumentImport, importDocuments, type AndroidDocumentSelection, type AndroidImportBatchResult, type AndroidNativeImportError } from "../platform/androidNativeBridge";
import { activatePortableShelfState, getShelfStore, type ShelfEntry } from "./shelf";
import { formatImportNotice, findDuplicateEntry, mergeShelfEntries, sha256Hex } from "./importBooks";
import { bookOpenErrorMessage } from "./bookOpenFailure";
import { uiText, uiPlural } from "./localization/UiLanguageProvider";
import type { NativeImportCancelState } from "./NativeImportPanel";
import { createNativeDirectoryImportPort, createWebDirectoryImportPort, supportsWebDirectoryPicker } from "./folderImport";
import type { LibraryOrganization } from "./libraryOrganization";
import type { useSaveFileJob } from "./useSaveFileJob";
import type { ShelfNotice } from "./useShelfLibrary";

type ImportSource =
  | { kind: "file"; file: File }
  | { kind: "path"; path: string; name: string };

/** Shared by all import/delete/LAN/archive gates; reserved before any await. */
const FOLDER_IMPORT_SLOT = "directory-import";

function displayNameFromContentUri(uri: string): string {
  try {
    const last = decodeURIComponent(uri.split("/").filter(Boolean).pop() ?? "");
    const base = last.split(/[\\/]/).pop() ?? "";
    return base || uiText("notice.selectedFile");
  } catch {
    return uiText("notice.selectedFile");
  }
}

function createNativeImportRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `android-import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useBookImportState() {
  const [shelfBusy, setShelfBusy] = useState(false);
  const [shelfBusyMessage, setShelfBusyMessage] = useState(() => uiText("notice.busy"));
  const [nativeImport, setNativeImport] = useState<{
    requestId: string;
    phase: "starting" | "preparing" | "committing";
    completed: number;
    total: number;
    cancelState: NativeImportCancelState;
    collapsed: boolean;
    fileNameSummary: string;
  } | null>(null);
  /**
   * The one import slot: native document imports hold their request ID, an
   * open directory-import panel holds FOLDER_IMPORT_SLOT. Every import,
   * delete, LAN and archive gate already checks this ref.
   */
  const nativeImportRef = useRef<string | null>(null);
  const [folderImport, setFolderImport] = useState<{
    port: DirectoryImportPort;
    organization: LibraryOrganization;
    supported: boolean;
  } | null>(null);
  const [folderImportCloseSignal, setFolderImportCloseSignal] = useState(0);
  return { shelfBusy, setShelfBusy, shelfBusyMessage, setShelfBusyMessage, nativeImport, setNativeImport, nativeImportRef, folderImport, setFolderImport, folderImportCloseSignal, setFolderImportCloseSignal };
}

type ImportState = ReturnType<typeof useBookImportState>;
type SetNotice = Dispatch<SetStateAction<ShelfNotice>>;
type SetEntries = Dispatch<SetStateAction<ShelfEntry[]>>;

/** Commands keep the original dependencies; ref-backed shared gates stay with App. */
export function useBookImport({
  importState: { nativeImport, setNativeImport, nativeImportRef, setShelfBusyMessage, setShelfBusy },
  runtime, isTauriEnv, fileInputRef, shelfBusyRef, shelfEntriesRef,
  contentHashByIdRef, entryByContentHashRef, setShelfEntries, setShelfNotice,
}: {
  importState: ImportState;
  runtime: RuntimeCapabilities;
  isTauriEnv(): boolean;
  fileInputRef: RefObject<HTMLInputElement>;
  shelfBusyRef: MutableRefObject<boolean>;
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  contentHashByIdRef: MutableRefObject<Map<string, string>>;
  entryByContentHashRef: MutableRefObject<Map<string, ShelfEntry>>;
  setShelfEntries: SetEntries;
  setShelfNotice: SetNotice;
}) {
  // ---- 批量导入 EPUB 并入库（逐本有界处理；结束后只刷新一次书架） ----
  const handleImportSources = useCallback(async (sources: ImportSource[]) => {
    const list = sources.filter((source) => {
      const name = source.kind === "file" ? source.file.name : source.name;
      return name.toLowerCase().endsWith(".epub");
    });
    if (list.length === 0 || shelfBusyRef.current) return;
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.import.busy") });
      return;
    }
    shelfBusyRef.current = true;
    // Do not let a fast first import land in the legacy store before the
    // portable activation effect has committed its one-time switch.
    try {
      await activatePortableShelfState();
    } catch {
      // Activation failure keeps the complete legacy mode; its effect reports
      // the visible error and getShelfStore() falls back to the old backend.
    }
    setShelfBusyMessage(uiText("notice.import.running"));
    setShelfBusy(true);
    setShelfNotice(null);
    const imported: ShelfEntry[] = [];
    const accepted: ShelfEntry[] = [];
    const duplicateTitles: string[] = [];
    const failed: string[] = [];
    const store = getShelfStore();

    try {
      if (isTauriEnv()) {
        const paths = list.flatMap((source) => source.kind === "path" ? [source.path] : []);
        if (paths.length !== list.length) {
          throw new Error("桌面版导入必须保留用户选择的源文件路径");
        }
        const batch = await store.importPaths(paths);
        for (const item of batch.results) {
          const source = list[item.inputIndex];
          const fileName = source?.kind === "path" ? source.name : uiText("notice.nthBook", { n: item.inputIndex + 1 });
          if (item.status === "failed") {
            failed.push(uiText("notice.import.itemFailed", { name: fileName, error: item.error || uiText("notice.import.failedShort") }));
            continue;
          }
          if (!item.record) {
            failed.push(uiText("notice.import.itemFailed", { name: fileName, error: uiText("notice.import.noRecord") }));
            continue;
          }
          contentHashByIdRef.current.set(item.record.id, item.record.contentHash ?? item.record.id);
          entryByContentHashRef.current.set(item.record.contentHash ?? item.record.id, item.record);
          accepted.push(item.record);
          if (item.status === "duplicate") {
            duplicateTitles.push(item.record.title || fileName.replace(/\.epub$/i, ""));
          } else {
            imported.push(item.record);
          }
        }
      } else {
        for (const source of list) {
          const fileName = source.kind === "file" ? source.file.name : source.name;
          try {
            if (source.kind !== "file") {
              throw new Error("浏览器预览无法读取原生文件路径");
            }
            const arrayBuffer = await source.file.arrayBuffer();
            const buf = new Uint8Array(arrayBuffer);
            const contentHash = await sha256Hex(buf);

            const duplicate = await findDuplicateEntry({
              incomingHash: contentHash,
              incomingSize: buf.byteLength,
              entries: shelfEntriesRef.current,
              contentHashById: contentHashByIdRef.current,
              entryByContentHash: entryByContentHashRef.current,
              readBook: (id) => store.readBook(id),
              setContentHash: (id, hash) => store.setContentHash(id, hash),
            });

            if (duplicate && duplicate.available !== false) {
              duplicateTitles.push(duplicate.title || fileName.replace(/\.epub$/i, ""));
              continue;
            }

            const b = await loadBook(buf, { selective: true });
            if (b.spine.length === 0) {
              throw new Error("书中没有可阅读的内容（spine 为空）");
            }
            const cover = b.coverHref ? b.resources.get(b.coverHref) : undefined;
            const result = await store.save({
              entry: {
                id: contentHash,
                title: b.metadata.title || fileName.replace(/\.epub$/i, ""),
                creator: b.metadata.creator ?? "",
                language: b.metadata.language || undefined,
                fileName,
                fileSize: buf.byteLength,
                coverMime: cover?.mediaType ?? "",
                contentHash,
                addedAtMs: Date.now(),
              },
              bytes: buf,
              coverBytes: cover?.data,
              coverMime: cover?.mediaType,
            });
            contentHashByIdRef.current.set(result.entry.id, contentHash);
            entryByContentHashRef.current.set(contentHash, result.entry);
            if (result.status === "duplicate") {
              duplicateTitles.push(result.entry.title || fileName.replace(/\.epub$/i, ""));
            } else {
              imported.push(result.entry);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failed.push(
              uiText("notice.import.itemFailed", { name: fileName, error: error instanceof DrmError ? error.message : message })
            );
          }
        }
      }

      let refreshWarning = "";
      if (isTauriEnv() && accepted.length > 0) {
        // Publish both new and rebound rows immediately. A later list failure
        // must not turn an already committed import into an import failure.
        setShelfEntries((previous) => mergeShelfEntries(previous, accepted));
        try {
          const entries = await store.list();
          const existingIds = new Set(shelfEntriesRef.current.map((entry) => entry.id));
          const unavailable = entries.filter((entry) => existingIds.has(entry.id) && entry.available === false);
          setShelfEntries(entries);
          for (const entry of entries) {
            contentHashByIdRef.current.set(entry.id, entry.contentHash ?? entry.id);
            entryByContentHashRef.current.set(entry.contentHash ?? entry.id, entry);
          }
          if (imported.length > 0 && unavailable.length > 0) {
            refreshWarning = uiText("notice.import.oldVersionKept");
          }
        } catch (error) {
          refreshWarning = uiText("notice.import.refreshFailed", { error: bookOpenErrorMessage(error) });
        }
      } else if (imported.length > 0) {
        setShelfEntries((previous) => mergeShelfEntries(previous, imported));
      }
      const notice = formatImportNotice({
        sourceCount: list.length,
        importedCount: imported.length,
        duplicateTitles,
        failed,
        refreshedCount: isTauriEnv() ? duplicateTitles.length : 0,
      });
      if (refreshWarning) {
        notice.text += uiText("notice.sep") + refreshWarning;
        if (notice.kind === "ok") notice.kind = "warn";
      }
      setShelfNotice(notice);
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.import.failed", { error: String(error) }) });
    } finally {
      shelfBusyRef.current = false;
      setShelfBusy(false);
    }
  }, []);

  const runNativeDocumentImport = useCallback(async (
    documents: AndroidDocumentSelection[],
    options: { silentError?: boolean } = {}
  ): Promise<AndroidImportBatchResult | null> => {
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.import.busy") });
      return null;
    }
    const requestId = createNativeImportRequestId();
    nativeImportRef.current = requestId;
    setNativeImport({
      requestId,
      phase: "starting",
      completed: 0,
      total: documents.length,
      cancelState: "idle",
      collapsed: false,
      fileNameSummary: documents.length === 1 ? uiText("notice.import.oneEpub") : uiPlural("notice.import.files", documents.length, { count: documents.length }),
    });
    try {
      return await importDocuments(requestId, documents, (progress) => {
        setNativeImport((previous) => (
          previous && previous.requestId === progress.requestId
            ? { ...previous, phase: progress.phase, completed: progress.completed, total: progress.total }
            : previous
        ));
      });
    } catch (error) {
      const nativeError = error as AndroidNativeImportError;
      if (nativeError.requiresReload) {
        try {
          const entries = await getShelfStore().list();
          setShelfEntries(entries);
        } catch {
          // Keep the error visible even if the refresh fails.
        }
      }
      if (!options.silentError) {
        setShelfNotice({ kind: "error", text: uiText("notice.import.failed", { error: nativeError.message }) });
      }
      return null;
    } finally {
      nativeImportRef.current = null;
      setNativeImport(null);
    }
  }, []);

  const applyNativeImportBatch = useCallback(async (batch: AndroidImportBatchResult, documents: AndroidDocumentSelection[]): Promise<void> => {
    const imported: ShelfEntry[] = [];
    const accepted: ShelfEntry[] = [];
    const duplicateTitles: string[] = [];
    const failed: string[] = [];
    const cancelled: string[] = [];
    for (const item of batch.results) {
      const document = documents[item.inputIndex];
      const label = document ? displayNameFromContentUri(document.uri) : uiText("notice.nthBook", { n: item.inputIndex + 1 });
      if (item.status === "failed") {
        failed.push(uiText("notice.import.itemFailed", { name: label, error: item.error || uiText("notice.import.failedShort") }));
        continue;
      }
      if (item.status === "cancelled") {
        cancelled.push(label);
        continue;
      }
      if (!item.record) {
        failed.push(uiText("notice.import.itemFailed", { name: label, error: uiText("notice.import.noRecord") }));
        continue;
      }
      accepted.push(item.record);
      if (item.status === "duplicate") {
        duplicateTitles.push(item.record.title || label);
      } else {
        imported.push(item.record);
      }
    }
    if (accepted.length > 0) {
      const store = getShelfStore();
      const entries = store.importRecords ? await store.importRecords(accepted) : accepted;
      for (const entry of entries) {
        contentHashByIdRef.current.set(entry.id, entry.contentHash ?? entry.id);
        entryByContentHashRef.current.set(entry.contentHash ?? entry.id, entry);
      }
      setShelfEntries((previous) => mergeShelfEntries(previous, entries));
    }
    const notice = formatImportNotice({
      sourceCount: documents.length,
      importedCount: imported.length,
      duplicateTitles,
      failed,
      refreshedCount: duplicateTitles.length,
    });
    if (cancelled.length > 0) {
      notice.text += uiText("notice.sep") + uiPlural("notice.import.cancelledCount", cancelled.length, { count: cancelled.length });
      if (notice.kind === "ok") notice.kind = "warn";
    }
    setShelfNotice(notice);
  }, []);

  const handleCancelNativeImport = useCallback(async (): Promise<void> => {
    const current = nativeImport;
    if (!current || current.phase !== "preparing" || current.cancelState !== "idle") return;
    setNativeImport((previous) => (
      previous && previous.requestId === current.requestId
        ? { ...previous, cancelState: "requesting" }
        : previous
    ));
    try {
      const status = await cancelDocumentImport(current.requestId);
      setNativeImport((previous) => (
        previous && previous.requestId === current.requestId
          ? { ...previous, cancelState: status === "too_late" ? "too_late" : previous.cancelState }
          : previous
      ));
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.import.cancelFailed", { error: String(error) }) });
      setNativeImport((previous) => (
        previous && previous.requestId === current.requestId
          ? { ...previous, cancelState: "idle" }
          : previous
      ));
    }
  }, [nativeImport]);

  const handleToggleNativeImportCollapsed = useCallback((): void => {
    setNativeImport((previous) => (
      previous ? { ...previous, collapsed: !previous.collapsed } : previous
    ));
  }, []);

  const reimportAndroidMissing = useCallback(async (entry: ShelfEntry): Promise<ShelfEntry | null> => {
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.import.busy") });
      return null;
    }
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      title: uiText("notice.reimport.title", { title: entry.title }),
    });
    const uri = Array.isArray(selected) ? selected[0] : selected;
    if (!uri) return null;
    const documents: AndroidDocumentSelection[] = [{ uri }];
    const batch = await runNativeDocumentImport(documents);
    if (!batch) return null;
    const wanted = entry.contentHash && /^[a-f0-9]{64}$/.test(entry.contentHash)
      ? entry.contentHash
      : /^[a-f0-9]{64}$/.test(entry.id)
        ? entry.id
        : null;
    const match = batch.results.find((item) =>
      (item.status === "saved" || item.status === "duplicate") &&
      item.record &&
      (wanted ? item.record.contentHash === wanted : true)
    );
    if (!match?.record) {
      const cancelled = batch.results.some((item) => item.status === "cancelled");
      setShelfNotice({
        kind: cancelled ? "warn" : "error",
        text: cancelled
          ? uiText("notice.reimport.cancelled", { title: entry.title })
          : uiText("notice.reimport.mismatch", { title: entry.title }),
      });
      return null;
    }
    const store = getShelfStore();
    const [restored] = store.importRecords ? await store.importRecords([match.record]) : [match.record];
    contentHashByIdRef.current.set(restored.id, restored.contentHash ?? restored.id);
    entryByContentHashRef.current.set(restored.contentHash ?? restored.id, restored);
    setShelfEntries((previous) => mergeShelfEntries(previous, [restored]));
    return restored;
  }, [runNativeDocumentImport]);

  const handleChooseBooks = useCallback(async () => {
    if (!isTauriEnv()) {
      fileInputRef.current?.click();
      return;
    }
    if (runtime.platform === "android") {
      if (nativeImportRef.current) {
        setShelfNotice({ kind: "warn", text: uiText("notice.import.busy") });
        return;
      }
      try {
        const selected = await openFileDialog({
          multiple: true,
          directory: false,
          title: uiText("notice.picker.chooseEpub"),
        });
        const uris = (Array.isArray(selected) ? selected : selected ? [selected] : []).filter(
          (value): value is string => typeof value === "string" && value.length > 0
        );
        if (uris.length === 0) return;
        const documents: AndroidDocumentSelection[] = uris.map((uri) => ({ uri }));
        const batch = await runNativeDocumentImport(documents);
        if (batch) await applyNativeImportBatch(batch, documents);
      } catch (error) {
        setShelfNotice({ kind: "error", text: uiText("notice.picker.failed", { error: String(error) }) });
      }
      return;
    }
    try {
      const selected = await openFileDialog({
        multiple: true,
        directory: false,
        title: uiText("notice.picker.chooseEpub"),
        filters: [{ name: uiText("notice.picker.epubFilter"), extensions: ["epub"] }],
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (paths.length === 0) return;
      await handleImportSources(
        paths.map((path) => ({
          kind: "path" as const,
          path,
          name: path.split(/[\\/]/).pop() || "book.epub",
        }))
      );
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.picker.failed", { error: String(error) }) });
    }
  }, [applyNativeImportBatch, handleImportSources, runNativeDocumentImport]);

  return { handleImportSources, handleCancelNativeImport, handleToggleNativeImportCollapsed, reimportAndroidMissing, handleChooseBooks };
}

export function useFolderImport({
  importState: { nativeImportRef, setFolderImport },
  shelfBusyRef, organizationBusyRef, saveFileJobStateRef, saveFileLaunchRef, lanSaveActiveRef,
  isTauriEnv, setShelfNotice, refreshShelfProjection,
}: {
  importState: ImportState;
  shelfBusyRef: MutableRefObject<boolean>;
  organizationBusyRef: MutableRefObject<boolean>;
  saveFileJobStateRef: MutableRefObject<ReturnType<typeof useSaveFileJob>["state"]>;
  saveFileLaunchRef: MutableRefObject<boolean>;
  lanSaveActiveRef: MutableRefObject<boolean>;
  isTauriEnv(): boolean;
  setShelfNotice: SetNotice;
  refreshShelfProjection(): Promise<void>;
}) {
  const handleOpenFolderImport = useCallback(async (): Promise<void> => {
    if (shelfBusyRef.current || organizationBusyRef.current || nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.import.busy") });
      return;
    }
    if (saveFileJobStateRef.current.kind !== "idle" || saveFileLaunchRef.current || lanSaveActiveRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.folderImport.blocked") });
      return;
    }
    // Reserve the shared slot before any await; released only when the panel closes.
    nativeImportRef.current = FOLDER_IMPORT_SLOT;
    try {
      if (!isTauriEnv()) {
        // Same as file import: let the portable switch land before the first write.
        await activatePortableShelfState().catch(() => undefined);
      }
      const store = getShelfStore();
      const organizationSnapshot = await store.getOrganization();
      if (isTauriEnv()) {
        setFolderImport({ port: createNativeDirectoryImportPort(), organization: organizationSnapshot, supported: true });
        return;
      }
      const commit = store.commitDirectoryPlacementBatch?.bind(store);
      const port = createWebDirectoryImportPort({
        store: {
          list: () => store.list(),
          save: (input) => store.save(input),
          readBook: (id) => store.readBook(id),
          setContentHash: (id, hash) => store.setContentHash(id, hash),
          getOrganization: () => store.getOrganization(),
          commitDirectoryPlacementBatch: (batch) => {
            if (!commit) throw new Error("当前存储后端不支持目录归档");
            return commit(batch);
          },
        },
      });
      setFolderImport({
        port,
        organization: organizationSnapshot,
        supported: supportsWebDirectoryPicker() && commit !== undefined,
      });
    } catch (error) {
      if (nativeImportRef.current === FOLDER_IMPORT_SLOT) nativeImportRef.current = null;
      setShelfNotice({ kind: "error", text: uiText("notice.folderImport.openFailed", { error: String(error) }) });
    }
  }, []);

  const closeFolderImport = useCallback((): void => {
    setFolderImport(null);
    if (nativeImportRef.current === FOLDER_IMPORT_SLOT) nativeImportRef.current = null;
  }, []);

  /** One real refresh after a started import settles (success, cancel or failure). */
  const handleFolderImportSettled = useCallback((): void => {
    // A failed refresh stays on the shelf as a refresh error with a retry.
    void refreshShelfProjection().catch(() => undefined);
  }, [refreshShelfProjection]);

  return { handleOpenFolderImport, closeFolderImport, handleFolderImportSettled };
}
