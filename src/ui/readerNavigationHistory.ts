import type { MediaReadingAnchor } from "../render/paginator";

/** Pure bounded back/forward state for explicit reader navigation. */
export const READER_HISTORY_LIMIT = 3;

export interface ReaderNavigationPosition {
  spineIndex: number;
  page: number;
  anchor: {
    index: number;
    ratio: number;
    anchorTextOffset?: number | null;
    anchorTextSnippet?: string | null;
    /** B-155：纯图片页的媒体身份/比例；旧历史缺省可读。 */
    mediaAnchor?: MediaReadingAnchor | null;
  } | null;
}

export interface ReaderNavigationHistory {
  back: ReaderNavigationPosition[];
  forward: ReaderNavigationPosition[];
}

export interface HistoryTransition {
  history: ReaderNavigationHistory;
  target: ReaderNavigationPosition | null;
}

export function emptyReaderNavigationHistory(): ReaderNavigationHistory {
  return { back: [], forward: [] };
}

function clonePosition(position: ReaderNavigationPosition): ReaderNavigationPosition {
  return {
    spineIndex: position.spineIndex,
    page: position.page,
    anchor: position.anchor ? { ...position.anchor } : null,
  };
}

function pushBounded(
  values: ReaderNavigationPosition[],
  value: ReaderNavigationPosition,
): ReaderNavigationPosition[] {
  return [...values.slice(-(READER_HISTORY_LIMIT - 1)), clonePosition(value)];
}

/** A new explicit navigation invalidates forward history. */
export function recordReaderNavigation(
  history: ReaderNavigationHistory,
  current: ReaderNavigationPosition,
): ReaderNavigationHistory {
  return {
    back: pushBounded(history.back, current),
    forward: [],
  };
}

/** Move one step backward, exchanging the current position onto forward. */
export function readerHistoryBack(
  history: ReaderNavigationHistory,
  current: ReaderNavigationPosition,
): HistoryTransition {
  const target = history.back.at(-1);
  if (!target) return { history, target: null };
  return {
    target: clonePosition(target),
    history: {
      back: history.back.slice(0, -1).map(clonePosition),
      forward: pushBounded(history.forward, current),
    },
  };
}

/** Move one step forward, exchanging the current position onto back. */
export function readerHistoryForward(
  history: ReaderNavigationHistory,
  current: ReaderNavigationPosition,
): HistoryTransition {
  const target = history.forward.at(-1);
  if (!target) return { history, target: null };
  return {
    target: clonePosition(target),
    history: {
      back: pushBounded(history.back, current),
      forward: history.forward.slice(0, -1).map(clonePosition),
    },
  };
}
