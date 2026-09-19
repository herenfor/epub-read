/**
 * 页面选项与纯分页几何（AI-B）。
 *
 * 本模块只做纯计算：不测量 DOM、不写 viewer 样式、不持有第二套状态。
 * 边距/列间距的合法性只在 {@link normalizePageOptions} 里校验一次；设置
 * 读取或导入边界调用它，布局函数不再重复校验。
 */

import { TEXT_MEASURE } from "./settings";

export type ReadingMode = "paginated" | "scroll";

export interface PageMarginsPx {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface PageLayoutPreferences {
  /** undefined = 分页模式 */
  readingMode?: ReadingMode;
  /** 未设置的边沿用旧默认 */
  pageMarginsPx?: PageMarginsPx;
  /** undefined = 单栏 */
  columnsPerView?: 1 | 2;
}

export interface PageOptionsValue extends PageLayoutPreferences {
  gapPx: number;
}

export interface PagedGeometry {
  /** 本屏实际列数；requested=2 但宽度不足时回退为 1 */
  columns: 1 | 2;
  /** 单物理列宽；不逐列取整 */
  columnWidth: number;
  /** 相邻物理列的步长（列宽 + 列间距） */
  columnStep: number;
  /** 一次翻页（一屏）的步长；columns * columnStep */
  viewStep: number;
}

/** 有效双栏所需的最小单列宽（CSS px）。 */
export const MIN_COLUMN_WIDTH_PX = 280;
/** 四边距设置上限（CSS px）。 */
export const PAGE_MARGIN_MAX_PX = 160;
/** 列间距设置上限（CSS px）。 */
export const PAGE_GAP_MAX_PX = 96;
/** 列间距默认值，与 ReaderSettings.gapPx 现有默认一致。 */
export const DEFAULT_PAGE_GAP_PX = 24;
/** 边距与列间距的调节步进（CSS px）。 */
export const PAGE_MARGIN_STEP_PX = 2;
export const PAGE_GAP_STEP_PX = 2;

const MARGIN_SIDES: ReadonlyArray<keyof PageMarginsPx> = ["top", "bottom", "left", "right"];

function finiteInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/**
 * 设置读取/导入边界的唯一一次规范化。
 *
 * 非法边距回到“未设置”，非法列间距回到 {@link DEFAULT_PAGE_GAP_PX}，非法的
 * 模式/栏数回到 undefined；合法的 0 保留。未设置的可选字段不会以 undefined
 * 形式写回对象，便于直接持久化。
 */
export function normalizePageOptions(input: unknown): PageOptionsValue {
  const source = input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};

  const result: PageOptionsValue = { gapPx: DEFAULT_PAGE_GAP_PX };
  const gapPx = finiteInRange(source.gapPx, 0, PAGE_GAP_MAX_PX);
  if (gapPx !== undefined) result.gapPx = gapPx;

  if (source.readingMode === "paginated" || source.readingMode === "scroll") {
    result.readingMode = source.readingMode;
  }
  if (source.columnsPerView === 1 || source.columnsPerView === 2) {
    result.columnsPerView = source.columnsPerView;
  }

  const rawMargins = source.pageMarginsPx && typeof source.pageMarginsPx === "object"
    ? (source.pageMarginsPx as Record<string, unknown>)
    : null;
  if (rawMargins) {
    const margins: PageMarginsPx = {};
    for (const side of MARGIN_SIDES) {
      const value = finiteInRange(rawMargins[side], 0, PAGE_MARGIN_MAX_PX);
      if (value !== undefined) margins[side] = value;
    }
    if (Object.keys(margins).length > 0) result.pageMarginsPx = margins;
  }
  return result;
}

/** 面板显示“自动”时使用的上下留白（旧口径），四舍五入到整数 CSS px。 */
export function autoPageMarginsPx(fontSizePx: number): { top: number; bottom: number } {
  return {
    top: Math.round(TEXT_MEASURE.vTopEm * fontSizePx),
    bottom: Math.round(TEXT_MEASURE.vBottomEm * fontSizePx),
  };
}

/**
 * 由扣除读者左右留白与作者根 padding 后的可用宽度计算分页几何。
 *
 * `requestedColumns=2` 只有在 `(availableWidth-gapPx)/2` 不小于
 * {@link MIN_COLUMN_WIDTH_PX} 时生效，否则回到单栏；单栏的翻页步长与旧的
 * `availableWidth + gapPx` 一致。所有尺寸保持浮点，避免逐列取整的累计偏移。
 */
export function computePagedGeometry(
  availableWidth: number,
  gapPx: number,
  requestedColumns: 1 | 2,
): PagedGeometry {
  const columns: 1 | 2 = requestedColumns === 2
    && (availableWidth - gapPx) / 2 >= MIN_COLUMN_WIDTH_PX
    ? 2
    : 1;
  const columnWidth = (availableWidth - (columns - 1) * gapPx) / columns;
  const columnStep = columnWidth + gapPx;
  return { columns, columnWidth, columnStep, viewStep: columns * columnStep };
}
