/**
 * 舒适双页阅读区：普通横排 LTR 可重排正文的比例边距/中缝核心。
 * 输入来自设置边界与实测正文 BODY 内容宽；不写 DOM、不持有分页状态。
 */
import { createSpreadGeometry, type SpreadGeometry } from "./pagedSpread";

export const COMFORTABLE_SPREAD = {
  outerRatio: 0.05,
  outerMinPx: 32,
  outerMaxPx: 96,
  gapRatio: 0.06,
  gapMinPx: 48,
  gapMaxPx: 96,
  maxColumnEm: 32,
  minColumnEm: 16,
  minColumnPx: 280,
} as const;

export interface SpreadAreaInput {
  /** After author html/body geometry; not screen.width or outer app width. */
  readonly availableWidth: number;
  readonly fontSizePx: number;
  /** Viewer border + padding only; BODY padding was already deducted. */
  readonly viewerInsetLeft: number;
  readonly viewerInsetRight: number;
  /** Missing = automatic. Explicit zero remains zero. */
  readonly leftPx?: number;
  readonly rightPx?: number;
  readonly gapPx?: number;
}

export interface SpreadReadingArea {
  readonly baseLeftPx: number;
  readonly baseRightPx: number;
  /** Includes equal extra space produced by the column measure cap. */
  readonly marginLeftPx: number;
  readonly marginRightPx: number;
  readonly viewerBorderBoxWidth: number;
  readonly maxColumnWidth: number;
  /** Left column origin relative to the BODY content start. */
  readonly contentOriginX: number;
  readonly geometry: SpreadGeometry;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * Returns null when a comfortable pair does not fit. The adapter then uses the
 * existing single-page path without changing the user's spread preference.
 * No DOM/style writes, validation loops, or second spread/page-number model.
 */
export function resolveSpreadReadingArea(input: SpreadAreaInput): SpreadReadingArea | null {
  const p = COMFORTABLE_SPREAD;
  const autoOuter = clamp(input.availableWidth * p.outerRatio, p.outerMinPx, p.outerMaxPx);
  const left = input.leftPx ?? autoOuter;
  const right = input.rightPx ?? autoOuter;
  const gap = input.gapPx ?? clamp(input.availableWidth * p.gapRatio, p.gapMinPx, p.gapMaxPx);
  const viewerInsets = input.viewerInsetLeft + input.viewerInsetRight;
  const columnBudget = (input.availableWidth - left - right - viewerInsets - gap) / 2;
  const minimum = Math.max(p.minColumnPx, p.minColumnEm * input.fontSizePx);
  if (columnBudget < minimum) return null;

  // The cap constrains real CSS columns, not only a subset of paragraphs.
  const maxColumnWidth = p.maxColumnEm * input.fontSizePx;
  const columnWidth = Math.min(columnBudget, maxColumnWidth);
  const contentWidth = 2 * columnWidth + gap;
  const viewerBorderBoxWidth = contentWidth + viewerInsets;
  const extra = (input.availableWidth - left - right - viewerBorderBoxWidth) / 2;
  const marginLeftPx = left + extra;
  const marginRightPx = right + extra;
  return {
    baseLeftPx: left,
    baseRightPx: right,
    marginLeftPx,
    marginRightPx,
    viewerBorderBoxWidth,
    maxColumnWidth,
    contentOriginX: marginLeftPx + input.viewerInsetLeft,
    geometry: createSpreadGeometry(contentWidth, gap, 2, minimum),
  };
}

/** Horizontal root styles only. Existing top/bottom padding stays untouched. */
export function spreadReadingAreaStyles(area: SpreadReadingArea): Readonly<Record<string, string>> {
  return {
    "box-sizing": "border-box",
    width: `${area.viewerBorderBoxWidth}px`,
    "margin-left": `${area.marginLeftPx}px`,
    "margin-right": `${area.marginRightPx}px`,
    "column-count": "2",
    "column-width": "auto",
    "column-gap": `${area.geometry.gap}px`,
    "column-fill": "auto",
  };
}
