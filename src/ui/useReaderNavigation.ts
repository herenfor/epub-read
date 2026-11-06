import { useCallback, useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { archiveHref } from "../core/archiveReferences";
import { spineIndexForEntryKey, spineIndexForPath, spineItemHref } from "../core/book";
import { isFragmentOnly, splitHref } from "../core/paths";
import type { SearchResult } from "../core/search";
import type { Book } from "../core/types";
import type { ChapterState, MediaReadingAnchor } from "../render/paginator";
import type { ReaderSettings } from "../render/settings";
import { uiText } from "./localization/UiLanguageProvider";
import { commitDirectHistory, commitHistoryTransition, sameChapterRoute } from "./sameChapterNavigation";
import {
  readerHistoryBack,
  readerHistoryForward,
  recordReaderNavigation,
  type ReaderNavigationHistory,
  type ReaderNavigationPosition,
} from "./readerNavigationHistory";
import type { ContentAxis, ScrubToken, ScrubUiEvent, ScrubUiState } from "./readerProgressAxis";
import type { ReaderHandle } from "./ReaderView";
import type { SidebarNavigationMemory } from "./sidebarSwipe";
import type { ReaderSessionHost } from "./useReaderSession";
import type { useReaderSettings } from "./useReaderSettings";

type ReaderHistoryPosition = ReaderNavigationPosition;
type ReaderSettingsActions = ReturnType<typeof useReaderSettings>["settingsActions"];
type ReaderNotice = { kind: "ok" | "warn" | "error"; text: string } | null;
type PersistedReaderAnchor = {
  index: number;
  ratio: number;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
  mediaAnchor?: MediaReadingAnchor | null;
};
type ReadReaderPosition = (withText?: boolean) => {
  chapterPath: string | null;
  state: ChapterState;
  readingAnchor: ReturnType<ReaderHandle["getReadingAnchor"]>;
  anchorText: string | null;
};
type ToPersistedReaderAnchor = (value: {
  index?: number | null;
  ratio?: number | null;
  anchorTextOffset?: number | null;
  anchorTextSnippet?: string | null;
  mediaAnchor?: MediaReadingAnchor | null;
} | null | undefined) => PersistedReaderAnchor | null;
type PreciseTarget = {
  requestId: number;
  kind: "search" | "note";
  chapterPath: string;
  textHits?: import("../core/exactTextHits").ExactTextHit[];
  occurrence?: import("../core/searchOccurrence").SearchOccurrence;
  displayTarget?: import("../core/search").DisplaySearchTarget;
};
type PendingChapterSeek = {
  target: { key: string; spineIndex: number; fraction: number };
  token: ScrubToken;
};
type TocFollowSeek = { token: ScrubToken; fromHref?: string; memory: SidebarNavigationMemory };

export function useReaderNavigation({
  readReaderPosition,
  readerRef,
  bookRef,
  spineIndexRef,
  lastStablePositionRef,
  navigationPendingRef,
  readerDisplayReadyRef,
  historyCaptureAllowedRef,
  latestPreciseRequestRef,
  preciseRequestRef,
  contentAxisRef,
  chapterStateRef,
  sidebarNavigationMemoryRef,
  scrubSessionRef,
  scrubRequestIdRef,
  pendingChapterSeekRef,
  tocFollowSeekRef,
  tocFollowGenerationRef,
  tocFollowRequest,
  setTocFollowRequest,
  activeHrefRef,
  scrubUiStateRef,
  dispatchScrub,
  acceptsScrubResult,
  book,
  spineIndex,
  view,
  settings,
  settingsActions,
  readerHistory,
  setReaderHistory,
  searchNavigationBusy,
  setSearchNavigationBusy,
  setPreciseTarget,
  setAnchor,
  setAnchorNonce,
  setSpineIndex,
  setInitialPage,
  setInitialAnchor,
  setInitialAlignment,
  setReaderNotice,
  showReaderNotice,
  closePanel,
  closeForeground,
  handleFootnoteClose,
  beginExplicitNavigation,
  releaseRestoreForExplicitNavigation,
  dispatchReaderSession,
  toPersistedReaderAnchor,
}: {
  readReaderPosition: ReadReaderPosition;
  readerRef: RefObject<ReaderHandle>;
  bookRef: MutableRefObject<Book | null>;
  spineIndexRef: MutableRefObject<number>;
  lastStablePositionRef: MutableRefObject<ReaderHistoryPosition>;
  navigationPendingRef: Readonly<MutableRefObject<boolean>>;
  readerDisplayReadyRef: Readonly<MutableRefObject<boolean>>;
  historyCaptureAllowedRef: Readonly<MutableRefObject<boolean>>;
  latestPreciseRequestRef: MutableRefObject<number | null>;
  preciseRequestRef: MutableRefObject<number>;
  contentAxisRef: MutableRefObject<ContentAxis | null>;
  chapterStateRef: MutableRefObject<ChapterState>;
  sidebarNavigationMemoryRef: MutableRefObject<SidebarNavigationMemory>;
  scrubSessionRef: MutableRefObject<number>;
  scrubRequestIdRef: MutableRefObject<number>;
  pendingChapterSeekRef: MutableRefObject<PendingChapterSeek | null>;
  tocFollowSeekRef: MutableRefObject<TocFollowSeek | null>;
  tocFollowGenerationRef: MutableRefObject<number>;
  tocFollowRequest: number;
  setTocFollowRequest: Dispatch<SetStateAction<number>>;
  activeHrefRef: MutableRefObject<string | undefined>;
  scrubUiStateRef: MutableRefObject<ScrubUiState>;
  dispatchScrub: (event: ScrubUiEvent) => void;
  acceptsScrubResult: (token: ScrubToken) => boolean;
  book: Book | null;
  spineIndex: number;
  view: "shelf" | "reader";
  settings: ReaderSettings;
  settingsActions: ReaderSettingsActions;
  readerHistory: ReaderNavigationHistory;
  setReaderHistory: Dispatch<SetStateAction<ReaderNavigationHistory>>;
  searchNavigationBusy: boolean;
  setSearchNavigationBusy: Dispatch<SetStateAction<boolean>>;
  setPreciseTarget: Dispatch<SetStateAction<PreciseTarget | null>>;
  setAnchor: Dispatch<SetStateAction<string | undefined>>;
  setAnchorNonce: Dispatch<SetStateAction<number>>;
  setSpineIndex: Dispatch<SetStateAction<number>>;
  setInitialPage: Dispatch<SetStateAction<number | null>>;
  setInitialAnchor: Dispatch<SetStateAction<PersistedReaderAnchor | null>>;
  setInitialAlignment: Dispatch<SetStateAction<"reading-line" | "context">>;
  setReaderNotice: Dispatch<SetStateAction<ReaderNotice>>;
  showReaderNotice: (text: string, kind?: "ok" | "warn" | "error") => void;
  closePanel: (panel: "bookmarks" | "notes") => void;
  closeForeground: () => void;
  handleFootnoteClose: () => void;
  beginExplicitNavigation: ReaderSessionHost["beginExplicitNavigation"];
  releaseRestoreForExplicitNavigation: ReaderSessionHost["releaseRestoreForExplicitNavigation"];
  dispatchReaderSession: ReaderSessionHost["dispatchReaderSession"];
  toPersistedReaderAnchor: ToPersistedReaderAnchor;
}) {
  const followTocAfterSeek = useCallback((token: ScrubToken) => {
    const seek = tocFollowSeekRef.current;
    if (!seek || seek.token.session !== token.session || seek.token.request !== token.request) return;
    tocFollowSeekRef.current = null;
    // A landing from a book session that has since been replaced belongs to no open TOC.
    const memory = seek.memory;
    if (token.session !== scrubSessionRef.current || memory !== sidebarNavigationMemoryRef.current) return;
    const generation = ++tocFollowGenerationRef.current;
    // An unconsumed earlier jump keeps its origin: A→B→B still follows to B.
    memory.tocFollow = { generation, fromHref: memory.tocFollow ? memory.tocFollow.fromHref : seek.fromHref };
    setTocFollowRequest(generation);
  }, []);
  /** A cancelled, failed or replaced jump drops only its own pending follow. */
  const dropTocFollowSeek = useCallback((token: ScrubToken) => {
    const seek = tocFollowSeekRef.current;
    if (seek && seek.token.session === token.session && seek.token.request === token.request) tocFollowSeekRef.current = null;
  }, []);
  useEffect(() => {
    // The render that carried the landing names the landed entry; the drawer drops the follow once the reader leaves it.
    const follow = sidebarNavigationMemoryRef.current.tocFollow;
    if (follow?.generation === tocFollowRequest && follow.toHref === undefined) follow.toHref = activeHrefRef.current;
  }, [tocFollowRequest]);
  // ---- 目录/书内链接跳转 ----
  /** 当前稳定阅读位置；同步 ref 避免 ready 更新尚未完成 React render 的竞态。 */
  const currentReaderPosition = useCallback((): ReaderHistoryPosition => {
    const { state, readingAnchor } = readReaderPosition();
    const currentBook = bookRef.current;
    let targetSpineIndex = spineIndex;
    if (readingAnchor?.path && currentBook) {
      const resolved = spineIndexForEntryKey(currentBook, readingAnchor.path);
      if (resolved >= 0) {
        targetSpineIndex = resolved;
      }
    }
    return {
      spineIndex: targetSpineIndex,
      page: state.status === "ready" ? state.currentPage : lastStablePositionRef.current.page,
      anchor: toPersistedReaderAnchor(
        readingAnchor
          ? {
              index: readingAnchor.index,
              ratio: readingAnchor.ratio,
              anchorTextOffset: readingAnchor.textOffset,
              anchorTextSnippet: readingAnchor.textSnippet,
              mediaAnchor: readingAnchor.mediaAnchor ?? null,
            }
          : null
      ) ?? lastStablePositionRef.current.anchor,
    };
  }, [spineIndex, readReaderPosition]);

  const handlePresentationChange = useCallback(
    (patch: { readingMode?: "paginated" | "scroll"; columnsPerView?: 1 | 2 }) => {
      const isModeChange = patch.readingMode !== undefined && patch.readingMode !== settings.readingMode;
      const isColChange = patch.columnsPerView !== undefined && patch.columnsPerView !== settings.columnsPerView;
      if (!isModeChange && !isColChange) return;

      const pos = currentReaderPosition();
      if (pos) {
        lastStablePositionRef.current = pos;
        if (isModeChange) {
          if (pos.anchor) setInitialAnchor(toPersistedReaderAnchor(pos.anchor));
          if (typeof pos.page === "number") setInitialPage(pos.page);
          if (typeof pos.spineIndex === "number") {
            spineIndexRef.current = pos.spineIndex;
            setSpineIndex(pos.spineIndex);
          }
          setAnchorNonce((n) => n + 1);
        }
      }
      settingsActions.setPresentation(patch);
    },
    [currentReaderPosition, settings.columnsPerView, settings.readingMode]
  );

  /** 捕获当前位置供一次普通书内跳转撤销；调用方负责保证一次点击只调用一次。 */
  const captureReaderHistory = useCallback((href: string): void => {
    const state = chapterStateRef.current;
    if (!book || view !== "reader" || !historyCaptureAllowedRef.current) return;
    if (state.status === "ready" && state.empty) return;
    // 跨章链接必须确实命中 spine；纯 fragment 则必须属于当前有效章节。
    // 这样 paginator 的通用 before 通知不会把无效 href 变成假历史。
    if (
      isFragmentOnly(href)
        ? spineIndex < 0 || spineIndex >= book.spine.length
        : spineIndexForPath(book, href) < 0
    ) {
      return;
    }
    const snapshot =
      !navigationPendingRef.current && state.status === "ready"
        ? currentReaderPosition()
        : {
            spineIndex: lastStablePositionRef.current.spineIndex,
            page: lastStablePositionRef.current.page,
            anchor: lastStablePositionRef.current.anchor
              ? { ...lastStablePositionRef.current.anchor }
              : null,
          };
    lastStablePositionRef.current = snapshot;
    dispatchReaderSession({ type: "history-captured" });
    setReaderHistory((prev) => recordReaderNavigation(prev, snapshot));
  }, [book, view, spineIndex, currentReaderPosition]);

  /** Commit a previously captured snapshot only after direct navigation succeeds. */
  const commitReaderHistorySnapshot = useCallback((snapshot: ReaderHistoryPosition): void => {
    setReaderHistory((prev) => commitDirectHistory(prev, snapshot, true));
    // Same-chapter navigation never enters the display gate. The paginator
    // settles synchronously, so the next explicit jump may be captured now.
    dispatchReaderSession({ type: "direct-settled" });
  }, [dispatchReaderSession]);

  /**
   * 弹注里的本章锚点：与其他书内跳转一样可以返回。只有确实换了页才记历史；
   * 很多书整段注释就是指回引用处的链接，点它常常还在同一页。
   */
  const handleFootnoteAnchor = useCallback((anchor: string) => {
    const snapshot = currentReaderPosition();
    if (readerRef.current?.navigateWithinCurrentChapter({ fragment: anchor })) {
      const landed = currentReaderPosition();
      if (landed.spineIndex !== snapshot.spineIndex || landed.page !== snapshot.page) commitReaderHistorySnapshot(snapshot);
    } else {
      readerRef.current?.jumpToAnchor(anchor);
    }
    handleFootnoteClose();
  }, [commitReaderHistorySnapshot, currentReaderPosition, handleFootnoteClose]);

  /** 只执行 href 跳转，不记录历史；UI 入口和 paginator 通知入口共用。 */
  const navigateReaderHref = useCallback((href: string): boolean => {
    if (!book) return false;
    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
    const idx = spineIndexForPath(book, href);
    const a = book.archiveReferences ? book.archiveReferences.resolve(book.opfPath, href).anchor : splitHref(href).anchor;
    if (idx < 0) return false;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: idx,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const direct = readerRef.current?.navigateWithinCurrentChapter(
        a ? { fragment: a } : { toStart: true }
      );
      if (direct) {
        setAnchor(a || undefined);
        closePanel("bookmarks");
        return true;
      }
      return false;
    }
    if (idx >= 0) {
      beginExplicitNavigation();
      closePanel("bookmarks");
      setSpineIndex(idx);
      setAnchor(a || undefined);
      setAnchorNonce((n) => n + 1);
      // 保持目录展开：方便连续选择章节；用 ✕/遮罩/Esc 关闭
      return true;
    }
    return false;
  }, [book, spineIndex]);

  /** 侧边目录入口：先记录一次，再执行跳转。 */
  const handleTocNavigate = useCallback((href: string): boolean => {
    if (!book) return false;
    const target = spineIndexForPath(book, href);
    if (target < 0) return false;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: target,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const snapshot = currentReaderPosition();
      if (!navigateReaderHref(href)) return false;
      commitReaderHistorySnapshot(snapshot);
      return true;
    }
    captureReaderHistory(href);
    return navigateReaderHref(href);
  }, [book, captureReaderHistory, navigateReaderHref, spineIndex, currentReaderPosition, commitReaderHistorySnapshot]);

  const handleCommitSeek = useCallback((ratio: number) => {
    const r = Math.max(0, Math.min(1, ratio));
    const axis = contentAxisRef.current;
    scrubRequestIdRef.current += 1;
    const token: ScrubToken = {
      session: scrubSessionRef.current,
      request: scrubRequestIdRef.current,
    };
    dispatchReaderSession({ type: "begin-scrub" });
    releaseRestoreForExplicitNavigation();
    dispatchScrub({ type: "begin", token, ratio: r });
    // No axis means no reported landing to follow; scrollToRatio keeps the TOC as it is.
    tocFollowSeekRef.current = axis ? { token, fromHref: activeHrefRef.current, memory: sidebarNavigationMemoryRef.current } : null;

    if (settings.readingMode === "scroll") {
      if (axis) {
        const target = axis.locate(r);
        if (target) {
          readerRef.current?.seekContentFraction?.(
            { key: target.key, spineIndex: target.spineIndex, fraction: target.fraction },
            token
          );
          return;
        }
      }
      readerRef.current?.scrollToRatio?.(r);
    } else {
      if (axis) {
        const target = axis.locate(r);
        if (target) {
          // Requested chapter index can change before its paginator is ready.
          // Keep a later fraction queued instead of applying it to the old document.
          if (target.spineIndex === spineIndexRef.current && readerDisplayReadyRef.current) {
            readerRef.current?.seekContentFraction?.(
              { key: target.key, spineIndex: target.spineIndex, fraction: target.fraction },
              token
            );
          } else {
            const currentBook = bookRef.current;
            const href = currentBook ? spineItemHref(currentBook, target.spineIndex) : undefined;
            if (href) {
              pendingChapterSeekRef.current = {
                target: { key: target.key, spineIndex: target.spineIndex, fraction: target.fraction },
                token,
              };
              if (handleTocNavigate(href)) return; // Settle only after the target chapter and page are ready.
            }
            pendingChapterSeekRef.current = null;
            dropTocFollowSeek(token);
            dispatchScrub({ type: "failed", token });
            dispatchReaderSession({ type: "scrub-local-settled" });
            setReaderNotice({ kind: "warn", text: uiText("notice.reader.progressNotFound") });
            return;
          }
          dispatchScrub({
            type: "settled",
            token,
            actual: { ratio: r, atEnd: r >= 1 },
          });
          dispatchReaderSession({ type: "scrub-local-settled" });
          return;
        }
      }
      readerRef.current?.scrollToRatio?.(r);
      dispatchScrub({
        type: "settled",
        token,
        actual: { ratio: r, atEnd: r >= 1 },
      });
      dispatchReaderSession({ type: "scrub-local-settled" });
    }
  }, [settings.readingMode, handleTocNavigate, dispatchScrub, dispatchReaderSession, releaseRestoreForExplicitNavigation, dropTocFollowSeek]);

  const handleScrubPreviewChange = useCallback((ratio: number | null) => {
    dispatchScrub({
      type: "preview",
      session: scrubSessionRef.current,
      ratio,
    });
  }, [dispatchScrub]);

  const handleContentFractionSettled = useCallback((
    token: ScrubToken,
    location: { key: string; spineIndex: number; fraction: number; atEnd: boolean }
  ) => {
    // A paged comic settles the bar optimistically first; its later real landing still moves the TOC.
    followTocAfterSeek(token);
    if (!acceptsScrubResult(token)) return;
    dispatchReaderSession({ type: "scrub-reader-settled" });
    const axis = contentAxisRef.current;
    const ratio = axis ? axis.ratioAt({ key: location.key, fraction: location.fraction }) : null;
    const actualRatio = ratio !== null ? ratio : (scrubUiStateRef.current.pending?.ratio ?? 0);
    dispatchScrub({
      type: "settled",
      token,
      actual: { ratio: actualRatio, atEnd: location.atEnd },
    });
  }, [acceptsScrubResult, dispatchScrub, dispatchReaderSession, followTocAfterSeek]);

  const handleContentFractionCancelled = useCallback((token: ScrubToken) => {
    dropTocFollowSeek(token);
    if (!acceptsScrubResult(token)) return;
    dispatchReaderSession({ type: "scrub-reader-aborted" });
    dispatchScrub({ type: "cancelled", token });
  }, [acceptsScrubResult, dispatchScrub, dispatchReaderSession, dropTocFollowSeek]);

  const handleContentFractionFailed = useCallback((token: ScrubToken) => {
    dropTocFollowSeek(token);
    if (!acceptsScrubResult(token)) return;
    dispatchReaderSession({ type: "scrub-reader-aborted" });
    dispatchScrub({ type: "failed", token });
    setReaderNotice({ kind: "warn", text: uiText("notice.reader.progressNotFound") });
  }, [acceptsScrubResult, dispatchScrub, dispatchReaderSession, dropTocFollowSeek]);

  const handleUserProgressSample = useCallback((
    location: { key: string; spineIndex: number; fraction: number; atEnd: boolean }
  ) => {
    const axis = contentAxisRef.current;
    if (!axis) return;
    const ratio = axis.ratioAt({ key: location.key, fraction: location.fraction });
    if (ratio !== null) {
      dispatchScrub({
        type: "sample",
        session: scrubSessionRef.current,
        actual: { ratio, atEnd: location.atEnd },
      });
    }
  }, [dispatchScrub]);

  /** 搜索结果使用文本锚点定位；预览不写进度，只有用户点击才进入历史。 */
  const handleSearchNavigate = useCallback((result: SearchResult): void => {
    if (!book || searchNavigationBusy || result.spineIndex < 0 || result.spineIndex >= book.spine.length) return;
    const targetAnchor: PersistedReaderAnchor = {
      index: -1,
      ratio: 0,
      anchorTextOffset: result.textOffset,
      anchorTextSnippet: result.textSnippet,
    };
    const requestId = ++preciseRequestRef.current;
    const textHits = result.textHits ?? [];
    const occurrence = result.occurrence;
    const displayTarget = result.display
      ? {
          projectionVersion: result.display.projectionVersion,
          textHits: result.display.textHits,
          occurrence: result.display.occurrence,
        }
      : undefined;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: result.spineIndex,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const snapshot = currentReaderPosition();
      if (textHits.length > 0 || occurrence) {
        const status = readerRef.current?.navigateToSearchTarget({
          requestId,
          kind: "search",
          textHits,
          occurrence,
          displayTarget,
          chapterPath: result.chapterPath,
        });
        if (status === "located" || status === "unsupported-highlight") {
          setAnchor(undefined);
          commitReaderHistorySnapshot(snapshot);
          if (status === "unsupported-highlight") {
            showReaderNotice(uiText("notice.reader.noHighlight"), "warn");
          }
          handleFootnoteClose();
          closeForeground();
          return;
        }
        showReaderNotice(uiText("notice.reader.sourceNotFound"), "warn");
        return;
      }
      const direct = readerRef.current?.navigateWithinCurrentChapter({
        readingAnchor: targetAnchor,
        fallbackPage: null,
      });
      if (direct) {
        setAnchor(undefined);
        commitReaderHistorySnapshot(snapshot);
        showReaderNotice(uiText("notice.reader.paragraphOnly"), "warn");
        handleFootnoteClose();
        closeForeground();
        return;
      }
      showReaderNotice(uiText("notice.reader.sourceNotFound"), "warn");
      return;
    }

    // 跨章先进入目标章节；精确范围/高亮在显示门内解析，失败不冒充命中。
    captureReaderHistory(archiveHref(book.archiveReferences, result.chapterPath));
    beginExplicitNavigation();
    setSearchNavigationBusy(true);
    setInitialPage(null);
    setInitialAnchor(targetAnchor);
    setInitialAlignment("context");
    latestPreciseRequestRef.current = requestId;
    setPreciseTarget({
      requestId,
      kind: "search",
      chapterPath: result.chapterPath,
      textHits: textHits.length > 0 ? textHits : undefined,
      occurrence,
      displayTarget,
    });
    setSpineIndex(result.spineIndex);
    setAnchor(undefined);
    setAnchorNonce((nonce) => nonce + 1);
    handleFootnoteClose();
    closeForeground();
  }, [
    book,
    searchNavigationBusy,
    spineIndex,
    currentReaderPosition,
    commitReaderHistorySnapshot,
    captureReaderHistory,
    handleFootnoteClose,
    showReaderNotice,
  ]);

  /** iframe 普通书内链接：历史由 paginator 的 before 通知记录一次。 */
  const handleInternalNavigate = useCallback((href: string): void => {
    navigateReaderHref(href);
  }, [navigateReaderHref]);


  const handleHistoryBack = useCallback(() => {    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
    const current = currentReaderPosition();
    const transition = readerHistoryBack(readerHistory, current);
    if (!transition.target) return;
    const pos = transition.target;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: pos.spineIndex,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const direct = readerRef.current?.navigateWithinCurrentChapter({
        readingAnchor: pos.anchor
          ? {
              index: pos.anchor.index,
              ratio: pos.anchor.ratio,
              anchorTextOffset: pos.anchor.anchorTextOffset ?? null,
              anchorTextSnippet: pos.anchor.anchorTextSnippet ?? null,
            }
          : null,
        mediaAnchor: pos.anchor?.mediaAnchor ?? null,
        fallbackPage: pos.page,
      });
      if (direct) {
        setAnchor(undefined);
        setReaderHistory(commitHistoryTransition(readerHistory, transition, true));
        dispatchReaderSession({ type: "direct-settled" });
        return;
      }
    }
    lastStablePositionRef.current = transition.target;
    beginExplicitNavigation();
    setReaderHistory(transition.history);
    // 恢复跳转前位置：章节 + 页码 + 内容锚点
    setSpineIndex(pos.spineIndex);
    setAnchor(undefined);
    setAnchorNonce((n) => n + 1);
    setInitialPage(pos.page ?? 0);
    setInitialAnchor(toPersistedReaderAnchor(pos.anchor));
    setInitialAlignment("context");
    handleFootnoteClose();
    closeForeground();
  }, [readerHistory, currentReaderPosition, spineIndex, handleFootnoteClose]);

  const handleHistoryForward = useCallback(() => {
    setPreciseTarget(null);
    latestPreciseRequestRef.current = null;
    const current = currentReaderPosition();
    const transition = readerHistoryForward(readerHistory, current);
    if (!transition.target) return;
    const pos = transition.target;
    if (
      sameChapterRoute({
        currentSpineIndex: spineIndex,
        targetSpineIndex: pos.spineIndex,
        readerDisplayReady: readerDisplayReadyRef.current,
        navigationPending: navigationPendingRef.current,
      }) === "direct"
    ) {
      const direct = readerRef.current?.navigateWithinCurrentChapter({
        readingAnchor: pos.anchor
          ? {
              index: pos.anchor.index,
              ratio: pos.anchor.ratio,
              anchorTextOffset: pos.anchor.anchorTextOffset ?? null,
              anchorTextSnippet: pos.anchor.anchorTextSnippet ?? null,
            }
          : null,
        mediaAnchor: pos.anchor?.mediaAnchor ?? null,
        fallbackPage: pos.page,
      });
      if (direct) {
        setAnchor(undefined);
        setReaderHistory(commitHistoryTransition(readerHistory, transition, true));
        dispatchReaderSession({ type: "direct-settled" });
        return;
      }
    }
    lastStablePositionRef.current = transition.target;
    beginExplicitNavigation();
    setReaderHistory(transition.history);
    setSpineIndex(pos.spineIndex);
    setAnchor(undefined);
    setAnchorNonce((n) => n + 1);
    setInitialPage(pos.page);
    setInitialAnchor(toPersistedReaderAnchor(pos.anchor));
    setInitialAlignment("context");
    handleFootnoteClose();
    closeForeground();
  }, [readerHistory, currentReaderPosition, spineIndex, handleFootnoteClose]);
  return {
    currentReaderPosition,
    handlePresentationChange,
    captureReaderHistory,
    commitReaderHistorySnapshot,
    handleFootnoteAnchor,
    navigateReaderHref,
    handleTocNavigate,
    handleCommitSeek,
    handleScrubPreviewChange,
    handleContentFractionSettled,
    handleContentFractionCancelled,
    handleContentFractionFailed,
    handleUserProgressSample,
    handleSearchNavigate,
    handleInternalNavigate,
    handleHistoryBack,
    handleHistoryForward,
    followTocAfterSeek,
    dropTocFollowSeek,
  };
}
