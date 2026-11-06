import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, stat as statFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { PortablePreferences } from "../core/portableState/portable-state-types";
import type { BookSourceExportError } from "../platform/bookExportNativeBridge";
import { readContentUriText, writeTextContentUri } from "../platform/androidNativeBridge";
import {
  saveFileErrorCode,
  saveFileErrorMessage,
  type SaveExportScope,
  type SaveFileCommitResult,
  type SaveFileLocation,
} from "../platform/saveFileNativeBridge";
import type { RuntimeCapabilities } from "../platform/runtimeCapabilities";
import type { ReaderSettings } from "../render/settings";
import { bookExportErrorNotice, bookExportFileName, bookExportResultNotice, bookExportTargetLabel } from "./bookExportText";
import type { CheckpointedSample } from "./checkpointProgressRepair";
import { noteCloudSyncChange } from "./cloudSync/cloudSyncStore";
import { importSkippedNotice } from "./importSkippedText";
import { exportLibraryArchive, mergeLibraryArchives, parseLibraryArchive } from "./libraryArchive";
import { archiveRecordsForBackend, buildLibraryArchiveWithIssues } from "./libraryArchiveBridge";
import type { LibraryOrganization } from "./libraryOrganization";
import { uiPlural, uiText } from "./localization/UiLanguageProvider";
import type { ScopedProgressWriter } from "./progressWriter";
import {
  activatePortableShelfState,
  getShelfStore,
  readPortablePreferencesSnapshot,
  type ShelfEntry,
  type ShelfProgressPatch,
} from "./shelf";
import { useLanSaveSession } from "./useLanSaveSession";
import type { UseSaveFileJobResult } from "./useSaveFileJob";
import type { useShelfLibrary, useShelfOrganizationActions, ShelfNotice } from "./useShelfLibrary";

export interface SaveFileFlowsDeps {
  runtime: RuntimeCapabilities;
  isTauriEnv: () => boolean;
  settings: ReaderSettings;
  uiScale: number;
  saveFileJob: UseSaveFileJobResult;
  saveFileJobStateRef: MutableRefObject<UseSaveFileJobResult["state"]>;
  saveFileExportSetup: { selectedEntries: ShelfEntry[] } | null;
  setSaveFileExportSetup: Dispatch<SetStateAction<{ selectedEntries: ShelfEntry[] } | null>>;
  saveFileLaunchRef: MutableRefObject<boolean>;
  setLanSaveOpen: Dispatch<SetStateAction<boolean>>;
  setLanSaveSelection: Dispatch<SetStateAction<ShelfEntry[]>>;
  lanSaveSelectionRef: MutableRefObject<ShelfEntry[]>;
  lanSaveActiveRef: MutableRefObject<boolean>;
  nativeImportRef: MutableRefObject<string | null>;
  shelfBusyRef: MutableRefObject<boolean>;
  organizationBusyRef: MutableRefObject<boolean>;
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  organizationRef: MutableRefObject<LibraryOrganization>;
  setShelfBusyMessage: Dispatch<SetStateAction<string>>;
  setShelfBusy: Dispatch<SetStateAction<boolean>>;
  setShelfNotice: Dispatch<SetStateAction<ShelfNotice>>;
  setShelfError: Dispatch<SetStateAction<string | null>>;
  setShelfEntries: Dispatch<SetStateAction<ShelfEntry[]>>;
  setOrganization: Dispatch<SetStateAction<LibraryOrganization>>;
  refreshShelfProjection: ReturnType<typeof useShelfLibrary>["refreshShelfProjection"];
  applyPortablePreferences: (preferences?: PortablePreferences) => boolean;
  resolveContentHashForEntry: ReturnType<typeof useShelfOrganizationActions>["resolveContentHashForEntry"];
  persistShelfProgressRef: MutableRefObject<(explicit?: boolean) => void>;
  progressWriterRef: MutableRefObject<ScopedProgressWriter<CheckpointedSample<ShelfProgressPatch>> | null>;
}

export function useSaveFileFlows({
  runtime,
  isTauriEnv,
  settings,
  uiScale,
  saveFileJob,
  saveFileJobStateRef,
  saveFileExportSetup,
  setSaveFileExportSetup,
  saveFileLaunchRef,
  setLanSaveOpen,
  setLanSaveSelection,
  lanSaveSelectionRef,
  lanSaveActiveRef,
  nativeImportRef,
  shelfBusyRef,
  organizationBusyRef,
  shelfEntriesRef,
  organizationRef,
  setShelfBusyMessage,
  setShelfBusy,
  setShelfNotice,
  setShelfError,
  setShelfEntries,
  setOrganization,
  refreshShelfProjection,
  applyPortablePreferences,
  resolveContentHashForEntry,
  persistShelfProgressRef,
  progressWriterRef,
}: SaveFileFlowsDeps) {
  const chooseSaveFileDestination = useCallback(async (): Promise<SaveFileLocation | null> => {
    const defaultName = `SeLis-${new Date().toISOString().slice(0, 10)}.epubsave`;
    if (runtime.platform === "android") {
      const selected = await saveFileDialog({
        title: uiText("notice.archive.exportTitle"),
        defaultPath: defaultName,
      });
      if (typeof selected !== "string" || selected.length === 0) return null;
      return { kind: "uri", uri: selected };
    }
    if (!isTauriEnv()) return null;
    const selected = await saveFileDialog({
      title: uiText("notice.archive.exportTitle"),
      defaultPath: defaultName,
      filters: [{ name: uiText("notice.archive.filter"), extensions: ["epubsave"] }],
    });
    if (typeof selected !== "string" || selected.length === 0) return null;
    return { kind: "path", path: selected };
  }, [runtime.platform]);

  const chooseSaveFileSource = useCallback(async (): Promise<{
    source: SaveFileLocation;
    label: string;
  } | null> => {
    if (runtime.platform === "android") {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: uiText("notice.archive.importTitle"),
      });
      const uri = Array.isArray(selected) ? selected[0] : selected;
      if (typeof uri !== "string" || uri.length === 0) return null;
      return { source: { kind: "uri", uri }, label: uri.split("/").pop() || uiText("notice.archive.androidDocument") };
    }
    if (!isTauriEnv()) return null;
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      title: uiText("notice.archive.importTitle"),
      filters: [{ name: uiText("notice.archive.filter"), extensions: ["epubsave"] }],
    });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (typeof path !== "string" || path.length === 0) return null;
    return { source: { kind: "path", path }, label: path.split(/[\\/]/).pop() || path };
  }, [runtime.platform]);

  const resolveNativeExportScope = useCallback(async (
    selectedEntries: ShelfEntry[],
    scopeChoice: "all" | "selected",
  ): Promise<{ scope: SaveExportScope; rangeLabel: string }> => {
    let scope: SaveExportScope;
    let rangeLabel: string;
    if (scopeChoice === "selected") {
      if (selectedEntries.length === 0) {
        const error = new Error("没有选中的书可导出") as Error & { code: string };
        error.code = "empty-selection";
        throw error;
      }
      const resolved: string[] = [];
      try {
        for (const entry of selectedEntries) resolved.push(await resolveContentHashForEntry(entry));
      } catch (error) {
        throw new Error(uiText("notice.archive.hashResolveFailed", { error: saveFileErrorMessage(error) }));
      }
      const bookHashes = [...new Set(resolved)];
      if (bookHashes.length === 0) {
        throw new Error(uiText("notice.archive.noContentHash"));
      }
      scope = { kind: "selected", bookHashes };
      rangeLabel = uiPlural("notice.archive.rangeSelected", bookHashes.length, { count: bookHashes.length });
    } else {
      scope = { kind: "all" };
      rangeLabel = uiText("notice.archive.rangeAll");
    }

    try {
      await activatePortableShelfState();
      persistShelfProgressRef.current(true);
      const laneIds = scopeChoice === "selected"
        ? selectedEntries.map((entry) => entry.id)
        : undefined;
      const results = await progressWriterRef.current?.flushBooks(laneIds) ?? [];
      const failed = results.find((result) => result.status === "failed");
      if (failed?.status === "failed") throw failed.error;
    } catch (error) {
      throw new Error(uiText("notice.archive.progressFlushFailed", { error: saveFileErrorMessage(error) }));
    }
    return { scope, rangeLabel };
  }, [resolveContentHashForEntry]);

  const startNativeExport = useCallback(async (
    selectedEntries: ShelfEntry[],
    scopeChoice: "all" | "selected",
    includeBooks: boolean,
  ): Promise<void> => {
    if (saveFileJob.active || saveFileLaunchRef.current || lanSaveActiveRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.busy") });
      return;
    }
    saveFileLaunchRef.current = true;
    try {
    let destination: SaveFileLocation | null = null;
    try {
      destination = await chooseSaveFileDestination();
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.savePickerFailed", { error: saveFileErrorMessage(error) }) });
      return;
    }
    if (!destination) return;

    let scope: SaveExportScope;
    let rangeLabel: string;
    try {
      const prepared = await resolveNativeExportScope(selectedEntries, scopeChoice);
      scope = prepared.scope;
      rangeLabel = prepared.rangeLabel;
    } catch (error) {
      const emptySelection = saveFileErrorCode(error) === "empty-selection";
      setShelfNotice({
        kind: emptySelection ? "warn" : "error",
        text: emptySelection ? uiText("notice.archive.emptySelection") : saveFileErrorMessage(error),
      });
      return;
    }

    try {
      const result = await saveFileJob.beginExport({ destination, scope, includeBooks });
      if (result.status === "cancelled") {
        setShelfNotice({ kind: "warn", text: uiText("notice.archive.exportCancelled") });
        return;
      }
      if (result.skippedBooks.length > 0) {
        const first = result.skippedBooks[0];
        setShelfNotice({
          kind: "warn",
          text: uiText("notice.archive.exportedSkipped", { range: rangeLabel, written: result.writtenBooks, skipped: result.skippedBooks.length, title: first.title, reason: first.reason }),
        });
      } else {
        setShelfNotice({
          kind: "ok",
          text: includeBooks ? uiText("notice.archive.exportedWithBooks", { range: rangeLabel, written: result.writtenBooks }) : uiText("notice.archive.exportedNoBooks", { range: rangeLabel }),
        });
      }
    } catch (error) {
      if (saveFileErrorCode(error) === "cancelled") {
        setShelfNotice({ kind: "warn", text: uiText("notice.archive.exportCancelled") });
        return;
      }
      setShelfNotice({ kind: "error", text: uiText("notice.archive.exportFailed", { error: saveFileErrorMessage(error) }) });
    }
    } finally {
      saveFileLaunchRef.current = false;
    }
  }, [chooseSaveFileDestination, resolveNativeExportScope, saveFileJob]);

  /** SBE-U: copy the shelf's original EPUB files out; one book saves as .epub, several or all as one .zip. */
  const startBookSourceExport = useCallback(async (selectedEntries?: ShelfEntry[]): Promise<void> => {
    if (saveFileJob.active || saveFileLaunchRef.current || lanSaveActiveRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.busy") });
      return;
    }
    if (selectedEntries && selectedEntries.length === 0) return;
    saveFileLaunchRef.current = true;
    try {
      let scope: SaveExportScope = { kind: "all" };
      let single: ShelfEntry | null = null;
      if (selectedEntries) {
        let hashes: string[];
        try {
          hashes = [...new Set(await Promise.all(selectedEntries.map((entry) => resolveContentHashForEntry(entry))))];
        } catch (error) {
          setShelfNotice({ kind: "error", text: uiText("bookExport.failed", { error: saveFileErrorMessage(error) }) });
          return;
        }
        scope = { kind: "selected", bookHashes: hashes };
        if (hashes.length === 1) single = selectedEntries[0];
      }
      const zip = single === null;
      const defaultPath = zip
        ? `SeLis-books-${new Date().toISOString().slice(0, 10)}.zip`
        : bookExportFileName(single!.fileName, single!.title);
      let destination: SaveFileLocation | null = null;
      try {
        // Fail before ACTION_CREATE_DOCUMENT can create an external file.
        await activatePortableShelfState();
      } catch (error) {
        setShelfNotice(bookExportErrorNotice(error as BookSourceExportError));
        return;
      }
      try {
        const selected = await saveFileDialog({
          title: uiText("bookExport.dialogTitle"),
          defaultPath,
          filters: [zip
            ? { name: uiText("bookExport.filter.zip"), extensions: [runtime.platform === "android" ? "application/zip" : "zip"] }
            : { name: uiText("bookExport.filter.epub"), extensions: [runtime.platform === "android" ? (/\.txt$/i.test(defaultPath) ? "text/plain" : /\.(cbz|zip)$/i.test(defaultPath) ? "application/zip" : "application/epub+zip") : defaultPath.split(".").pop()!] }],
        });
        if (typeof selected === "string" && selected.length > 0) {
          destination = runtime.platform === "android" ? { kind: "uri", uri: selected } : { kind: "path", path: selected };
        }
      } catch (error) {
        setShelfNotice({ kind: "error", text: uiText("notice.archive.savePickerFailed", { error: saveFileErrorMessage(error) }) });
        return;
      }
      if (!destination) return;
      try {
        // Android's pinned dialog plugin uses ACTION_CREATE_DOCUMENT; a Windows
        // save path may name an existing target and must never be cleaned as new.
        const result = await saveFileJob.beginBookExport({ destination, scope, destinationIsNew: runtime.platform === "android" });
        setShelfNotice(bookExportResultNotice(result, bookExportTargetLabel(destination)));
      } catch (error) {
        setShelfNotice(bookExportErrorNotice(error as BookSourceExportError));
      }
    } finally {
      saveFileLaunchRef.current = false;
    }
  }, [resolveContentHashForEntry, runtime.platform, saveFileJob]);

  const startNativeImport = useCallback(async (): Promise<void> => {
    if (saveFileJob.active || saveFileLaunchRef.current || lanSaveActiveRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.busy") });
      return;
    }
    saveFileLaunchRef.current = true;
    try {
    let selected: { source: SaveFileLocation; label: string } | null = null;
    try {
      selected = await chooseSaveFileSource();
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.openPickerFailed", { error: saveFileErrorMessage(error) }) });
      return;
    }
    if (!selected) return;
    try {
      await activatePortableShelfState();
      await saveFileJob.beginPrepare({ source: selected.source, sourceLabel: selected.label });
    } catch (error) {
      const code = saveFileErrorCode(error);
      if (code === "cancelled") {
        setShelfNotice({ kind: "warn", text: uiText("notice.archive.importCancelled") });
        return;
      }
      setShelfNotice({ kind: "error", text: uiText("notice.archive.prepareFailed", { error: saveFileErrorMessage(error) }) });
    }
    } finally {
      saveFileLaunchRef.current = false;
    }
  }, [chooseSaveFileSource, saveFileJob]);

  const prepareLanSaveSend = useCallback(async (
    scopeChoice: "all" | "selected",
    _includeBooks: boolean,
  ): Promise<SaveExportScope> => {
    if (saveFileJob.active || saveFileLaunchRef.current) {
      throw new Error("已有存档文件任务正在进行，请等待当前任务结束");
    }
    if (nativeImportRef.current) {
      throw new Error("正在导入书籍，暂不开始设备互传");
    }
    const prepared = await resolveNativeExportScope(lanSaveSelectionRef.current, scopeChoice);
    return prepared.scope;
  }, [resolveNativeExportScope, saveFileJob.active]);

  const applySaveFileCommitResult = useCallback(async (
    result: SaveFileCommitResult,
    applyPreferences: boolean,
  ): Promise<void> => {
    // Archive/LAN commits write in the backend, outside the shelf store.
    noteCloudSyncChange("data-changed");
    let refreshFailed = false;
    try {
      await refreshShelfProjection();
    } catch (error) {
      refreshFailed = true;
      setShelfError(uiText("notice.archive.committedRefreshFailed", { error: saveFileErrorMessage(error) }));
    }

    let preferencesFailed = false;
    let preferencesApplied = false;
    if (applyPreferences && result.appliedPreferences) {
      try {
        const preferences = await readPortablePreferencesSnapshot();
        preferencesApplied = applyPortablePreferences(preferences);
      } catch (error) {
        preferencesFailed = true;
        setShelfNotice({
          kind: "warn",
          text: uiText("notice.archive.preferencesReadFailed", { error: saveFileErrorMessage(error) }),
        });
      }
    }

    if (preferencesFailed) return;
    const conflictNote = result.progressConflictBooks.length > 0
      ? uiText("notice.sep") + uiText("notice.archive.conflicts", { count: result.progressConflictBooks.length })
      : "";
    const preferenceNote = applyPreferences && !result.appliedPreferences
      ? uiText("notice.sep") + uiText("notice.archive.preferencesNotApplied")
      : preferencesApplied
        ? uiText("notice.sep") + uiText("notice.archive.preferencesApplied")
        : "";
    const skippedNote = importSkippedNotice(result.skippedBookCount, result.skippedBooks);
    setShelfNotice({
      kind: skippedNote || refreshFailed || (applyPreferences && !result.appliedPreferences) ? "warn" : "ok",
      text: uiText("notice.archive.imported", { imported: result.importedBooks.length }) + (skippedNote ? uiText("notice.sep") + skippedNote : "") + conflictNote + preferenceNote + (refreshFailed ? uiText("notice.sep") + uiText("notice.shelf.refreshFailedShort") : ""),
    });
  }, [applyPortablePreferences, refreshShelfProjection]);

  const lanSaveSession = useLanSaveSession({
    prepareSend: prepareLanSaveSend,
    onImportCommitted: applySaveFileCommitResult,
  });
  lanSaveActiveRef.current = lanSaveSession.active;

  const handleSaveFileImportConfirm = useCallback(async (applyPreferences: boolean): Promise<void> => {
    if (saveFileJobStateRef.current.kind !== "prepared") return;
    try {
      const result = await saveFileJob.commit(applyPreferences);
      await applySaveFileCommitResult(result, applyPreferences);
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.importFailed", { error: saveFileErrorMessage(error) }) });
    }
  }, [applySaveFileCommitResult, saveFileJob]);

  const handleOpenLanSave = useCallback((selectedEntries?: ShelfEntry[]): void => {
    if (lanSaveActiveRef.current) { setLanSaveOpen(true); return; }
    if (saveFileJobStateRef.current.kind !== "idle" || saveFileLaunchRef.current || nativeImportRef.current) return;
    const selection = selectedEntries ?? [];
    lanSaveSelectionRef.current = selection;
    setLanSaveSelection(selection);
    setLanSaveOpen(true);
  }, []);

  const closeLanSavePanel = useCallback((): void => {
    setLanSaveOpen(false);
    void lanSaveSession.close();
  }, [lanSaveSession]);

  const closeSaveFileUi = useCallback(async (): Promise<void> => {
    setSaveFileExportSetup(null);
    const current = saveFileJobStateRef.current;
    if (current.kind === "idle" || current.kind === "committing") return;
    try {
      await saveFileJob.cancelCurrent();
    } catch (error) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.cancelFailed", { error: saveFileErrorMessage(error) }) });
    }
  }, [saveFileJob]);

  const handleSaveFileExportConfirm = useCallback(async (
    scope: "all" | "selected",
    includeBooks: boolean,
  ): Promise<void> => {
    const setup = saveFileExportSetup;
    setSaveFileExportSetup(null);
    if (!setup) return;
    await startNativeExport(setup.selectedEntries, scope, includeBooks);
  }, [saveFileExportSetup, startNativeExport]);

  const handleLegacyExportArchive = useCallback(async () => {
    if (organizationBusyRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archive.savingOrganization") });
      return;
    }
    try {
      const built = buildLibraryArchiveWithIssues(
        shelfEntriesRef.current,
        organizationRef.current,
        {
          ...settings,
          uiScale,
        }
      );
      if (built.skipped.length > 0) {
        throw new Error(`有 ${built.skipped.length} 条书架记录缺少有效内容指纹`);
      }
      const text = exportLibraryArchive(built.archive);
      if (runtime.platform === "android") {
        const uri = await saveFileDialog({
          title: uiText("notice.legacy.exportTitle"),
          defaultPath: `SeLis-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: uiText("notice.archive.filter"), extensions: ["application/json", "json"] }],
        });
        if (!uri || Array.isArray(uri)) return;
        await writeTextContentUri(uri, text);
      } else if (isTauriEnv()) {
        const path = await saveFileDialog({
          title: uiText("notice.legacy.exportTitle"),
          defaultPath: `SeLis-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: uiText("notice.archive.filter"), extensions: ["json"] }],
        });
        if (!path) return;
        await writeTextFile(path, text);
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `SeLis-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setShelfNotice({
        kind: "ok",
        text: uiText("notice.legacy.exported", { count: Object.keys(built.archive.records).length }),
      });
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.exportFailed", { error: String(error) }) });
    }
  }, [settings, uiScale]);

  const handleLegacyImportArchive = useCallback(async () => {
    if (shelfBusyRef.current || organizationBusyRef.current) return;
    if (nativeImportRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.legacy.importBlocked") });
      return;
    }
    shelfBusyRef.current = true;
    organizationBusyRef.current = true;
    setShelfBusyMessage(uiText("notice.legacy.importing"));
    setShelfBusy(true);
    try {
      let text: string | null = null;
      if (runtime.platform === "android") {
        const selected = await openFileDialog({
          multiple: false,
          directory: false,
          title: uiText("notice.legacy.importTitle"),
        });
        const uri = Array.isArray(selected) ? selected[0] : selected;
        if (uri) {
          text = await readContentUriText(uri, 16 * 1024 * 1024);
        }
      } else if (isTauriEnv()) {
        const path = await openFileDialog({
          multiple: false,
          directory: false,
          title: uiText("notice.legacy.importTitle"),
          filters: [{ name: uiText("notice.archive.filter"), extensions: ["json"] }],
        });
        if (path && !Array.isArray(path)) {
          if ((await statFile(path)).size > 16 * 1024 * 1024) {
            throw new Error("存档文件超过 16 MiB，已拒绝读取");
          }
          text = await readTextFile(path);
        }
      } else {
        text = await new Promise<string | null>((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "application/json,.json";
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) resolve(null);
            else if (file.size > 16 * 1024 * 1024) {
              setShelfNotice({ kind: "error", text: uiText("notice.legacy.tooLarge") });
              resolve(null);
            } else void file.text().then(resolve, () => resolve(null));
          };
          input.addEventListener("cancel", () => resolve(null), { once: true });
          input.click();
        });
      }
      if (text === null) return;
      const incoming = parseLibraryArchive(text);
      if (incoming.errors.length > 0) {
        const first = incoming.errors[0];
        throw new Error(`存档解析失败（${first.path}：${first.message}，共 ${incoming.errors.length} 项错误）`);
      }

      const current = buildLibraryArchiveWithIssues(
        shelfEntriesRef.current,
        organizationRef.current,
        {
          ...settings,
          uiScale,
        }
      );
      if (current.skipped.length > 0) {
        throw new Error(`当前书架有 ${current.skipped.length} 条记录缺少有效内容指纹`);
      }

      // 预检查组织数据合并
      mergeLibraryArchives(current.archive, incoming.archive);

      // 记录与 organization 必须在本机仓储边界内一并合并；旧 v3 进度不被旧包导入时间覆盖。
      let unavailableCount = 0;
      let skippedCount = 0;
      let skippedNote = "";
      try {
        const store = getShelfStore();
        const imported = await store.replacePortableRecords(
          archiveRecordsForBackend(incoming.archive),
          incoming.archive.organization,
        );
        const nextEntries = imported.entries;
        unavailableCount = nextEntries.filter((entry) => entry.available === false).length;
        skippedCount = Math.max(imported.skippedBookCount, imported.skippedBooks.length);
        skippedNote = importSkippedNotice(imported.skippedBookCount, imported.skippedBooks);
        setShelfEntries(nextEntries);
        setOrganization(await store.getOrganization());
      } catch (err) {
        throw new Error(`书籍记录与组织导入失败：${String(err)}`);
      }

      setShelfNotice({
        kind: unavailableCount > 0 || skippedNote ? "warn" : "ok",
        text: uiText("notice.legacy.imported", { count: Math.max(0, Object.keys(incoming.archive.records).length - skippedCount) }) + (skippedNote ? uiText("notice.sep") + skippedNote : "") + (unavailableCount > 0 ? uiText("notice.sep") + uiText("notice.legacy.relocate", { count: unavailableCount }) : "") + uiText("notice.sep") + uiText("notice.legacy.preferencesNotApplied"),
      });
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.archive.importFailed", { error: String(error) }) });
    } finally {
      shelfBusyRef.current = false;
      organizationBusyRef.current = false;
      setShelfBusy(false);
    }
  }, [settings, uiScale]);

  const handleExportArchive = useCallback((selectedEntries?: ShelfEntry[]): void => {
    if (runtime.platform === "web" || !isTauriEnv()) {
      void handleLegacyExportArchive();
      return;
    }
    if (saveFileJob.active) {
      setShelfNotice({ kind: "warn", text: uiText("notice.archiveFile.busy") });
      return;
    }
    setSaveFileExportSetup({ selectedEntries: selectedEntries ?? [] });
  }, [handleLegacyExportArchive, runtime.platform, saveFileJob.active]);

  const handleImportArchive = useCallback((): void => {
    if (runtime.platform === "web" || !isTauriEnv()) {
      void handleLegacyImportArchive();
      return;
    }
    void startNativeImport();
  }, [handleLegacyImportArchive, runtime.platform, startNativeImport]);

  return {
    startBookSourceExport,
    handleOpenLanSave,
    closeLanSavePanel,
    closeSaveFileUi,
    handleSaveFileImportConfirm,
    handleSaveFileExportConfirm,
    handleLegacyImportArchive,
    handleExportArchive,
    handleImportArchive,
    lanSaveSession,
  };
}
