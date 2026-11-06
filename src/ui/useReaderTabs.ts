import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { LibraryLoadState } from "./libraryLoad";
import { uiText } from "./localization/UiLanguageProvider";
import { pageOpenMs } from "./menuMotion";
import type { PanelWarmStage } from "./panelPaintWarmup";
import {
  MAX_READER_TABS,
  READER_TABS_STORAGE_KEY,
  activeReaderTabs,
  closeReaderTab,
  closeReaderTabAfterLeave,
  parseReaderTabs,
  placeReaderTab,
  pruneReaderTabs,
  serializeReaderTabs,
  type ReaderTabsState,
} from "./readerTabs";
import type { ShelfEntry } from "./shelf";
import { readShelfPlaceLabel } from "./shelfPlaceCache";
import { shelfProgressLabel } from "./shelfProgressDisplay";
import { activeShelfSpace } from "./shelfSpaces";

export function useReaderTabsState() {
  const [readerTabs, setReaderTabs] = useState(() => {
    try {
      return parseReaderTabs(localStorage.getItem(READER_TABS_STORAGE_KEY));
    } catch {
      return parseReaderTabs(null);
    }
  });
  /** 切标签时目标书的开书画面先浮在旧书上，书架不在“离开 → 开书”之间露出来；开书进入解析或中途作罢即撤。 */
  const [tabSwitchOpening, setTabSwitchOpening] = useState<{ title: string; creator: string } | null>(null);
  return { readerTabs, setReaderTabs, tabSwitchOpening, setTabSwitchOpening };
}

export function useReaderTabActions({
  view,
  currentShelfId,
  libraryLoad,
  shelfEntries,
  readerTabsVisible,
  readerTabs,
  setReaderTabs,
  setTabSwitchOpening,
  shelfEntriesRef,
  shelfBusyRef,
  currentShelfIdRef,
  leaveReader,
  handleShelfOpen,
  warming,
}: {
  view: "shelf" | "reader";
  currentShelfId: string | null;
  libraryLoad: LibraryLoadState;
  shelfEntries: ShelfEntry[];
  readerTabsVisible: boolean;
  readerTabs: ReaderTabsState;
  setReaderTabs: Dispatch<SetStateAction<ReaderTabsState>>;
  setTabSwitchOpening: Dispatch<SetStateAction<{ title: string; creator: string } | null>>;
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  shelfBusyRef: MutableRefObject<boolean>;
  currentShelfIdRef: MutableRefObject<string | null>;
  leaveReader: (leaveUnsaved: boolean, animate?: boolean, covered?: Promise<void>) => Promise<boolean>;
  handleShelfOpen: (id: string) => Promise<void>;
  warming: (stage: PanelWarmStage) => boolean;
}) {
  const readerTabsRef = useRef(readerTabs);
  readerTabsRef.current = readerTabs;
  const pendingTabOpenRef = useRef<string | null>(null);
  /** 下一本进阅读器的书要新开一个标签（其余打开都替换当前这本）。 */
  const pendingNewTabRef = useRef<string | null>(null);
  /** 从“＋”回书架挑书：挑中的书新开标签，取消就回到原来那本。 */
  const [tabPick, setTabPick] = useState<{ returnId: string | null } | null>(null);
  useEffect(() => {
    // Another shelf's tabs never reach browser storage; the library's stay as saved.
    if (!activeShelfSpace().policy.persistsBrowserState) return;
    try {
      localStorage.setItem(READER_TABS_STORAGE_KEY, serializeReaderTabs(readerTabs));
    } catch {
      // 本机便利功能：写不进存储只影响重启后恢复标签。
    }
  }, [readerTabs]);
  useEffect(() => {
    if (view !== "reader" || !currentShelfId) return;
    const mode = pendingNewTabRef.current === currentShelfId ? "new" : "replace";
    pendingNewTabRef.current = null;
    setTabPick(null);
    setReaderTabs((state) => placeReaderTab(state, currentShelfId, mode));
  }, [currentShelfId, view]);
  useEffect(() => {
    if (libraryLoad.status !== "ready") return;
    const ids = new Set(shelfEntries.map((entry) => entry.id));
    setReaderTabs((state) => pruneReaderTabs(state, (id) => ids.has(id)));
  }, [libraryLoad.status, shelfEntries]);
  /** 开书画面在旧书上浮入；返回它完全盖住的时刻（没有目标书就不等）。 */
  const coverTabSwitch = useCallback((id: string | null): Promise<void> => {
    const entry = id ? shelfEntriesRef.current.find((item) => item.id === id) : undefined;
    setTabSwitchOpening(entry ? { title: entry.title || entry.fileName, creator: entry.creator } : null);
    if (!entry) return Promise.resolve();
    // 画面在下一帧挂上才开始浮入，多留一帧。
    return new Promise((resolve) => window.setTimeout(resolve, pageOpenMs() + 16));
  }, []);
  const switchReaderTab = useCallback(async (id: string | null): Promise<void> => {
    if (id === currentShelfIdRef.current || shelfBusyRef.current) return;
    if (!(await leaveReader(false, false, coverTabSwitch(id)))) {
      setTabSwitchOpening(null);
      return;
    }
    pendingTabOpenRef.current = id;
  }, [coverTabSwitch, leaveReader]);
  const closeReaderTabById = useCallback((id: string): void => {
    if (shelfBusyRef.current) return;
    if (id !== currentShelfIdRef.current) {
      setReaderTabs((state) => closeReaderTab(state, id).state);
      return;
    }
    const covered = coverTabSwitch(closeReaderTab(readerTabsRef.current, id).next);
    void closeReaderTabAfterLeave(readerTabsRef.current, id, async () => {
      const left = await leaveReader(false, false, covered);
      if (!left) setTabSwitchOpening(null);
      return left;
    }, ({ next }) => {
      setReaderTabs((state) => closeReaderTab(state, id).state);
      pendingTabOpenRef.current = next;
    });
  }, [coverTabSwitch, leaveReader]);
  const openReaderTabFromReader = useCallback((id: string): void => {
    if (activeReaderTabs(readerTabsRef.current).tabs.length >= MAX_READER_TABS) return;
    pendingNewTabRef.current = id;
    void switchReaderTab(id);
  }, [switchReaderTab]);
  const pickReaderTabFromShelf = useCallback(async (): Promise<void> => {
    if (shelfBusyRef.current) return;
    const returnId = currentShelfIdRef.current;
    if (!(await leaveReader(false))) return;
    setTabPick({ returnId });
  }, [leaveReader]);
  const openFromShelf = useCallback((id: string): void => {
    if (tabPick) pendingNewTabRef.current = id;
    void handleShelfOpen(id);
  }, [handleShelfOpen, tabPick]);
  const shelfReaderTabs = useMemo(() => {
    if (!readerTabsVisible) return undefined;
    const group = activeReaderTabs(readerTabs);
    const returnEntry = tabPick?.returnId ? shelfEntries.find((entry) => entry.id === tabPick.returnId) : undefined;
    return {
      openIds: new Set(group.tabs) as ReadonlySet<string>,
      full: group.tabs.length >= MAX_READER_TABS,
      max: MAX_READER_TABS,
      onOpenInNewTab: (id: string) => {
        if (group.tabs.length >= MAX_READER_TABS && !group.tabs.includes(id)) return;
        pendingNewTabRef.current = id;
        void handleShelfOpen(id);
      },
      pick: tabPick
        ? {
            count: group.tabs.length,
            returnTitle: returnEntry?.title ?? null,
            onCancel: () => {
              setTabPick(null);
              if (returnEntry) void handleShelfOpen(returnEntry.id);
            },
          }
        : null,
    };
  }, [handleShelfOpen, readerTabs, readerTabsVisible, shelfEntries, tabPick]);
  const readerTabStrip = useMemo(() => {
    if (!readerTabsVisible) return undefined;
    const entries = new Map(shelfEntries.map((entry) => [entry.id, entry] as const));
    const detail = (entry: ShelfEntry): string => {
      const place = readShelfPlaceLabel(entry.contentHash ?? entry.id, entry.spineIndex ?? 0);
      const progress = shelfProgressLabel(entry);
      return place ? uiText("shelf.resume.place", { chapter: place, progress }) : progress;
    };
    const group = activeReaderTabs(readerTabs);
    const open = new Set(group.tabs);
    return {
      tabs: group.tabs
        .filter((id) => entries.has(id))
        .map((id) => ({ id, title: entries.get(id)!.title || id, detail: detail(entries.get(id)!) })),
      activeId: currentShelfId,
      max: MAX_READER_TABS,
      recent: shelfEntries
        .filter((entry) => !open.has(entry.id) && entry.lastReadAtMs > 0 && entry.available !== false)
        .sort((a, b) => b.lastReadAtMs - a.lastReadAtMs)
        .slice(0, MAX_READER_TABS)
        .map((entry) => ({ id: entry.id, title: entry.title || entry.id, detail: detail(entry) })),
      onSelect: (id: string) => void switchReaderTab(id),
      onClose: closeReaderTabById,
      onOpenNew: openReaderTabFromReader,
      onPickFromShelf: () => void pickReaderTabFromShelf(),
      warm: warming("reader-tabs"),
    };
  }, [closeReaderTabById, currentShelfId, openReaderTabFromReader, pickReaderTabFromShelf, readerTabs,
    readerTabsVisible, shelfEntries, switchReaderTab, warming]);
  const takePendingOpen = useCallback((): string | null => {
    const id = pendingTabOpenRef.current;
    pendingTabOpenRef.current = null;
    return id;
  }, []);
  return {
    readerTabsRef,
    setTabPick,
    coverTabSwitch,
    switchReaderTab,
    closeReaderTabById,
    openReaderTabFromReader,
    pickReaderTabFromShelf,
    openFromShelf,
    shelfReaderTabs,
    readerTabStrip,
    takePendingOpen,
  };
}
