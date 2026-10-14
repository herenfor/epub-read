import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { reduceReaderSession, type ReaderSessionEvent } from "./readerSession";
import {
  beginRestoreCommit,
  mayCommitRestoredProgress,
  reduceRestoreCommit,
  type RestoreCommitEvent,
  type RestoreCommitState,
  type RestoreTicket,
} from "./restoreCommitGate";

/**
 * B3 第 2 批：一本书的阅读会话宿主。
 *
 * 五个会话标志（readerSession）与开书恢复的进度回写门（restoreCommitGate）都只在这里
 * 写入。ref 供事件处理同步读取；渲染只读返回的 state。以后的双页/多阅读器宿主
 * （A10③、A13、A14）按“每个阅读器一份会话”复用本 hook，不再在 App 里手写成组赋值。
 */
export interface ReaderSessionHost {
  /** 只读：写入一律经 dispatchReaderSession。 */
  readonly readerDisplayReadyRef: Readonly<MutableRefObject<boolean>>;
  readonly navigationPendingRef: Readonly<MutableRefObject<boolean>>;
  readonly historyCaptureAllowedRef: Readonly<MutableRefObject<boolean>>;
  readonly suppressShelfProgressRef: Readonly<MutableRefObject<boolean>>;
  /** 只读：写入一律经 startRestore / dispatchRestoreGate / release / clear。 */
  readonly restoreGateRef: Readonly<MutableRefObject<RestoreCommitState | null>>;
  /** 渲染用：正文已就绪。 */
  readonly readerDisplayReady: boolean;
  /** 渲染用：本书显示过第一页。 */
  readonly displayedOnce: boolean;
  /** 渲染用：首次恢复已结算（统计任务在此之后启动，前台开章优先）。 */
  readonly restoreSettled: boolean;
  /** 交给阅读视图的恢复票据；结算后由调用方按门的状态清空。 */
  readonly initialRestoreTicket: RestoreTicket | null;
  readonly setInitialRestoreTicket: (ticket: RestoreTicket | null) => void;
  readonly dispatchReaderSession: (event: ReaderSessionEvent) => void;
  /** 目录、书内链接、搜索、历史、笔记、书签、换章：用户选定新目标。 */
  readonly beginExplicitNavigation: () => void;
  /** 显式导航（含拖动进度）由用户选定目标：作废未结算的旧恢复。 */
  readonly releaseRestoreForExplicitNavigation: () => void;
  readonly dispatchRestoreGate: (event: RestoreCommitEvent) => void;
  /** 只有当前会话、当前恢复请求、同一章节的完整 ticket 才能结算。 */
  readonly restoreResultMatches: (ticket: RestoreTicket, chapterPath: string) => boolean;
  /** 开书：发新票据；没有正文/元素/媒体目标时按正常开章立即结算。 */
  readonly startRestore: (session: number, chapterPath: string, settledAtOpen: boolean) => void;
  /** 关书：丢弃门与票据。 */
  readonly clearRestore: () => void;
}

export function useReaderSession(currentGeneration: () => number | undefined): ReaderSessionHost {
  const readerDisplayReadyRef = useRef(false);
  const hasReaderDisplayedRef = useRef(false);
  const navigationPendingRef = useRef(false);
  // 每个稳定位置只能被一次显式跳转捕获；新书初始加载时
  // 仍允许以已保存的基线位置记录“第一次跳转”。
  const historyCaptureAllowedRef = useRef(true);
  /** 语义锚点失败后先结束 loading，但禁止把失败落点当作成功进度写盘。 */
  const suppressShelfProgressRef = useRef(false);
  const [readerDisplayReady, setReaderDisplayReady] = useState(false);
  const [displayedOnce, setDisplayedOnce] = useState(false);

  /**
   * 开书恢复的进度回写门。null = 没有待结算的恢复（显式导航已接管或已结算）。
   * 恢复目标解析失败时页面可显示章首，但在用户真实提交新位置前不得写进度。
   */
  const restoreGateRef = useRef<RestoreCommitState | null>(null);
  const restoreRequestRef = useRef(0);
  const [restoreSettled, setRestoreSettled] = useState(true);
  const [initialRestoreTicket, setInitialRestoreTicket] = useState<RestoreTicket | null>(null);
  const generationRef = useRef(currentGeneration);
  generationRef.current = currentGeneration;

  const dispatchReaderSession = useCallback((event: ReaderSessionEvent) => {
    const next = reduceReaderSession({
      displayReady: readerDisplayReadyRef.current,
      displayedOnce: hasReaderDisplayedRef.current,
      navigationPending: navigationPendingRef.current,
      historyCaptureAllowed: historyCaptureAllowedRef.current,
      suppressProgress: suppressShelfProgressRef.current,
    }, event);
    readerDisplayReadyRef.current = next.displayReady;
    hasReaderDisplayedRef.current = next.displayedOnce;
    navigationPendingRef.current = next.navigationPending;
    historyCaptureAllowedRef.current = next.historyCaptureAllowed;
    suppressShelfProgressRef.current = next.suppressProgress;
    setReaderDisplayReady(next.displayReady);
    setDisplayedOnce(next.displayedOnce);
  }, []);

  const dispatchRestoreGate = useCallback((event: RestoreCommitEvent) => {
    const gate = restoreGateRef.current;
    if (!gate) return;
    // Use the event's immutable ticket. A late callback from an old request
    // must never be rewrapped as the current gate's identity.
    const next = reduceRestoreCommit(gate, event);
    restoreGateRef.current = mayCommitRestoredProgress(next) ? null : next;
    if (next.phase !== "resolving") setRestoreSettled(true);
  }, []);

  const restoreResultMatches = useCallback((ticket: RestoreTicket, chapterPath: string): boolean => {
    const gate = restoreGateRef.current;
    return gate !== null
      && gate.ticket.session === ticket.session
      && gate.ticket.request === ticket.request
      && gate.ticket.chapterPath === ticket.chapterPath
      && gate.ticket.chapterPath === chapterPath
      && generationRef.current() === ticket.session;
  }, []);

  const releaseRestoreForExplicitNavigation = useCallback(() => {
    if (restoreGateRef.current) restoreGateRef.current = null;
    setInitialRestoreTicket(null);
    setRestoreSettled(true);
  }, []);

  const beginExplicitNavigation = useCallback(() => {
    dispatchReaderSession({ type: "begin-explicit" });
    releaseRestoreForExplicitNavigation();
  }, [dispatchReaderSession, releaseRestoreForExplicitNavigation]);

  const startRestore = useCallback((session: number, chapterPath: string, settledAtOpen: boolean) => {
    const ticket: RestoreTicket = { session, request: ++restoreRequestRef.current, chapterPath };
    let gate = beginRestoreCommit(ticket);
    if (settledAtOpen) gate = reduceRestoreCommit(gate, { type: "resolved", ticket, located: true });
    restoreGateRef.current = gate;
    setInitialRestoreTicket(ticket);
    setRestoreSettled(gate.phase !== "resolving");
  }, []);

  const clearRestore = useCallback(() => {
    restoreGateRef.current = null;
    setInitialRestoreTicket(null);
  }, []);

  return {
    readerDisplayReadyRef, navigationPendingRef, historyCaptureAllowedRef, suppressShelfProgressRef, restoreGateRef,
    readerDisplayReady, displayedOnce, restoreSettled, initialRestoreTicket, setInitialRestoreTicket,
    dispatchReaderSession, beginExplicitNavigation, releaseRestoreForExplicitNavigation,
    dispatchRestoreGate, restoreResultMatches, startRestore, clearRestore,
  };
}
