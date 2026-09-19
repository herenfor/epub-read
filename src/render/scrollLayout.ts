/**
 * 滚动模式的纯几何/位置计算。
 *
 * 本模块不访问 DOM、不写样式：分页器负责测量并把结果传进来，也负责把
 * 返回值应用到 viewer。分页与滚动共用同一“可用矩形”定义（见总约定），
 * 这里只做滚动特有的纵向换算和横向留白归零。
 */

/** 阅读方式：undefined 由设置边界归一化为 paginated。 */
export type ReadingMode = "paginated" | "scroll";

export interface ScrollMetrics {
  /** viewer 内容高度（scrollHeight） */
  contentHeight: number;
  /** viewer 可见高度（clientHeight） */
  viewportHeight: number;
}

export interface ScrollViewerConfig {
  /** 可用高度（iframe 内容高）；滚动容器必须固定这个高度才有滚动条 */
  viewportHeight?: number;
  /** 左右可用边距之内的额外水平留白 */
  pageMarginPx?: number;
}

export interface ColumnViewInput {
  /** 内容坐标下的物理列号；滚动模式下恒为 0 */
  physicalColumn: number;
  /** 目标离可见区域顶端的距离 */
  desiredInset: number;
  /** 0 = 章首，1 = 章尾（纯图片长图等无文本内容的可选位置） */
  ratio: number;
}

export interface ColumnView {
  textOffset: number | null;
  textSnippet: string | null;
  /** 无可用文字时保留的元素序号，供 legacy 锚点使用 */
  legacyIndex: number;
  /** 滚动模式下未使用，恒为 0 */
  physicalColumn: number;
  desiredInset: number;
  ratio: number;
}

export interface ResolvedScrollTop {
  scrollTop: number;
  /** 已按真实滚动范围夹紧；调用方据此决定是否已到章首/章尾 */
  clamped: boolean;
}

export function scrollMaxTop(metrics: ScrollMetrics): number {
  return Math.max(0, Math.ceil(metrics.contentHeight - metrics.viewportHeight));
}

/** 一次视口命令的滚动距离；章内只滚约 0.9 个可用屏高。 */
export function scrollStepForViewport(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  return Math.round(Math.max(0, viewportHeight) * 0.9);
}

export function scrollTopForTarget({
  viewportTop,
  desiredInset,
  targetTop,
  currentScrollTop,
  maxScrollTop,
}: {
  /** viewer 内容区顶边在当前坐标系中的 y */
  viewportTop: number;
  /** 目标希望停留在可见区域顶端下方多少像素 */
  desiredInset: number;
  /** 目标自身在当前坐标系中的顶边 y（Range/元素 rect.top） */
  targetTop: number;
  currentScrollTop: number;
  maxScrollTop: number;
}): ResolvedScrollTop {
  const safeMax = Math.max(0, Number.isFinite(maxScrollTop) ? maxScrollTop : 0);
  const viewport = Number.isFinite(viewportTop) ? viewportTop : 0;
  const inset = Number.isFinite(desiredInset) ? desiredInset : 0;
  const target = Number.isFinite(targetTop) ? targetTop : viewport;
  const current = Number.isFinite(currentScrollTop) ? currentScrollTop : 0;
  const wanted = current + (target - viewport) - inset;
  const clamped = Math.min(safeMax, Math.max(0, wanted));
  return { scrollTop: clamped, clamped: clamped !== wanted };
}

/**
 * 视口命令（nextPage/prevPage 在滚动下的含义）。
 * `atEnd` 只在真实滚动范围边界成立，不能用虚拟屏号代替。
 */
export function scrollByViewportCommand(
  direction: 1 | -1,
  metrics: ScrollMetrics,
  currentScrollTop: number
): { scrollTop: number; atBoundary: boolean } {
  const max = scrollMaxTop(metrics);
  const step = scrollStepForViewport(metrics.viewportHeight);
  const current = Math.min(max, Math.max(0, Number.isFinite(currentScrollTop) ? currentScrollTop : 0));
  if (step <= 0) return { scrollTop: current, atBoundary: true };
  const wanted = direction === 1 ? current + step : current - step;
  const clamped = Math.min(max, Math.max(0, wanted));
  return { scrollTop: clamped, atBoundary: clamped === current };
}

/** 章内滚动进度：0..1；无纵向滚动范围时按已到章尾处理。 */
export function scrollRatio(metrics: ScrollMetrics, currentScrollTop: number): number {
  const max = scrollMaxTop(metrics);
  if (max <= 0) return 1;
  const current = Math.min(max, Math.max(0, Number.isFinite(currentScrollTop) ? currentScrollTop : 0));
  return current / max;
}

/** UI 展示用“本章 xx%”。 */
export function scrollProgressLabel(metrics: ScrollMetrics, currentScrollTop: number): string {
  return `${Math.round(scrollRatio(metrics, currentScrollTop) * 100)}%`;
}

/**
 * 分页与滚动统一的“Range→目标位置”出口。
 * 纯算法草稿的 scrollTopForTarget 负责原点换算，这里补上章尾边界：
 * 分页末屏只有一列时，屏号对应内容起点，可以停在章尾；滚动不能停在
 * 内容终点（那样会滚出正文），停在最大可滚动位置。
 */
export function scrollTopForRange(input: {
  rangeTop: number;
  viewportTop: number;
  currentScrollTop: number;
  desiredInset: number;
  metrics: ScrollMetrics;
}): ResolvedScrollTop {
  return scrollTopForTarget({
    viewportTop: input.viewportTop,
    desiredInset: input.desiredInset,
    targetTop: input.rangeTop,
    currentScrollTop: input.currentScrollTop,
    maxScrollTop: scrollMaxTop(input.metrics),
  });
}

/** 滚动模式下的物理列恒为第 0 列；列到位置的唯一换算入口。 */
export function scrollViewForColumn(input: ColumnViewInput): ColumnView {
  return {
    textOffset: null,
    textSnippet: null,
    legacyIndex: -1,
    physicalColumn: 0,
    desiredInset: Number.isFinite(input.desiredInset) ? input.desiredInset : 0,
    ratio: Number.isFinite(input.ratio) ? Math.min(1, Math.max(0, input.ratio)) : 0,
  };
}

/**
 * 纵向滚动容器的必要样式。
 *
 * viewer 是唯一正文 scroller：必须有固定可见高度与 overflow-y:auto。
 * 注入 CSS 里 html/body 高度固定且 overflow:hidden，viewer 若不固定高度
 * 会被 L3 的 height:auto 撑成整章高度，导致没有可滚动区间。
 */
export function scrollViewerStyles(viewportHeight: number, pageMarginPx = 0): Array<[string, string]> {
  const margin = Math.max(0, pageMarginPx);
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? `${Math.round(viewportHeight)}px` : "100%";
  // 必须使用 CSS 属性名（kebab-case）：CSSStyleDeclaration.setProperty 不接受
  // JS 驼峰名，传错会静默失败（这正是滚动模式最初卡在分页高度的原因）。
  return [
    ["overflow-y", "auto"],
    ["overflow-x", "hidden"],
    ["scrollbar-width", "none"],
    ["-ms-overflow-style", "none"],
    ["column-width", "auto"],
    ["column-gap", "0px"],
    ["column-fill", "balance"],
    ["height", height],
    ["max-height", height],
    // 不写 width：viewer 占满可用宽，正文版心仍由 L3 的 max-width 居中控制。
    // 一旦写成 0/列宽，正文容器会塌缩到不可见。
    ["padding-left", `${margin}px`],
    ["padding-right", `${margin}px`],
  ];
}
