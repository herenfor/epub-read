/**
 * A13-2 双页章边拼接屏（纯计算，无 DOM 状态）。
 *
 * 上一章最后一屏只有第一页、下一章开头带读者空栏时，两章各露一半拼成一屏：
 * 上一章露出第一页那半边，下一章露出第二页那半边。两章都留在各自 iframe 的原位，
 * 不平移、不合并 DOM；离开这一屏时，另一章作为“伴随元素”跟着本章内容一起滑动。
 */
import type { PageProgression } from "../render/pagedDirection";

/** Set to 1 once the host supports joined screens touching both chapter edges. */
export const JOIN_MIN_LEAVES: number = 2;

export function joinCapable(leaves: { contentLeafCount: number; joinable: boolean }): boolean {
  return leaves.joinable && leaves.contentLeafCount >= JOIN_MIN_LEAVES;
}

export interface JoinLeaves {
  /** 实际保留的读者空栏。 */
  readonly leading: 0 | 1;
  readonly contentLeafCount: number;
  readonly joinable: boolean;
  readonly pageCount: number;
}

/**
 * 两章是否在章边留有可拼的一叶。和前缀排布共享能力门槛，不能一边补空栏、一边拒绝拼接。
 */
export function canJoinChapters(earlier: JoinLeaves, later: JoinLeaves): boolean {
  return joinCapable(earlier) && joinCapable(later) && later.leading === 1 &&
    (earlier.leading + earlier.contentLeafCount) % 2 === 1;
}

/**
 * 只露出某一页那半边的裁剪（iframe 自身坐标，随 transform 一起移动）。
 * lane 0 是阅读顺序的第一页：横排从左到右时在左，从右到左时在右。
 */
export function joinLaneClip(lane: 0 | 1, split: number, width: number, progression: PageProgression): string {
  const left = (lane === 0) === (progression !== "rtl");
  return left
    ? `inset(0 ${Math.max(0, width - split)}px 0 0)`
    : `inset(0 0 0 ${Math.max(0, split)}px)`;
}

/** 一本书一个版式一份索引：视口尺寸、排版设置（不含主题）与文本替换版本任一变化都换新。 */
export function chapterFillLayoutKey(
  width: number,
  height: number,
  layoutSettings: unknown,
  textProjectionVersion: string | null,
): string {
  return `${width}x${height}|${textProjectionVersion ?? ""}|${JSON.stringify(layoutSettings)}`;
}
