/**
 * A16 第二阶段：双页时普通视图与 A13 并排组之间的显示层规划（纯计算，无 DOM）。
 *
 * 连续滑动开启时，外层同时保留当前显示和前后相邻的显示层：相邻的并排组提前排好；
 * 普通分页视图保留身份；前后普通章分别准备章首/章末。两侧都是普通章时最多增加
 * 一个预备层，落定后由目标层直接接管。隐藏层不向 App 汇报任何事。
 */
import { nextLinearIndex } from "../core/book";
import type { Book } from "../core/types";
import type { ReaderViewProps } from "./ReaderView";
import type { SingleLeafSpread } from "./singleLeafSpreads";

export type LayerRole = "main" | "standby";
export type PagedLayerKey = "paged" | "paged-return";

export type PresentationLayer =
  | { key: PagedLayerKey; kind: "paged"; spineIndex: number; role: LayerRole; edge: "start" | "end" }
  | { key: string; kind: "pair"; spread: SingleLeafSpread; spineIndex: number; role: LayerRole };

export interface PresentationPlan {
  layers: PresentationLayer[];
  mainKey: string;
  /** 向后/向前联动的目标层与它要请求的章节；null 表示那一侧没有预备层（走原换章）。 */
  nextKey: string | null;
  nextIndex: number;
  prevKey: string | null;
  prevIndex: number;
  /** One bounded visual group beyond the immediate neighbour to classify. */
  lookaheadIndex: number;
}

export const PAGED_LAYER = "paged";

export function pairLayerKey(spread: SingleLeafSpread): string {
  return `pair:${spread.left}:${spread.right ?? "-"}`;
}

/** 连续成段的并排组最多向后找这么多组来定普通视图的停靠章。 */
const PARK_SEARCH_LIMIT = 16;
/** 当前组之后最多常驻这么多组（前置彩页/短章段通常不超过这个数）。 */
export const RESIDENT_RUN_GROUPS = 6;
/** 一条联动轨道在当前屏两侧最多各带这么多屏。 */
export const SEAM_TRACK_REACH = 6;

export interface SeamTrackScreen {
  key: string;
  /** 落定在这一屏时请求的章：向后为组的第一章/普通章；向前为组的最后一章（带 atEnd）。 */
  spineIndex: number;
  atEnd: boolean;
}

export interface SeamTrack {
  /** 按阅读顺序排列，含当前显示层。 */
  screens: SeamTrackScreen[];
  current: number;
}

/**
 * 当前显示层两侧已排好的连续显示层，按阅读顺序连成一条轨道。只沿真实的线性相邻关系走：
 * 并排组一屏一组；遇到普通章停在它的章首（向后）或章末（向前）那一层；未分类、没有
 * 预备层或没就绪就停。ready(key, edge) 由宿主按层的 seamReady 回答。
 */
export function planSeamTrack(
  book: Book,
  plan: PresentationPlan,
  current: SingleLeafSpread | null,
  spineIndex: number,
  peek: (index: number) => SingleLeafSpread | null | undefined,
  ready: (key: string, edge: "start" | "end") => boolean,
  reach = SEAM_TRACK_REACH,
): SeamTrack {
  const first = current?.left ?? spineIndex;
  const last = current ? current.right ?? current.left : spineIndex;
  const walk = (direction: 1 | -1): SeamTrackScreen[] => {
    const out: SeamTrackScreen[] = [];
    const edge = direction === 1 ? "start" : "end";
    let at = nextLinearIndex(book, direction === 1 ? last : first, direction);
    while (at >= 0 && out.length < reach) {
      const group = peek(at);
      if (group === undefined) break;
      if (group === null) {
        const paged = plan.layers.find((layer) => layer.kind === "paged" && layer.spineIndex === at && layer.edge === edge);
        if (paged && ready(paged.key, edge)) out.push({ key: paged.key, spineIndex: at, atEnd: direction === -1 });
        break;
      }
      const key = pairLayerKey(group);
      if (!plan.layers.some((layer) => layer.key === key) || !ready(key, edge)) break;
      out.push({ key, spineIndex: at, atEnd: direction === -1 });
      at = nextLinearIndex(book, direction === 1 ? group.right ?? group.left : group.left, direction);
    }
    return out;
  };
  const before = walk(-1).reverse();
  const after = walk(1);
  return {
    screens: [...before, { key: plan.mainKey, spineIndex, atEnd: false }, ...after],
    current: before.length,
  };
}

/**
 * peek(i)：i 所在的并排组；null = 确认是普通章；undefined = 尚未分类（按普通章处理）。
 * 当前章的组由调用方给出（它已按窗口几何确认能否并排）。
 */
export function planPresentationLayers(
  book: Book,
  spineIndex: number,
  current: SingleLeafSpread | null,
  peek: (index: number) => SingleLeafSpread | null | undefined,
  resident?: { key: PagedLayerKey; spineIndex: number; warmDirection?: -1 | 0 | 1 },
): PresentationPlan {
  const pagedKey = resident?.key ?? PAGED_LAYER;
  const first = current?.left ?? spineIndex;
  const last = current ? current.right ?? current.left : spineIndex;
  const nextIndex = nextLinearIndex(book, last, 1);
  const prevIndex = nextLinearIndex(book, first, -1);
  const nextPair = nextIndex >= 0 ? peek(nextIndex) ?? null : null;
  const prevPair = prevIndex >= 0 ? peek(prevIndex) ?? null : null;

  // 显示并排组时，普通视图停在这一段并排组之后的第一个普通章（向后读完前置章节时直接接上）。
  let parked = spineIndex;
  if (current) {
    let index = nextIndex;
    for (let step = 0; index >= 0 && step < PARK_SEARCH_LIMIT; step++) {
      const spread = peek(index);
      if (!spread) break;
      index = nextLinearIndex(book, spread.right ?? spread.left, 1);
    }
    parked = index >= 0 ? index : current.left;
  }

  const layers: PresentationLayer[] = [
    { key: pagedKey, kind: "paged", spineIndex: current ? parked : spineIndex,
      role: current ? "standby" : "main", edge: "start" },
  ];
  let nextPagedKey: PagedLayerKey = pagedKey;
  let prevPagedKey: PagedLayerKey | null = null;
  if (current && prevIndex >= 0 && peek(prevIndex) === null) {
    // Only immediate neighbors need ready screens. Reuse the resident paged
    // view for the previous edge unless the next edge also needs it.
    const nextNeedsPaged = !nextPair && parked === nextIndex;
    const otherKey = pagedKey === PAGED_LAYER ? "paged-return" : PAGED_LAYER;
    prevPagedKey = nextNeedsPaged && resident?.spineIndex !== prevIndex ? otherKey : pagedKey;
    nextPagedKey = nextNeedsPaged && prevPagedKey === pagedKey ? otherKey : pagedKey;
    const previous: PresentationLayer = {
      key: prevPagedKey, kind: "paged", spineIndex: prevIndex, role: "standby", edge: "end",
    };
    if (nextNeedsPaged) {
      layers[0] = { key: nextPagedKey, kind: "paged", spineIndex: nextIndex, role: "standby", edge: "start" };
      layers.push(previous);
    } else layers[0] = previous;
  }
  // 往回进入并排组请求的是它的最后一章（与原换章相同，带 atEnd）。
  if (prevPair) layers.push({ key: pairLayerKey(prevPair), kind: "pair", spread: prevPair, spineIndex: prevIndex, role: "standby" });
  if (current) layers.push({ key: pairLayerKey(current), kind: "pair", spread: current, spineIndex, role: "main" });
  if (nextPair) layers.push({ key: pairLayerKey(nextPair), kind: "pair", spread: nextPair, spineIndex: nextIndex, role: "standby" });

  // Short front-matter chapters can be consumed faster than a cold iframe
  // prepares. Keep just one extra pair ahead of the recent reading direction,
  // so it is already resident when the immediate neighbour is promoted.
  const direction = resident?.warmDirection ?? 0;
  const adjacentPair = direction === 1 ? nextPair : direction === -1 ? prevPair : null;
  const lookaheadIndex = adjacentPair ? nextLinearIndex(book,
    direction === 1 ? adjacentPair.right ?? adjacentPair.left : adjacentPair.left, direction as 1 | -1) : -1;
  const ahead = lookaheadIndex >= 0 ? peek(lookaheadIndex) : null;
  if (ahead && !layers.some((layer) => layer.key === pairLayerKey(ahead))) {
    layers.push({ key: pairLayerKey(ahead), kind: "pair", spread: ahead, spineIndex: lookaheadIndex, role: "standby" });
  }
  // A16-3: the rest of a forward run of groups stays resident (bounded), so a
  // fast run of turns moves along prepared screens instead of preparing new
  // documents while the reader is turning. Kept groups never reload on landing.
  if (direction === 1) {
    let at = nextLinearIndex(book, last, 1);
    for (let count = 0; at >= 0 && count < RESIDENT_RUN_GROUPS; count++) {
      const group = peek(at);
      if (!group) break;
      if (!layers.some((layer) => layer.key === pairLayerKey(group))) {
        layers.push({ key: pairLayerKey(group), kind: "pair", spread: group, spineIndex: at, role: "standby" });
      }
      at = nextLinearIndex(book, group.right ?? group.left, 1);
    }
  }

  const mainKey = current ? pairLayerKey(current) : pagedKey;
  return {
    layers,
    mainKey,
    nextKey: nextPair ? pairLayerKey(nextPair) : current && parked === nextIndex ? nextPagedKey : null,
    nextIndex,
    prevKey: prevPair ? pairLayerKey(prevPair) : prevPagedKey,
    prevIndex,
    lookaheadIndex,
  };
}

/** 预备层不用的导航起点；与 App 的任何 nonce 都不同。 */
export const STANDBY_START = Object.freeze({ nonce: -1, atEnd: false });
export const STANDBY_END = Object.freeze({ nonce: -2, atEnd: true });
const NOOP = () => {};
/** 隐藏层仍需要的查询（不向 App 汇报，只读）。 */
const KEPT_FUNCTIONS = new Set([
  "notesForChapter", "chapterNeighbor", "seamTargetEligible", "chapterFillKind", "resolveChapterFillKind",
]);

/**
 * 预备层的属性：停在 spineIndex，不接输入，不定位锚点，所有回调静默（进度、恢复、
 * 状态、日志、脚注……都只属于当前显示）。成为当前显示时换回 App 的真实属性。
 */
export function standbyReaderProps(props: ReaderViewProps, spineIndex: number, edge: "start" | "end" = "start"): ReaderViewProps {
  const out: Record<string, unknown> = { ...props };
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function" && !KEPT_FUNCTIONS.has(key)) out[key] = NOOP;
  }
  Object.assign(out, {
    spineIndex,
    anchor: undefined,
    initialAnchor: null,
    initialPage: 0,
    preciseTarget: null,
    restoreTicket: null,
    startAtEnd: edge === "end" ? STANDBY_END : STANDBY_START,
    inputPaused: true,
    presentationStandby: true,
    notes: props.notesForChapter?.(spineIndex) ?? [],
    bookmarkCue: null,
  });
  return out as unknown as ReaderViewProps;
}
