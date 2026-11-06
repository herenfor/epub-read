import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { nextLinearIndex, spineItemPath } from "../core/book";
import type { Book } from "../core/types";
import type { ChapterState } from "../render/paginator";
import type { ReaderSettings } from "../render/settings";
import type { ChapterCountCollection } from "./chapterCounts";
import { computeProgressPct, resolveProgressPct, summarizeLinearCounts } from "./chapterCounts";
import { writeChapterCountCache } from "./chapterCountCache";
import { stageCheckpointSample, type CheckpointedSample } from "./checkpointProgressRepair";
import type { LocalProgressCheckpoints } from "./localProgressCheckpoint";
import { uiText } from "./localization/UiLanguageProvider";
import type { ProgressLease } from "./portableState/ownedProgressSessions";
import type { ScopedProgressWriter } from "./progressWriter";
import { currentChapterCharsRead } from "./readingProgress";
import { mayCommitRestoredProgress } from "./restoreCommitGate";
import { applyShelfProgressPatch, getShelfStore, type ShelfEntry, type ShelfProgressPatch } from "./shelf";
import type { ReaderSessionHost } from "./useReaderSession";

type CountSummary = ReturnType<typeof summarizeLinearCounts>;
type ReadReaderPosition = (withText?: boolean) => {
  chapterPath: string | null;
  state: ChapterState;
  readingAnchor: ReturnType<import("./ReaderView").ReaderHandle["getReadingAnchor"]>;
  anchorText: string | null;
};
type ActiveCountSession = {
  readonly countCacheKey: string | null;
  readonly structuralCounts: ChapterCountCollection;
};

export function useShelfProgressCommit({
  view, currentShelfId, spineIndex, book, chapterState, chapterStateRef, settings,
  linearIndices, countSummary, readerDisplayReady, readReaderPosition,
  restoreGateRef, suppressShelfProgressRef, navigationPendingRef,
  setShelfEntries, showReaderNotice,
  activeSessionRef, chapterCountsRef, baselineProgressPctRef, lastCountProgressSignatureRef,
  persistShelfProgressRef, progressWriterRef, activeProgressLeaseRef, localCheckpointsRef,
}: {
  view: "shelf" | "reader";
  currentShelfId: string | null;
  spineIndex: number;
  book: Book | null;
  chapterState: ChapterState;
  chapterStateRef: MutableRefObject<ChapterState>;
  settings: ReaderSettings;
  linearIndices: number[];
  countSummary: CountSummary;
  readerDisplayReady: boolean;
  readReaderPosition: ReadReaderPosition;
  restoreGateRef: ReaderSessionHost["restoreGateRef"];
  suppressShelfProgressRef: ReaderSessionHost["suppressShelfProgressRef"];
  navigationPendingRef: ReaderSessionHost["navigationPendingRef"];
  setShelfEntries: Dispatch<SetStateAction<ShelfEntry[]>>;
  showReaderNotice: (text: string, kind?: "ok" | "warn" | "error") => void;
  activeSessionRef: MutableRefObject<ActiveCountSession | null>;
  chapterCountsRef: MutableRefObject<ChapterCountCollection>;
  baselineProgressPctRef: MutableRefObject<number>;
  lastCountProgressSignatureRef: MutableRefObject<string | null>;
  persistShelfProgressRef: MutableRefObject<(explicit?: boolean) => void>;
  progressWriterRef: MutableRefObject<ScopedProgressWriter<CheckpointedSample<ShelfProgressPatch>> | null>;
  activeProgressLeaseRef: MutableRefObject<ProgressLease | null>;
  localCheckpointsRef: MutableRefObject<LocalProgressCheckpoints<ShelfProgressPatch> | null>;
}) {
  // ---- 书架进度回写（阅读器状态→书架索引，不修改阅读器本体） ----
  /**
   * explicit=false 是随页态变化的自动保存：跳过原生滑动途中的 transient 预览。
   * 返回书架/切后台/关窗/导出/换书是显式保存：用同一次读数的视觉屏与锚点。
   */
  const persistShelfProgress = useCallback((explicit = false) => {
    // 自动与显式（返回书架/后台/关窗）入口同样受恢复门约束：未结算或失败的
    // 恢复不能用当前（可能是章首）位置覆盖原进度与本机检查点。
    if (restoreGateRef.current && !mayCommitRestoredProgress(restoreGateRef.current)) return;
    if (
      suppressShelfProgressRef.current ||
      navigationPendingRef.current ||
      !readerDisplayReady ||
      view !== "reader" ||
      !currentShelfId
    ) return;
    // 自动保存不会消费运动预览；先跳过，避免为了丢弃它而强制同步采样正文。
    // 显式退出/后台/书签仍读取同一次真实视觉位置。
    if (!explicit && chapterStateRef.current.status === "ready" && chapterStateRef.current.transient === true) return;
    const position = readReaderPosition();
    const state = position.state;
    if (state.status !== "ready") return;
    if (state.transient === true && !explicit) return;
    if (position.chapterPath !== null && book && position.chapterPath !== spineItemPath(book, spineIndex)) return;
    const a = position.readingAnchor;
    const currentSummary = summarizeLinearCounts(chapterCountsRef.current, spineIndex);
    const exactChars = currentChapterCharsRead({
      textOffset: a?.textOffset,
      chapterFraction: book?.sourceFormat === "comic-zip" ? state.totalScrollProgress : undefined,
      page: state.currentPage,
      pageCount: state.pageCount,
      chapterChars: currentSummary.current ?? 0,
    });
    const lastLinear = linearIndices.at(-1);
    const isLastLinear = lastLinear === spineIndex || (book ? nextLinearIndex(book, spineIndex, 1) === -1 : false);
    const atBookEnd =
      settings.readingMode === "scroll"
        ? state.status === "ready" && state.atEnd === true
        : state.status === "ready" && (state.atEnd === true || (isLastLinear && state.currentPage >= state.pageCount - 1));
    const exactProgressPct = atBookEnd
      ? 100
      : (() => {
          const pct = computeProgressPct(currentSummary, exactChars);
          return pct === null ? null : Math.min(99, pct);
        })();
    if (exactProgressPct !== null) {
      baselineProgressPctRef.current = resolveProgressPct(
        exactProgressPct,
        baselineProgressPctRef.current
      );
    }
    const patch: ShelfProgressPatch = {
      lastReadAtMs: Date.now(),
      spineIndex,
      page: state.currentPage,
      progressPct: resolveProgressPct(exactProgressPct, baselineProgressPctRef.current),
      // -1 is an internal text-only anchor sentinel, never persisted.
      anchorIndex: a && a.index >= 0 ? a.index : null,
      anchorRatio: a && a.index >= 0 ? a.ratio : null,
      anchorTextOffset: a?.textOffset ?? null,
      anchorTextSnippet: a?.textSnippet ?? null,
      mediaAnchor: a?.mediaAnchor ?? null,
      // R5: this is an actually displayed chapter, so a modern locator can be
      // built even for image-only/media and chapter-start positions.
      chapterPath: book ? spineItemPath(book, spineIndex) ?? null : null,
    };
    // 先更新内存态：即使用户立刻返回并重新打开，也不会读到旧位置。
    setShelfEntries((prev) =>
      applyShelfProgressPatch(prev, currentShelfId, patch)
    );
    const lease = activeProgressLeaseRef.current;
    if (lease) {
      const store = getShelfStore();
      const bookHash = store.progressSessionBookHash?.(lease);
      const shownStamp = store.progressSessionChosenStamp?.(lease) ?? null;
      const checkpoints = localCheckpointsRef.current;
      if (bookHash && checkpoints) {
        try {
          // Stage the local recovery record before enqueueing any native IPC.
          const sample = stageCheckpointSample(checkpoints, bookHash, shownStamp, patch);
          progressWriterRef.current?.enqueue(lease, sample);
        } catch (error) {
          showReaderNotice(uiText("notice.progress.localWriteFailed"), "error");
        }
      }
    }
  // page/anchor 变化必须触发写入；不能只依赖取整后的 progressPct，
  // 否则长书连续数页保持同一百分比时会漏掉最新位置。
  }, [view, currentShelfId, spineIndex, readerDisplayReady, chapterState, showReaderNotice, readReaderPosition]);
  persistShelfProgressRef.current = persistShelfProgress;

  useEffect(() => {
    persistShelfProgress(false);
  }, [persistShelfProgress]);

  // 未完成的扫描始终保持同一个 pending 状态；只有完成/可计算摘要变化时
  // 才补写一次进度，避免每章 estimated 回调反复 enqueue 相同 baseline。
  const countProgressSignature = !book
    ? "none"
    : countSummary.complete
      ? `${countSummary.total}:${countSummary.before}:${countSummary.current ?? ""}`
      : "pending";
  const persistChapterCountCache = useCallback(() => {
    const active = activeSessionRef.current;
    if (!active?.countCacheKey) return;
    writeChapterCountCache(active.countCacheKey, chapterCountsRef.current, active.structuralCounts);
  }, []);
  useEffect(() => {
    if (lastCountProgressSignatureRef.current === countProgressSignature) return;
    lastCountProgressSignatureRef.current = countProgressSignature;
    persistShelfProgressRef.current(false);
    if (countSummary.complete) persistChapterCountCache();
  }, [countProgressSignature, countSummary.complete, persistChapterCountCache]);
  return { persistShelfProgress, persistChapterCountCache };
}
