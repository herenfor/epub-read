import { useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { Book } from "../core/types";
import { nextLinearIndex, spineItemHref } from "../core/book";
import type { ImageViewRequest } from "../render/imageActivation";
import type { PageProgression } from "../render/pagedDirection";
import { clearDocumentSelection, isSelectAllShortcut } from "../render/selectionGuard";
import { arrowKeyDirection } from "../render/settings";
import type { RuntimeCapabilities } from "../platform/runtimeCapabilities";
import type { createVolumeKeyModeGate } from "../platform/androidVolumeKeys";
import { subscribeVolumeKeyTurn } from "../platform/androidVolumeKeys";
import { isEditableTarget } from "./bookmarkRibbons";
import { uiText } from "./localization/UiLanguageProvider";
import type { ReaderHandle } from "./ReaderView";
import type { NoteComposerDraft, ReaderPanelId } from "./readerForeground";
import type { ReaderNavigationHistory } from "./readerNavigationHistory";
import type { ShelfNotice } from "./useShelfLibrary";

export interface ReaderShortcutsDeps {
  runtime: RuntimeCapabilities;
  view: "shelf" | "reader";
  viewRef: MutableRefObject<"shelf" | "reader">;
  ready: boolean;
  book: Book | null;
  pageProgression: PageProgression;
  spineIndex: number;
  searchOpen: boolean;
  tocOpen: boolean;
  menuOpen: boolean;
  bookmarkMenuOpen: boolean;
  noteComposer: NoteComposerDraft | null;
  isFullscreen: boolean;
  fullscreenBusy: boolean;
  readerHistory: ReaderNavigationHistory;
  readerDisplayReady: boolean;
  isReaderPanelOpen: boolean;
  imageRequest: ImageViewRequest | null;
  navigationPendingRef: MutableRefObject<boolean>;
  isSidebarOpen: boolean;
  volumeKeyInputBlocked: boolean;
  volumeKeyTurn: boolean;
  volumeKeyReverse: boolean;
  volumeKeyGate: ReturnType<typeof createVolumeKeyModeGate>;
  setShelfNotice: Dispatch<SetStateAction<ShelfNotice>>;
  showReaderNotice: (text: string, kind?: "ok" | "warn" | "error") => void;
  readerRef: RefObject<ReaderHandle>;
  overlayHoverRef: MutableRefObject<boolean>;
  closeForeground: () => void;
  handleHistoryBack: () => void;
  handleHistoryForward: () => void;
  handleBookmarkButton: () => void;
  undoBookmarkRemoval: () => boolean;
  handleToggleBookmarks: () => void;
  handleToggleSidebar: () => void;
  handleSidebarClose: () => void;
  requestCloseCurrentSurface: () => void;
  toggleFullscreen: () => Promise<void>;
  openPanel: (panel: ReaderPanelId) => void;
  closePanel: (panel: ReaderPanelId) => void;
  handleTocNavigate: (href: string) => boolean;
}

export function useReaderShortcuts({
  runtime,
  view,
  viewRef,
  ready,
  book,
  pageProgression,
  spineIndex,
  searchOpen,
  tocOpen,
  menuOpen,
  bookmarkMenuOpen,
  noteComposer,
  isFullscreen,
  fullscreenBusy,
  readerHistory,
  readerDisplayReady,
  isReaderPanelOpen,
  imageRequest,
  navigationPendingRef,
  isSidebarOpen,
  volumeKeyInputBlocked,
  volumeKeyTurn,
  volumeKeyReverse,
  volumeKeyGate,
  setShelfNotice,
  showReaderNotice,
  readerRef,
  overlayHoverRef,
  closeForeground,
  handleHistoryBack,
  handleHistoryForward,
  handleBookmarkButton,
  undoBookmarkRemoval,
  handleToggleBookmarks,
  handleToggleSidebar,
  handleSidebarClose,
  requestCloseCurrentSurface,
  toggleFullscreen,
  openPanel,
  closePanel,
  handleTocNavigate,
}: ReaderShortcutsDeps) {
  // 跨 iframe 键盘事件穿透代理：解决阅读器焦点落入正文 iframe 时桌面全局快捷键失效的问题
  useEffect(() => {
    const attachedDocs = new WeakSet<Document>();

    const attachIframeKeyboardForwarder = (iframe: HTMLIFrameElement) => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc || attachedDocs.has(doc)) return;
        attachedDocs.add(doc);

        const handleIframeKey = (e: KeyboardEvent) => {
          const t = e.target as HTMLElement | null;
          if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
            if (e.key !== "Escape") return;
          }

          const isModifier = e.ctrlKey || e.metaKey || e.altKey;
          const isSpecial =
            e.key === "F11" ||
            e.key === "Escape" ||
            e.key === "[" ||
            e.key === "]";

          if (isModifier || isSpecial) {
            // 拦截浏览器/WebView 内置默认行为（如 Ctrl+T 新建标签页、Ctrl+F 默认查找等）
            if (
              (e.ctrlKey || e.metaKey) &&
              (e.key === "f" || e.key === "F" || e.key === "t" || e.key === "T" || e.key === "b" || e.key === "B")
            ) {
              e.preventDefault();
            }
            if (e.key === "F11") {
              e.preventDefault();
            }

            // 构造合成事件分发至宿主主窗口
            const synthetic = new KeyboardEvent(e.type, {
              key: e.key,
              code: e.code,
              keyCode: e.keyCode,
              which: e.which,
              ctrlKey: e.ctrlKey,
              shiftKey: e.shiftKey,
              altKey: e.altKey,
              metaKey: e.metaKey,
              repeat: e.repeat,
              bubbles: true,
              cancelable: true,
            });
            window.dispatchEvent(synthetic);
          }
        };

        doc.addEventListener("keydown", handleIframeKey, true);
      } catch {}
    };

    const scanAndAttach = () => {
      const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe");
      iframes.forEach(attachIframeKeyboardForwarder);
    };

    scanAndAttach();

    const observer = new MutationObserver(() => {
      scanAndAttach();
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    const timer = setInterval(scanAndAttach, 400);

    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, []);

  // 保存快捷键所需最新状态 ref，避免闭包捕获旧状态或频繁解绑事件
  const latestShortcutStateRef = useRef({
    view,
    ready,
    book,
    pageProgression,
    spineIndex,
    searchOpen,
    tocOpen,
    menuOpen,
    bookmarkMenuOpen,
    noteComposer,
    isFullscreen,
    readerHistory,
    readerDisplayReady,
    isReaderPanelOpen,
    imageViewerOpen: imageRequest !== null,
    navigationPending: navigationPendingRef.current,
  });

  latestShortcutStateRef.current = {
    view,
    ready,
    book,
    pageProgression,
    spineIndex,
    searchOpen,
    tocOpen,
    menuOpen,
    bookmarkMenuOpen,
    noteComposer,
    isFullscreen,
    readerHistory,
    readerDisplayReady,
    isReaderPanelOpen,
    imageViewerOpen: imageRequest !== null,
    navigationPending: navigationPendingRef.current,
  };

  useEffect(() => {
    if (!runtime.supportsVolumeKeyTurn) return;
    return subscribeVolumeKeyTurn((direction) => {
      const st = latestShortcutStateRef.current;
      if (st.view !== "reader" || st.isReaderPanelOpen || st.bookmarkMenuOpen ||
        st.noteComposer !== null || st.imageViewerOpen) return;
      if (direction === 1) readerRef.current?.nextPage();
      else readerRef.current?.prevPage();
    });
  }, [runtime.supportsVolumeKeyTurn]);

  useEffect(() => {
    if (!runtime.supportsVolumeKeyTurn) return;
    const submit = () => {
      void volumeKeyGate.request({
        // A blocking overlay, the bookmark menu or the image viewer hands the
        // volume keys back to the system and cancels any native repeat.
        readerActive: view === "reader" && !volumeKeyInputBlocked,
        enabled: volumeKeyTurn,
        reverse: volumeKeyReverse,
        visible: document.visibilityState !== "hidden",
      }).catch((error) => {
        const message = uiText("notice.volumeKeys.failed", { error: String(error) });
        if (viewRef.current === "reader") showReaderNotice(message, "warn");
        else setShelfNotice({ kind: "warn", text: message });
      });
    };
    submit();
    const onVisibilityChange = () => submit();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      volumeKeyGate.cancel();
    };
  }, [view, volumeKeyInputBlocked, volumeKeyTurn, volumeKeyReverse, runtime.supportsVolumeKeyTurn, volumeKeyGate, showReaderNotice]);

  // ---- 桌面全局快捷键集中分发与键盘翻页（Zen UI Packet 3 键盘流） ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      if (isSelectAllShortcut(e)) {
        e.preventDefault();
        clearDocumentSelection(document);
        return;
      }
      const t = e.target as HTMLElement | null;
      const st = latestShortcutStateRef.current;

      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        // 在文本输入框/搜索框按下 Escape 时失焦并收起当前活动弹窗
        if (e.key === "Escape") {
          t.blur();
          if (st.isReaderPanelOpen || isSidebarOpen || st.bookmarkMenuOpen || st.noteComposer !== null) {
            requestCloseCurrentSurface();
          }
        }
        return;
      }

      // 1. Ctrl + F / Cmd + F：打开/切换正文搜索
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        if (st.view === "reader" && st.ready && !st.book?.fixedLayout) {
          if (st.searchOpen) closePanel("search");
          else openPanel("search");
        }
        return;
      }

      // 2. Ctrl + Shift + B：呼出/切换书签抽屉
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        if (st.view === "reader") {
          handleToggleBookmarks();
        }
        return;
      }

      // 3. Ctrl + T：切换展开/关闭侧边栏（目录/书签/笔记）
      if ((e.ctrlKey || e.metaKey) && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        if (st.view === "reader") {
          handleToggleSidebar();
        }
        return;
      }

      // 4. Ctrl + B：书签按钮（双页弹出缩略书页，其他模式放 / 取）
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        if (st.view === "reader") {
          handleBookmarkButton();
        }
        return;
      }

      // 4b. Ctrl + Z：撤销刚删除的书签；焦点在输入框时让给输入框
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "z" || e.key === "Z")) {
        if (st.view === "reader" && !isEditableTarget(e.target) && undoBookmarkRemoval()) {
          e.preventDefault();
          return;
        }
      }

      // 5. F11：进入/退出全屏（纯净沉浸模式）
      if (e.key === "F11") {
        e.preventDefault();
        if (e.repeat) return;
        void toggleFullscreen();
        return;
      }

      // 6. Alt + Left / Alt + Right：历史阅读位置后退 / 前进，若无跳转历史则切上一章/下一章
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending) {
          if (st.readerHistory.back.length > 0) {
            handleHistoryBack();
          } else if (st.book) {
            // Same neighbour as page turns: skip linear="no" items such as a trailing nav.
            const prev = nextLinearIndex(st.book, st.spineIndex, -1);
            const href = prev >= 0 ? spineItemHref(st.book, prev) : undefined;
            if (href) handleTocNavigate(href);
          }
        }
        return;
      }
      if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending) {
          if (st.readerHistory.forward.length > 0) {
            handleHistoryForward();
          } else if (st.book) {
            const next = nextLinearIndex(st.book, st.spineIndex, 1);
            const href = next >= 0 ? spineItemHref(st.book, next) : undefined;
            if (href) handleTocNavigate(href);
          }
        }
        return;
      }

      // 7. [ 与 ] 键：快速跳转上一章 / 下一章
      if (e.key === "[" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending && st.book) {
          const prev = nextLinearIndex(st.book, st.spineIndex, -1);
          const href = prev >= 0 ? spineItemHref(st.book, prev) : undefined;
          if (href) handleTocNavigate(href);
        }
        return;
      }
      if (e.key === "]" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (st.view === "reader" && st.readerDisplayReady && !st.navigationPending && st.book) {
          const next = nextLinearIndex(st.book, st.spineIndex, 1);
          const href = next >= 0 ? spineItemHref(st.book, next) : undefined;
          if (href) handleTocNavigate(href);
        }
        return;
      }

      // 8. Esc：优先关闭任意处于激活状态的前景/弹窗/抽屉；若无浮层且全屏中，退回窗口模式
      if (e.key === "Escape") {
        if (st.isReaderPanelOpen || isSidebarOpen || st.bookmarkMenuOpen || st.noteComposer !== null) {
          requestCloseCurrentSurface();
          return;
        }
        if (st.isFullscreen) {
          if (fullscreenBusy) return;
          void toggleFullscreen();
          return;
        }
        return;
      }

      // 指针位于交互式浮层（脚注弹窗等）上时不翻页，滚轮/按钮交给浮层自身处理
      if (overlayHoverRef.current) return;
      // 面板、浮层抽屉或书签菜单打开时，键盘归最上层：方向键和翻页键不在背后翻页。
      // 停靠的侧栏不算前景，照常翻页。
      if (st.isReaderPanelOpen || st.bookmarkMenuOpen) return;
      const keyDir = e.key === "ArrowRight" || e.key === "PageDown" || e.key === " " ? 1
        : e.key === "ArrowLeft" || e.key === "PageUp" ? -1 : 0;
      if (keyDir !== 0) {
        e.preventDefault();
        if (arrowKeyDirection(keyDir, e.key, st.pageProgression) === 1) readerRef.current?.nextPage();
        else readerRef.current?.prevPage();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    closeForeground,
    fullscreenBusy,
    handleHistoryBack,
    handleHistoryForward,
    handleBookmarkButton,
    undoBookmarkRemoval,
    handleToggleBookmarks,
    handleToggleSidebar,
    handleSidebarClose,
    requestCloseCurrentSurface,
    isSidebarOpen,
    toggleFullscreen,
    openPanel,
    closePanel,
    handleTocNavigate,
  ]);
}
