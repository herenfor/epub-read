import { useCallback, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { nextLinearIndex, spineItemPath } from "../core/book";
import type { Book } from "../core/types";
import type { ChapterState, MediaReadingAnchor, PreciseNavigationStatus, ReadingAnchor } from "../render/paginator";
import type { ResourceServer } from "../render/resources";
import type { ReaderSettings } from "../render/settings";
import { measuredChapterWeight, type ChapterCountCollection } from "./chapterCounts";
import { uiText } from "./localization/UiLanguageProvider";
import type { ReaderNavigationPosition } from "./readerNavigationHistory";
import type { ContentAxis, ScrubToken, ScrubUiEvent, ScrubUiState } from "./readerProgressAxis";
import type { ReaderHandle } from "./ReaderView";
import { mayCommitRestoredProgress, type RestoreTicket } from "./restoreCommitGate";
import type { ReaderSessionHost } from "./useReaderSession";

type ReaderHistoryPosition = ReaderNavigationPosition;
type PersistedReaderAnchor = {
  index: number;
  ratio: number;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
  /** B-155：纯图片页的可选媒体身份/比例；旧记录可读，缺省即低精度。 */
  mediaAnchor?: MediaReadingAnchor | null;
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
type ActiveSession = {
  generation: number;
  book: Book;
  server: ResourceServer;
  bookKey: string;
  countCacheKey: string | null;
  structuralCounts: ChapterCountCollection;
};

export interface ReaderChapterCallbacks {
  handleUserReadingPositionChange: (ticket?: RestoreTicket | null) => void;
  onPageState: (state: ChapterState) => void;
  handleReaderDisplayReady: (ticket?: RestoreTicket | null) => void;
  handleVisibleChapterChange: (index: number, anchor: ReadingAnchor | null) => void;
  handleRequestChapter: (index: number, opts?: { atEnd?: boolean }) => void;
  handleReaderNavigationUnresolved: (reported: boolean, ticket?: RestoreTicket | null) => void;
  handleReaderRestoreResult: (result: {
    chapterPath: string;
    located: boolean;
    ticket: RestoreTicket | null;
  }) => void;
  handlePreciseNavigationStatus: (status: {
    requestId: number;
    status: PreciseNavigationStatus;
    exact: boolean;
  }) => void;
}

/**
 * C5：阅读宿主回报与开书恢复结算。
 * 只消费 C3/C4 返回的原对象与会话动作；ref/state 均不在此创建。
 */
export function useReaderChapterCallbacks({
  dispatchRestoreGate,
  dispatchReaderSession,
  restoreGateRef,
  restoreResultMatches,
  setInitialRestoreTicket,
  setSearchNavigationBusy,
  setInitialAnchor,
  setInitialPage,
  setInitialAlignment,
  showReaderNotice,
  latestPreciseRequestRef,
  setPreciseTarget,
  setReturnPromptShown,
  chapterStateRef,
  setChapterState,
  pendingChapterSeekRef,
  dispatchScrub,
  scrubSessionRef,
  scrubUiStateRef,
  navigationPendingRef,
  contentAxisRef,
  bookRef,
  spineIndexRef,
  readerRef,
  lastStablePositionRef,
  activeSessionRef,
  readingModeRef,
  applyCount,
  dropTocFollowSeek,
  followTocAfterSeek,
  setSpineIndex,
  setAnchor,
  setStartAtEnd,
  closeImageOverlay,
  closeForeground,
  beginExplicitNavigation,
  toPersistedReaderAnchor,
}: {
  dispatchRestoreGate: ReaderSessionHost["dispatchRestoreGate"];
  dispatchReaderSession: ReaderSessionHost["dispatchReaderSession"];
  restoreGateRef: ReaderSessionHost["restoreGateRef"];
  restoreResultMatches: ReaderSessionHost["restoreResultMatches"];
  setInitialRestoreTicket: ReaderSessionHost["setInitialRestoreTicket"];
  setSearchNavigationBusy: Dispatch<SetStateAction<boolean>>;
  setInitialAnchor: Dispatch<SetStateAction<PersistedReaderAnchor | null>>;
  setInitialPage: Dispatch<SetStateAction<number | null>>;
  setInitialAlignment: Dispatch<SetStateAction<"reading-line" | "context">>;
  showReaderNotice: (text: string, kind?: "ok" | "warn" | "error") => void;
  latestPreciseRequestRef: MutableRefObject<number | null>;
  setPreciseTarget: Dispatch<SetStateAction<PreciseTarget | null>>;
  setReturnPromptShown: Dispatch<SetStateAction<boolean>>;
  chapterStateRef: MutableRefObject<ChapterState>;
  setChapterState: Dispatch<SetStateAction<ChapterState>>;
  pendingChapterSeekRef: MutableRefObject<PendingChapterSeek | null>;
  dispatchScrub: (event: ScrubUiEvent) => void;
  scrubSessionRef: MutableRefObject<number>;
  scrubUiStateRef: MutableRefObject<ScrubUiState>;
  navigationPendingRef: ReaderSessionHost["navigationPendingRef"];
  contentAxisRef: MutableRefObject<ContentAxis | null>;
  bookRef: MutableRefObject<Book | null>;
  spineIndexRef: MutableRefObject<number>;
  readerRef: RefObject<ReaderHandle>;
  lastStablePositionRef: MutableRefObject<ReaderHistoryPosition>;
  activeSessionRef: MutableRefObject<ActiveSession | null>;
  readingModeRef: MutableRefObject<ReaderSettings["readingMode"]>;
  applyCount: (generation: number, index: number, value: number, source: "estimated" | "measured") => boolean;
  dropTocFollowSeek: (token: ScrubToken) => void;
  followTocAfterSeek: (token: ScrubToken) => void;
  setSpineIndex: Dispatch<SetStateAction<number>>;
  setAnchor: Dispatch<SetStateAction<string | undefined>>;
  setStartAtEnd: Dispatch<SetStateAction<{ nonce: number; atEnd: boolean }>>;
  closeImageOverlay: () => void;
  closeForeground: () => void;
  beginExplicitNavigation: ReaderSessionHost["beginExplicitNavigation"];
  toPersistedReaderAnchor: ToPersistedReaderAnchor;
}): ReaderChapterCallbacks {
  /** 语义锚点失败：解除显示门，但守住进度，直到读者真实移动后再写。 */
  const handleReaderNavigationUnresolved = useCallback((reported: boolean, ticket?: RestoreTicket | null): void => {
    if (ticket) {
      dispatchRestoreGate({ type: "resolved", ticket, located: false });
      dispatchRestoreGate({ type: "display-ready", ticket });
    }
    dispatchReaderSession({ type: "navigation-unresolved" });
    setSearchNavigationBusy(false);
    setInitialAnchor(null);
    setInitialPage(0);
    // The gate may remain unresolved until a real user commit; keep the
    // source ticket alive for that later callback. Explicit navigation
    // clears it separately via releaseRestoreForExplicitNavigation.
    if (!restoreGateRef.current) setInitialRestoreTicket(null);
    setInitialAlignment("context");
    if (!reported) showReaderNotice(uiText("notice.reader.positionNotFound"), "warn");
  }, [showReaderNotice, dispatchRestoreGate]);

  /** 分页视图的首次恢复结果；预加载与过期章节已在视图内/此处过滤。 */
  const handleReaderRestoreResult = useCallback((result: {
    chapterPath: string;
    located: boolean;
    ticket: RestoreTicket | null;
  }): void => {
    const ticket = result.ticket;
    if (!ticket || !restoreResultMatches(ticket, result.chapterPath)) return;
    const resolving = restoreGateRef.current?.phase === "resolving";
    dispatchRestoreGate({ type: "resolved", ticket, located: result.located });
    if (resolving && !result.located) {
      showReaderNotice(uiText("notice.reader.positionNotFoundKept"), "warn");
    }
  }, [dispatchRestoreGate, restoreResultMatches, showReaderNotice]);

  const handlePreciseNavigationStatus = useCallback((status: {
    requestId: number;
    status: PreciseNavigationStatus;
    exact: boolean;
  }): void => {
    if (latestPreciseRequestRef.current !== status.requestId) return;
    latestPreciseRequestRef.current = null;
    setPreciseTarget(null);
    if (status.status === "unresolved") {
      showReaderNotice(uiText("notice.reader.sourceNotFoundNote"), "warn");
    } else if (status.status === "located-reference") {
      showReaderNotice(uiText("notice.reader.paragraphOnly"), "warn");
    } else if (status.status === "unsupported-highlight") {
      showReaderNotice(uiText("notice.reader.noHighlight"), "warn");
    }
  }, [showReaderNotice]);

  // ---- 章节状态回调 ----
  const handleUserReadingPositionChange = useCallback((ticket?: RestoreTicket | null) => {
    // 只有宿主实际用户位移才解除失败保护，重排和采样变化不能代替用户输入。
    dispatchReaderSession({ type: "user-position-committed" });
    setReturnPromptShown(false);
    if (ticket) {
      dispatchRestoreGate({ type: "user-position-committed", ticket });
      // A matching user commit normally clears the gate. If it did not match
      // (stale callback), keep whatever ticket the live gate still owns.
      if (!restoreGateRef.current) setInitialRestoreTicket(null);
    }
  }, [dispatchRestoreGate]);

  const onPageState = useCallback((s: ChapterState) => {
    chapterStateRef.current = s;
    setChapterState(s);
    if (s.status === "error") {
      const failedSeek = pendingChapterSeekRef.current;
      pendingChapterSeekRef.current = null;
      if (failedSeek) {
        dispatchScrub({ type: "failed", token: failedSeek.token });
        dispatchReaderSession({ type: "scrub-reader-aborted" });
      }
    }
    if (s.status === "ready" && s.mode !== "scroll" && !navigationPendingRef.current) {
      const axis = contentAxisRef.current;
      const currentBook = bookRef.current;
      if (currentBook) {
        const linearIndices = currentBook.spine.map((item, i) => (item.linear ? i : -1)).filter((i) => i >= 0);
        const isLastLinear = nextLinearIndex(currentBook, spineIndexRef.current, 1) === -1 || linearIndices.at(-1) === spineIndexRef.current;
        const atEnd = s.atEnd === true || (isLastLinear && s.currentPage >= s.pageCount - 1);
        if (axis) {
          const seg = axis.segments.find((item) => item.spineIndex === spineIndexRef.current);
          if (seg) {
            const intra = currentBook.sourceFormat === "comic-zip" ? s.totalScrollProgress ?? 0 : s.pageCount > 1 ? s.currentPage / (s.pageCount - 1) : 1;
            const ratio = atEnd ? 1 : axis.ratioAt({ key: seg.key, fraction: intra });
            if (ratio !== null) {
              dispatchScrub({
                type: "sample",
                session: scrubSessionRef.current,
                actual: { ratio, atEnd },
              });
            }
          } else if (atEnd) {
            dispatchScrub({
              type: "sample",
              session: scrubSessionRef.current,
              actual: { ratio: 1, atEnd: true },
            });
          }
        } else if (atEnd) {
          dispatchScrub({
            type: "sample",
            session: scrubSessionRef.current,
            actual: { ratio: 1, atEnd: true },
          });
        }
      }
    }
  }, [dispatchScrub]);

  const handleReaderDisplayReady = useCallback((ticket?: RestoreTicket | null) => {
    // 连续视图失败走 onNavigationUnresolved；能走到 display-ready 即目标已提交。
    // 分页视图由 onRestoreResult 结算，display-ready 不能解除失败保护。
    if (ticket) {
      if (readingModeRef.current === "scroll" && !bookRef.current?.fixedLayout) {
        dispatchRestoreGate({ type: "resolved", ticket, located: true });
      }
      dispatchRestoreGate({ type: "display-ready", ticket });
    }
    dispatchReaderSession({ type: "display-ready" });
    setSearchNavigationBusy(false);
    setInitialAlignment("context");
    const pendingSeek = pendingChapterSeekRef.current;
    pendingChapterSeekRef.current = null;
    const scrubPending = scrubUiStateRef.current.pending;
    const matchingSeek = pendingSeek && pendingSeek.target.spineIndex === spineIndexRef.current &&
      pendingSeek.token.session === scrubPending?.session && pendingSeek.token.request === scrubPending?.request
      ? pendingSeek : null;
    if (pendingSeek && !matchingSeek) {
      dropTocFollowSeek(pendingSeek.token);
      dispatchScrub({ type: "cancelled", token: pendingSeek.token });
    }
    if (matchingSeek) {
      // setPage 同步发布页态，下面读到的就是定位后的状态。只有分页同步落位才在此跟随目录；
      // 稍后落位的视图（漫画）由 onContentFractionSettled 回报。
      if (readerRef.current?.seekContentFraction?.(matchingSeek.target, matchingSeek.token) === true) {
        followTocAfterSeek(matchingSeek.token);
      }
    }
    const state = chapterStateRef.current;
    const readingAnchor = readerRef.current?.getReadingAnchor();
    const currentBook = bookRef.current;
    const currentIndex = spineIndexRef.current;
    if (state.status === "ready" && state.mode !== "scroll" && currentBook) {
      const linearIndices = currentBook.spine.map((item, i) => (item.linear ? i : -1)).filter((i) => i >= 0);
      const isLastLinear = nextLinearIndex(currentBook, currentIndex, 1) === -1 || linearIndices.at(-1) === currentIndex;
      const atEnd = state.atEnd === true || (isLastLinear && state.currentPage >= state.pageCount - 1);
      const axis = contentAxisRef.current;
      if (axis) {
        const seg = axis.segments.find((item) => item.spineIndex === currentIndex);
        if (seg) {
          const intra = currentBook.sourceFormat === "comic-zip" ? state.totalScrollProgress ?? 0 : state.pageCount > 1 ? state.currentPage / (state.pageCount - 1) : 1;
          const ratio = atEnd ? 1 : axis.ratioAt({ key: seg.key, fraction: intra });
          if (ratio !== null) {
            dispatchScrub(matchingSeek
              ? { type: "settled", token: matchingSeek.token, actual: { ratio, atEnd } }
              : { type: "sample", session: scrubSessionRef.current, actual: { ratio, atEnd } });
          }
        } else if (atEnd) {
          dispatchScrub({
            type: "sample",
            session: scrubSessionRef.current,
            actual: { ratio: 1, atEnd: true },
          });
        }
      } else if (atEnd) {
        dispatchScrub({
          type: "sample",
          session: scrubSessionRef.current,
          actual: { ratio: 1, atEnd: true },
        });
      }
    }
    const active = activeSessionRef.current;
    const expectedPath = currentBook ? spineItemPath(currentBook, currentIndex) : undefined;
    if (
      active &&
      expectedPath &&
      state.status === "ready" &&
      !state.empty &&
      readingAnchor?.path === expectedPath &&
      Number.isSafeInteger(readingAnchor.totalChars) &&
      readingAnchor.totalChars >= 0
    ) {
      const measuredChars = measuredChapterWeight(
        readingAnchor.totalChars,
        readingAnchor.mediaUnits,
        state.pageCount,
      );
      applyCount(active.generation, currentIndex, measuredChars, "measured");
    }
    // 恢复未放行（未结算/定位失败）时保留开书写入的原位置，历史返回不指向章首。
    const restoreBlocked = restoreGateRef.current !== null && !mayCommitRestoredProgress(restoreGateRef.current);
    if (
      !restoreBlocked &&
      active &&
      expectedPath &&
      state.status === "ready" &&
      !state.empty &&
      readingAnchor?.path === expectedPath &&
      Number.isSafeInteger(readingAnchor.totalChars) &&
      readingAnchor.totalChars >= 0
    ) {
      lastStablePositionRef.current = {
        spineIndex: currentIndex,
        page: state.currentPage,
        anchor: toPersistedReaderAnchor(
          {
            index: readingAnchor.index,
            ratio: readingAnchor.ratio,
            anchorTextOffset: readingAnchor.textOffset,
            anchorTextSnippet: readingAnchor.textSnippet,
            mediaAnchor: readingAnchor.mediaAnchor ?? null,
          }
        ),
      };
    }
    // Future chapter changes are ordinary navigation, not another attempt to
    // apply this opening/history restore. Keep the source ticket when the
    // restore failed, so a later real user commit can still settle that gate.
    setInitialAnchor(null);
    if (!restoreGateRef.current) setInitialRestoreTicket(null);
    setInitialPage(0);
    // Display-ready flips a state gate; the following render runs the normal
    // progress effect with the newest derived percentage and anchor.
  }, [applyCount]);

  const handleVisibleChapterChange = useCallback(
    (index: number, anchor: ReadingAnchor | null) => {
      // 连续滚动模式观察到的章节变化：只更新目录高亮、阅读线归属及持久化锚点，
      // 绝不调用 handleRequestChapter、不清前台、不设置 readerDisplayReady(false)。
      spineIndexRef.current = index;
      setSpineIndex(index);
      if (anchor) {
        lastStablePositionRef.current = {
          spineIndex: index,
          page: 0,
          anchor: toPersistedReaderAnchor({
            index: anchor.index,
            ratio: anchor.ratio,
            anchorTextOffset: anchor.textOffset,
            anchorTextSnippet: anchor.textSnippet,
            mediaAnchor: anchor.mediaAnchor ?? null,
          }),
        };
      }
    },
    []
  );

  const handleRequestChapter = useCallback(
    (index: number, opts?: { atEnd?: boolean }) => {
      // 换章前先关闭图片浮层，避免继续引用即将撤销的资源 URL。
      closeImageOverlay();
      // 翻过章节边界也是用户自己往下读：收起跳转返回提示（跳转本身随后会重新显示它）。
      setReturnPromptShown(false);
      setPreciseTarget(null);
      latestPreciseRequestRef.current = null;
      beginExplicitNavigation();
      setSpineIndex(index);
      setAnchor(undefined);
      // 对象每次请求都新建：连续回翻多次时每次都能触发 atEnd 武装
      setStartAtEnd((prev) => ({ nonce: prev.nonce + 1, atEnd: opts?.atEnd === true }));
      closeForeground();
    },
    [closeForeground, closeImageOverlay]
  );

  return {
    handleUserReadingPositionChange,
    onPageState,
    handleReaderDisplayReady,
    handleVisibleChapterChange,
    handleRequestChapter,
    handleReaderNavigationUnresolved,
    handleReaderRestoreResult,
    handlePreciseNavigationStatus,
  };
}
