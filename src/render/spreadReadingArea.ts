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

export interface SpreadPageFold {
  /** Viewer padding: each page's own outer side, which slides with the page. */
  readonly paddingLeftPx: number;
  readonly paddingRightPx: number;
  /** Full viewer border-box width (the whole screen of the reading frame). */
  readonly viewerBorderBoxWidth: number;
  /** Gutter = paddingLeft + paddingRight, so one spread step equals the width. */
  readonly geometry: SpreadGeometry;
}

/**
 * Fold a comfortable spread's side space into its two pages so a turn slides
 * the whole spread across the screen instead of inside a centred window.
 *
 * Every page is laid out as [left | column | right]; with CSS multi-column the
 * gutter is therefore left + right and one spread advances exactly
 * `fullWidth`. The column keeps the comfort measure cap: when the screen is
 * wider than two capped columns plus the base margins, the surplus widens
 * each page's margins proportionally (the gutter grows with them) rather than
 * lengthening lines. Returns null when two columns no longer fit.
 */
export function foldSpreadIntoPages(
  area: SpreadReadingArea,
  input: {
    /** Reading frame width including any folded author body padding. */
    readonly fullWidth: number;
    readonly fontSizePx: number;
    /** Author body side padding moved into each page (0 when none). */
    readonly authorInsetLeft?: number;
    readonly authorInsetRight?: number;
  },
): SpreadPageFold | null {
  const p = COMFORTABLE_SPREAD;
  const half = input.fullWidth / 2;
  let left = area.baseLeftPx + (input.authorInsetLeft ?? 0);
  let right = area.baseRightPx + (input.authorInsetRight ?? 0);
  const minimum = Math.max(p.minColumnPx, p.minColumnEm * input.fontSizePx);
  let column = half - left - right;
  if (!(column >= minimum)) return null;
  if (column > area.maxColumnWidth && left + right > 0) {
    const scale = (half - area.maxColumnWidth) / (left + right);
    left *= scale;
    right *= scale;
    column = area.maxColumnWidth;
  } else if (column > area.maxColumnWidth) {
    left = right = (half - area.maxColumnWidth) / 2;
    column = area.maxColumnWidth;
  }
  const gap = left + right;
  const geometry = createSpreadGeometry(input.fullWidth - left - right, gap, 2, minimum);
  if (geometry.columns !== 2) return null;
  return {
    paddingLeftPx: left,
    paddingRightPx: right,
    viewerBorderBoxWidth: input.fullWidth,
    geometry,
  };
}
