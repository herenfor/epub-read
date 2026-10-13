import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createDefaultLibrarySearchRuntime, type LibrarySearchRuntime, type LibrarySearchSnapshot } from "../features/ai/indexing/librarySearchRuntime";
import { detectedLogicalCores, loadCorpusConcurrencyPreference, normalizeCorpusConcurrencyPreference,
  resolveCorpusConcurrency, saveCorpusConcurrencyPreference, type CorpusConcurrencyPreference } from "../features/ai/indexing/corpusConcurrencyPreference";
import { serveArchivePort } from "../platform/archiveWorkerBridge";
import type { RuntimeCapabilities } from "../platform/runtimeCapabilities";
import { getShelfStore, type ShelfEntry } from "./shelf";
import { presentCrossBookHit, type CrossBookPanelResult } from "./crossBookSearch";
import { uiText } from "./localization/UiLanguageProvider";

/**
 * 模块级阅读器闭包工厂：严禁在 App 组件体内内联创建带词法作用域的闭包，
 * 避免 long-lived 的 LibrarySearchRuntime.books 隐式持有 App 内部的 Book / ResourceServer。
 */
function createShelfBookReader(id: string): () => Promise<Uint8Array> {
  return () => getShelfStore().readBook(id);
}

/**
 * Native Android full-library indexing input: the window owns the fixed-book
 * bridge and only transfers a bounded MessagePort to the Worker.
 */
function createShelfBookArchiveInput(id: string): { port: MessagePort; dispose(): void } {
  const channel = new MessageChannel();
  const owner = serveArchivePort(channel.port1, id, invoke);
  return {
    port: channel.port2,
    dispose() {
      try {
        channel.port2.close();
      } catch {
        // Port may already be detached after transfer; owner still owns session cleanup.
      }
      owner.dispose();
    },
  };
}

export function useShelfSearchMode() {
  const [shelfSearchMode, setShelfSearchMode] = useState<"metadata" | "body">("metadata");
  return { shelfSearchMode, setShelfSearchMode };
}

export function useLibrarySearchRuntime(isTauriEnv: () => boolean, readerPriorityBusyRef: MutableRefObject<boolean>) {
  const librarySearchRuntimeRef = useRef<ReturnType<typeof createDefaultLibrarySearchRuntime> | null>(null);
  if (!librarySearchRuntimeRef.current) {
    librarySearchRuntimeRef.current = createDefaultLibrarySearchRuntime(isTauriEnv(), {
      waitUntilRunnable: async (signal) => {
        while (readerPriorityBusyRef.current && !signal.aborted) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
        }
      },
    });
  }
  const librarySearchRuntime = librarySearchRuntimeRef.current;
  const librarySearchSnapshot = useSyncExternalStore(
    librarySearchRuntime.subscribe,
    librarySearchRuntime.getSnapshot,
    librarySearchRuntime.getSnapshot,
  );
  const logicalCores = useMemo(() => detectedLogicalCores(), []);
  const [corpusConcurrencyPreference, setCorpusConcurrencyPreference] = useState(
    () => loadCorpusConcurrencyPreference(undefined, logicalCores),
  );
  const recommendedCorpusConcurrency = useMemo(
    () => resolveCorpusConcurrency({ mode: "automatic", maxConcurrency: 1 }, logicalCores),
    [logicalCores],
  );
  const effectiveCorpusConcurrency = useMemo(
    () => resolveCorpusConcurrency(corpusConcurrencyPreference, logicalCores),
    [corpusConcurrencyPreference, logicalCores],
  );
  useEffect(() => {
    librarySearchRuntime.setConcurrency(effectiveCorpusConcurrency);
    saveCorpusConcurrencyPreference(corpusConcurrencyPreference);
  }, [corpusConcurrencyPreference, effectiveCorpusConcurrency, librarySearchRuntime]);
  return { librarySearchRuntime, librarySearchSnapshot, logicalCores,
    corpusConcurrencyPreference, setCorpusConcurrencyPreference, recommendedCorpusConcurrency };
}

export function useLibrarySearchBooks({ runtime, librarySearchRuntime, shelfEntries }: {
  runtime: RuntimeCapabilities; librarySearchRuntime: LibrarySearchRuntime; shelfEntries: ShelfEntry[];
}) {
  // 全库搜索属于应用级运行时：两个 UI 入口只订阅，不以面板生命周期
  // 启停任务。书架变化只更新候选，下次状态检查/续建会精确补齐。
  useEffect(() => {
    const nativeArchive = runtime.platform === "android" && Boolean(getShelfStore().openArchive);
    librarySearchRuntime.setBooks(shelfEntries
      .filter((entry): entry is ShelfEntry & { contentHash: string } => Boolean(entry.contentHash))
      .map((entry) => ({
        id: entry.id,
        contentHash: entry.contentHash,
        title: entry.title,
        creator: entry.creator,
        language: entry.language,
        available: entry.available !== false,
        fileSize: entry.fileSize,
        read: createShelfBookReader(entry.id),
        ...(nativeArchive
          ? { openArchiveInput: () => createShelfBookArchiveInput(entry.contentHash!) }
          : {}),
      })));
  }, [librarySearchRuntime, shelfEntries]);
}

export function useLibrarySearchResults(librarySearchSnapshot: LibrarySearchSnapshot,
  entryByContentHashRef: MutableRefObject<Map<string, ShelfEntry>>, libraryIndexSignature: string) {
  const crossBookPanelResults = useMemo<CrossBookPanelResult[]>(() =>
    librarySearchSnapshot.results.map((hit) => presentCrossBookHit(
      hit,
      librarySearchSnapshot.query,
      entryByContentHashRef.current.has(hit.contentHash) ? undefined : uiText("notice.search.unbound"),
    )), [librarySearchSnapshot.results, librarySearchSnapshot.query, libraryIndexSignature]);
  return crossBookPanelResults;
}

export function useLibrarySearchActions({ librarySearchRuntime, setSearchNavigationBusy, setShelfSearchMode,
  corpusConcurrencyPreference, setCorpusConcurrencyPreference, logicalCores,
}: {
  librarySearchRuntime: LibrarySearchRuntime;
  setSearchNavigationBusy: Dispatch<SetStateAction<boolean>>;
  setShelfSearchMode: Dispatch<SetStateAction<"metadata" | "body">>;
  corpusConcurrencyPreference: CorpusConcurrencyPreference;
  setCorpusConcurrencyPreference: Dispatch<SetStateAction<CorpusConcurrencyPreference>>;
  logicalCores: number;
}) {
  const handleStartLibraryIndex = useCallback((): void => librarySearchRuntime.startIndex(), [librarySearchRuntime]);
  const handleCancelLibraryIndex = useCallback((): void => librarySearchRuntime.cancelIndex(), [librarySearchRuntime]);
  const handleDeferLibraryIndex = useCallback((): void => librarySearchRuntime.deferIndex(), [librarySearchRuntime]);
  const handleRebuildTextIndex = useCallback((): void => librarySearchRuntime.requestRebuild(), [librarySearchRuntime]);
  const handleClearTextIndex = useCallback((): void => {
    setSearchNavigationBusy(true);
    void librarySearchRuntime.clearIndex().finally(() => setSearchNavigationBusy(false));
  }, [librarySearchRuntime]);
  const handleShelfSearchModeChange = useCallback((mode: "metadata" | "body") => {
    setShelfSearchMode(mode);
    if (mode === "body") void librarySearchRuntime.checkIndex();
  }, [setShelfSearchMode, librarySearchRuntime]);
  const handleCorpusConcurrencyChange = useCallback((mode: "automatic" | "manual", value?: number) => {
    setCorpusConcurrencyPreference(normalizeCorpusConcurrencyPreference({
      mode,
      maxConcurrency: value ?? corpusConcurrencyPreference.maxConcurrency,
    }, logicalCores));
  }, [setCorpusConcurrencyPreference, corpusConcurrencyPreference, logicalCores]);
  const handleLibrarySearchQueryChange = useMemo(() => librarySearchRuntime.setQuery.bind(librarySearchRuntime), [librarySearchRuntime]);
  return { handleStartLibraryIndex, handleCancelLibraryIndex, handleDeferLibraryIndex, handleRebuildTextIndex,
    handleClearTextIndex, handleShelfSearchModeChange, handleCorpusConcurrencyChange, handleLibrarySearchQueryChange };
}
