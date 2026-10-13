import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { uiText } from "./localization/UiLanguageProvider";
import { shouldConfirmNoteDiscard } from "./readerCloseGuards";
import {
  closeReaderForeground,
  openNoteComposer,
  openReaderPanel,
  openReaderTransient,
  setMenuSubview,
  stepBackFromMenuSubview,
  type MenuSubview,
  type NoteComposerDraft,
  type ReaderForeground,
  type ReaderPanelId,
} from "./readerForeground";
import type { ReaderHandle } from "./ReaderView";
import type { SidebarMode, SidebarTab } from "./SidebarDrawer";
import { createSidebarNavigationMemory, type SidebarNavigationMemory } from "./sidebarSwipe";

/** Kept separate from commands so App retains its state/effect ordering. */
export function useReaderForegroundState() {
  return useState<ReaderForeground>({ kind: "none" });
}

export function readerForegroundSurfaces(foreground: ReaderForeground) {
  // All reader-facing surfaces share one discriminated state. These values
  // are deliberately derived, never independently writable booleans.
  const menuOpen = foreground.kind === "panel" && foreground.panel === "menu";
  const fontSettingsOpen = foreground.kind === "panel" && foreground.panel === "menu" && foreground.view === "fonts";
  const displaySettingsOpen = foreground.kind === "panel" && foreground.panel === "menu" && foreground.view === "extras";
  const tocOpen = foreground.kind === "panel" && foreground.panel === "toc";
  const bookmarkMenuOpen = foreground.kind === "panel" && foreground.panel === "bookmarks";
  const searchOpen = foreground.kind === "panel" && foreground.panel === "search";
  const notesOpen = foreground.kind === "panel" && foreground.panel === "notes";
  const logOpen = foreground.kind === "panel" && foreground.panel === "log";
  const assistantOpen = foreground.kind === "panel" && foreground.panel === "assistant";
  const readingSettingsOpen = foreground.kind === "panel" && foreground.panel === "reading";

  const selectionContext = foreground.kind === "transient" && foreground.transient === "selection"
    ? foreground.payload
    : null;
  const footnote = foreground.kind === "transient" && foreground.transient === "footnote"
    ? foreground.payload
    : null;
  const noteComposer = foreground.kind === "modal" && foreground.modal === "note-composer"
    ? foreground.draft
    : null;

  return {
    menuOpen, fontSettingsOpen, displaySettingsOpen, tocOpen, bookmarkMenuOpen,
    searchOpen, notesOpen, logOpen, assistantOpen, readingSettingsOpen,
    selectionContext, footnote, noteComposer,
  };
}

interface ForegroundWiring {
  foregroundRef: MutableRefObject<ReaderForeground>;
  setForeground: Dispatch<SetStateAction<ReaderForeground>>;
  overlayHoverRef: MutableRefObject<boolean>;
  /** App creates this reader ref later in the render; resolve it only on input. */
  reader(): Pick<ReaderHandle, "dismissFootnote" | "clearTextSelection"> | null;
  /** The note domain owns its edit lease; it runs before foreground cleanup. */
  beforeOpenComposer(draft: NoteComposerDraft): void;
  noteComposerDirtyRef: MutableRefObject<boolean>;
}

/**
 * Host functions read mount-stable refs, including the reader created later by App.
 * Keep the original callback dependencies and functional-update ordering.
 */
export function useReaderForeground({
  foregroundRef, setForeground, overlayHoverRef, reader, beforeOpenComposer, noteComposerDirtyRef,
}: ForegroundWiring) {
  const openPanel = useCallback((panel: ReaderPanelId): void => {
    const current = foregroundRef.current;
    if (current.kind === "transient" && current.transient === "footnote") {
      overlayHoverRef.current = false;
      reader()?.dismissFootnote();
    } else if (current.kind === "transient" && current.transient === "selection") {
      reader()?.clearTextSelection();
    }
    setForeground((current) => openReaderPanel(current, panel));
  }, []);
  const openTransient = useCallback(
    (transient: "selection" | "footnote", payload: Parameters<typeof openReaderTransient>[2]): void => {
      const current = foregroundRef.current;
      if (current.kind === "transient" && current.transient === "footnote" && transient === "selection") {
        overlayHoverRef.current = false;
        reader()?.dismissFootnote();
      } else if (current.kind === "transient" && current.transient === "selection" && transient === "footnote") {
        reader()?.clearTextSelection();
      }
      setForeground((state) => openReaderTransient(state, transient, payload));
    },
  []);
  const openComposer = useCallback((draft: NoteComposerDraft): void => {
    beforeOpenComposer(draft);
    const current = foregroundRef.current;
    if (current.kind === "transient" && current.transient === "footnote") {
      overlayHoverRef.current = false;
      reader()?.dismissFootnote();
    } else if (current.kind === "transient" && current.transient === "selection") {
      reader()?.clearTextSelection();
    }
    setForeground((state) => openNoteComposer(state, draft));
  }, []);
  const closePanel = useCallback((panel: ReaderPanelId): void => {
    setForeground((current) =>
      current.kind === "panel" && current.panel === panel ? closeReaderForeground() : current
    );
  }, []);
  const closeForeground = useCallback((): void => {
    setForeground(closeReaderForeground());
    overlayHoverRef.current = false;
    reader()?.dismissFootnote();
  }, []);

  /** 统一前景关闭入口：笔记未保存时确认放弃，其他层直接关闭。 */
  const requestCloseForeground = useCallback((): void => {
    const current = foregroundRef.current;
    if (shouldConfirmNoteDiscard(current, noteComposerDirtyRef.current)) {
      if (typeof window !== "undefined" && !window.confirm(uiText("notice.discardNote"))) return;
    }
    closeForeground();
  }, [closeForeground]);

  const showMenuSubview = useCallback((view: MenuSubview): void => {
    setForeground((current) => setMenuSubview(current, view));
  }, []);

  return { openPanel, openTransient, openComposer, closePanel, closeForeground, requestCloseForeground, showMenuSubview };
}

interface SidebarWiring {
  foreground: ReaderForeground;
  foregroundRef: MutableRefObject<ReaderForeground>;
  setForeground: Dispatch<SetStateAction<ReaderForeground>>;
  view: "shelf" | "reader";
  phoneChrome: boolean;
  mobileChrome: boolean;
  sidebarBookKey: string;
  openPanel(panel: ReaderPanelId): void;
  closeForeground(): void;
  requestCloseForeground(): void;
}

/** Sidebar preferences and per-book scroll memories remain local to this App mount. */
export function useReaderSidebar({
  foreground, foregroundRef, setForeground, view, phoneChrome, mobileChrome, sidebarBookKey,
  openPanel, closeForeground, requestCloseForeground,
}: SidebarWiring) {
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("toc");
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">("left");
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("overlay");
  const [sidebarPinned, setSidebarPinned] = useState(false);

  // 手机窄窗只派生 overlay 呈现，保留用户的 dock/pinned 偏好，放宽后恢复。
  const sidebarNavigationMemories = useRef(new Map<string, SidebarNavigationMemory>());
  let sidebarNavigationMemory = sidebarNavigationMemories.current.get(sidebarBookKey);
  if (!sidebarNavigationMemory) {
    sidebarNavigationMemory = createSidebarNavigationMemory();
    sidebarNavigationMemories.current.set(sidebarBookKey, sidebarNavigationMemory);
  }

  const effectiveSidebarMode: SidebarMode = phoneChrome ? "overlay" : sidebarMode;

  const isSidebarOpen =
    view === "reader" &&
    ((effectiveSidebarMode === "docked" && sidebarPinned) ||
      (foreground.kind === "panel" &&
        (foreground.panel === "toc" || foreground.panel === "bookmarks" || foreground.panel === "notes")));

  const activeSidebarTab: SidebarTab = (() => {
    if (foreground.kind === "panel") {
      if (foreground.panel === "toc") return "toc";
      if (foreground.panel === "bookmarks") return "bookmarks";
      if (foreground.panel === "notes") return "notes";
    }
    return sidebarTab;
  })();

  const isDockedSidebar = view === "reader" && effectiveSidebarMode === "docked" && sidebarPinned;
  // 桌面正文搜索停靠右侧时正文让出位置（宽窗由 CSS 决定），结果和正文同时可见。
  const isDockedSearch = view === "reader" && !mobileChrome && foreground.kind === "panel" && foreground.panel === "search";

  const handleSidebarTabChange = useCallback((tab: SidebarTab) => {
    setSidebarTab(tab);
    if (effectiveSidebarMode === "overlay") {
      openPanel(tab);
    }
  }, [effectiveSidebarMode, openPanel]);

  const handleSidebarModeChange = useCallback((mode: SidebarMode) => {
    setSidebarMode(mode);
    if (mode === "docked") {
      setSidebarPinned(true);
      if (
        foregroundRef.current.kind === "panel" &&
        (foregroundRef.current.panel === "toc" ||
          foregroundRef.current.panel === "bookmarks" ||
          foregroundRef.current.panel === "notes")
      ) {
        closeForeground();
      }
    } else {
      setSidebarPinned(false);
      openPanel(sidebarTab);
    }
  }, [sidebarTab, openPanel, closeForeground]);

  const handleSidebarClose = useCallback(() => {
    if (!phoneChrome && sidebarMode === "docked") {
      setSidebarPinned(false);
    }
    closeForeground();
  }, [closeForeground, phoneChrome, sidebarMode]);

  /** 键盘/返回键关闭当前可见层；笔记模态先走统一 dirty 确认。 */
  const requestCloseCurrentSurface = useCallback((): void => {
    const current = foregroundRef.current;
    if (current.kind === "modal" && current.modal === "note-composer") {
      requestCloseForeground();
      return;
    }
    // Back/Esc on an Aa sub-page returns to the Aa main page; only there does it close Aa.
    const stepped = stepBackFromMenuSubview(current);
    if (stepped) {
      setForeground(stepped);
      return;
    }
    if (isSidebarOpen) {
      handleSidebarClose();
      return;
    }
    requestCloseForeground();
  }, [handleSidebarClose, isSidebarOpen, requestCloseForeground]);

  const handleToggleSidebar = useCallback((side?: "left" | "right") => {
    const targetSide = side || "left";
    if (isSidebarOpen && sidebarSide === targetSide) {
      handleSidebarClose();
    } else {
      setSidebarSide(targetSide);
      if (effectiveSidebarMode === "docked") {
        setSidebarPinned(true);
      } else {
        openPanel(sidebarTab);
      }
    }
  }, [isSidebarOpen, sidebarSide, handleSidebarClose, effectiveSidebarMode, sidebarTab, openPanel]);

  const handleOpenBookmarks = useCallback(() => {
    setSidebarSide("right");
    setSidebarTab("bookmarks");
    if (effectiveSidebarMode === "docked") {
      setSidebarPinned(true);
    } else {
      openPanel("bookmarks");
    }
  }, [effectiveSidebarMode, openPanel]);

  return {
    sidebarSide, sidebarNavigationMemory, effectiveSidebarMode,
    isSidebarOpen, activeSidebarTab, isDockedSidebar, isDockedSearch,
    handleSidebarTabChange, handleSidebarModeChange, handleSidebarClose,
    requestCloseCurrentSurface, handleToggleSidebar, handleOpenBookmarks,
  };
}
