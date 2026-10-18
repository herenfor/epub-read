/**
 * A16 第二阶段：双页时普通视图与 A13 并排组之间的显示层规划（纯计算，无 DOM）。
 *
 * 连续滑动开启时，外层同时保留当前显示和前后相邻的显示层：相邻的并排组提前排好；
 * 普通分页视图不再随进入并排组而卸载，而是隐藏、停在并排组之后的第一个普通章，
 * 等前置章节读完时直接滑过去。隐藏层不向 App 汇报任何事。
 */
import { nextLinearIndex } from "../core/book";
import type { Book } from "../core/types";
import type { ReaderViewProps } from "./ReaderView";
import type { SingleLeafSpread } from "./singleLeafSpreads";

export type LayerRole = "main" | "standby";

export type PresentationLayer =
  | { key: "paged"; kind: "paged"; spineIndex: number; role: LayerRole }
  | { key: string; kind: "pair"; spread: SingleLeafSpread; spineIndex: number; role: LayerRole };

export interface PresentationPlan {
  layers: PresentationLayer[];
  mainKey: string;
  /** 向后/向前联动的目标层与它要请求的章节；null 表示那一侧没有预备层（走原换章）。 */
  nextKey: string | null;
  nextIndex: number;
  prevKey: string | null;
  prevIndex: number;
}

export const PAGED_LAYER = "paged";

export function pairLayerKey(spread: SingleLeafSpread): string {
  return `pair:${spread.left}:${spread.right ?? "-"}`;
}

/** 连续成段的并排组最多向后找这么多组来定普通视图的停靠章。 */
const PARK_SEARCH_LIMIT = 16;

/**
 * peek(i)：i 所在的并排组；null = 确认是普通章；undefined = 尚未分类（按普通章处理）。
 * 当前章的组由调用方给出（它已按窗口几何确认能否并排）。
 */
export function planPresentationLayers(
  book: Book,
  spineIndex: number,
  current: SingleLeafSpread | null,
  peek: (index: number) => SingleLeafSpread | null | undefined,
): PresentationPlan {
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
    { key: PAGED_LAYER, kind: "paged", spineIndex: current ? parked : spineIndex, role: current ? "standby" : "main" },
  ];
  // 往回进入并排组请求的是它的最后一章（与原换章相同，带 atEnd）。
  if (prevPair) layers.push({ key: pairLayerKey(prevPair), kind: "pair", spread: prevPair, spineIndex: prevIndex, role: "standby" });
  if (current) layers.push({ key: pairLayerKey(current), kind: "pair", spread: current, spineIndex, role: "main" });
  if (nextPair) layers.push({ key: pairLayerKey(nextPair), kind: "pair", spread: nextPair, spineIndex: nextIndex, role: "standby" });

  const mainKey = current ? pairLayerKey(current) : PAGED_LAYER;
  return {
    layers,
    mainKey,
    nextKey: nextPair ? pairLayerKey(nextPair) : current && parked === nextIndex ? PAGED_LAYER : null,
    nextIndex,
    // 普通视图只为向后读停靠，往回出前置章节仍走原换章。
    prevKey: prevPair ? pairLayerKey(prevPair) : null,
    prevIndex,
  };
}

/** 预备层不用的导航起点；与 App 的任何 nonce 都不同。 */
export const STANDBY_START = Object.freeze({ nonce: -1, atEnd: false });
const NOOP = () => {};
/** 隐藏层仍需要的查询（不向 App 汇报，只读）。 */
const KEPT_FUNCTIONS = new Set([
  "notesForChapter", "chapterNeighbor", "seamTargetEligible", "chapterFillKind", "resolveChapterFillKind",
]);

/**
 * 预备层的属性：停在 spineIndex，不接输入，不定位锚点，所有回调静默（进度、恢复、
 * 状态、日志、脚注……都只属于当前显示）。成为当前显示时换回 App 的真实属性。
 */
export function standbyReaderProps(props: ReaderViewProps, spineIndex: number): ReaderViewProps {
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
    startAtEnd: STANDBY_START,
    inputPaused: true,
    notes: props.notesForChapter?.(spineIndex) ?? [],
    bookmarkCue: null,
  });
  return out as unknown as ReaderViewProps;
}
