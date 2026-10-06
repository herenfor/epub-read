/** 原生吸附翻页的纯几何：读取视觉位置、决定手势归属与离散翻页计划；不碰 DOM/存储。 */
export type PageDirection = 1 | -1;
export const SNAP_EDGE_EPSILON_PX = 1;

export interface SnapPosition {
  /** Screen/spread index, never a physical leaf index. */
  readonly page: number;
  readonly left: number;
  readonly snapLeft: number;
  readonly aligned: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

/** Caller supplies ascending reader-owned offsets, cached for the current layout. */
export function readSnapPosition(
  offsets: readonly number[],
  scrollLeft: number,
): SnapPosition | null {
  if (offsets.length === 0) return null;
  const last = offsets.length - 1;
  // Preserve the actual visual origin for a smooth JS takeover.
  const left = scrollLeft;
  const queryLeft = Math.max(offsets[0], Math.min(offsets[last], left));
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsets[mid] < queryLeft) lo = mid + 1;
    else hi = mid;
  }
  const upper = lo;
  const lower = Math.max(0, upper - 1);
  // At the exact midpoint keep the lower page, matching the existing selector.
  const page = queryLeft - offsets[lower] <= offsets[upper] - queryLeft ? lower : upper;
  return {
    page,
    left,
    snapLeft: offsets[page],
    aligned: Math.abs(left - offsets[page]) <= SNAP_EDGE_EPSILON_PX,
    atStart: left <= offsets[0] + SNAP_EDGE_EPSILON_PX,
    atEnd: left >= offsets[last] - SNAP_EDGE_EPSILON_PX,
  };
}

/** A fresh edge gesture can cross chapters; a gesture that reaches the edge cannot. */
export function chooseNativeSwipeOwner(
  origin: SnapPosition,
  now: SnapPosition,
  direction: PageDirection,
): "native" | "js" {
  const edge = (position: SnapPosition): boolean =>
    direction === 1 ? position.atEnd : position.atStart;
  return edge(origin) && edge(now) ? "js" : "native";
}

export type PagedStepPlan =
  | { readonly kind: "page"; readonly page: number; readonly from: number; readonly to: number }
  | { readonly kind: "chapter"; readonly direction: PageDirection; readonly fromPage: number }
  | { readonly kind: "book-edge"; readonly page: number };

/**
 * Discrete command after JS owns the input. Start at the actual visual offset.
 * A nearest-page == lastPage preview is insufficient to cross a chapter.
 */
export function planPagedStep(
  offsets: readonly number[],
  position: SnapPosition,
  direction: PageDirection,
  hasAdjacentChapter: boolean,
  chapterAllowed = true,
): PagedStepPlan {
  const target = position.page + direction;
  if (target >= 0 && target < offsets.length) {
    return { kind: "page", page: target, from: position.left, to: offsets[target] };
  }
  const atPhysicalEdge = direction === 1 ? position.atEnd : position.atStart;
  if (!atPhysicalEdge || !chapterAllowed) {
    // Finish reaching the edge, consume this command, do not also skip chapters.
    return { kind: "page", page: position.page, from: position.left, to: position.snapLeft };
  }
  return hasAdjacentChapter
    ? { kind: "chapter", direction, fromPage: position.page }
    : { kind: "book-edge", page: position.page };
}

/**
 * Read-only anchor sampling while between snap points. Pick a visible content
 * column of the selected spread, excluding margins/gaps. No virtual scroll or
 * offscreen caret hit test. y/text/media resolution stays with the paginator.
 */
export function visibleSnapColumnSampleX(input: {
  readonly position: SnapPosition;
  readonly contentOriginClientX: number;
  readonly viewportLeft: number;
  readonly viewportRight: number;
  readonly columnWidth: number;
  readonly columnStep: number;
  readonly columns: 1 | 2;
}): number | null {
  for (let leaf = 0; leaf < input.columns; leaf++) {
    const start = input.contentOriginClientX + input.position.snapLeft
      + leaf * input.columnStep - input.position.left;
    const end = start + input.columnWidth;
    const left = Math.max(input.viewportLeft, start);
    const right = Math.min(input.viewportRight, end);
    if (right - left >= 4) return (left + right) / 2;
  }
  return null;
}
