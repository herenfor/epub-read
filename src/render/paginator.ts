import { applyReaderBodyPercentageSpacing, applyReaderRootPercentageSpacing } from "./percentageSpacing";
import { sanitizeChapter, VIEWER_ID } from "./sanitize";
import { resolvePath, isExternalUrl, isFragmentOnly, splitHref } from "../core/paths";
import { getFootnoteHoverAnchor, isFootnoteLink, resolveFootnote, type FootnoteInfo } from "./footnotes";
import type { ResourceServer } from "./resources";
import { OwnedBlobUrls } from "./blobOwnership";
import { TEXT_MEASURE, type ReaderSettings } from "./settings";
import { VisibilityGate } from "./displayGate";
import { hasAuthoredCssProperty } from "./cssRewrite";
import { clearDocumentSelection, isSelectAllShortcut } from "./selectionGuard";
import { applySearchHighlight, clearSearchHighlight } from "./searchHighlight";
import { applyBackdropCompatibility } from "./backdropCompatibility";
import type { ExactTextHit, RawTextRange } from "../core/exactTextHits";
import { resolveExactTextHits } from "../core/exactTextHits";
import { resolveSearchOccurrence, type SearchOccurrence } from "../core/searchOccurrence";
import {
  adaptNavigationAnchor,
  type PersistedNavigationAnchor,
} from "./navigationAnchor";
import { applyDarkThemeContrast } from "./darkThemeContrast";
import { FootnoteHoverGate } from "./footnoteHoverGate";
import { waitForDoubleRaf, waitForFontsReady } from "./asyncWait";
import {
  buildVisibleTextIndex,
  captureTextSelection,
  resolveTextAnchorOffset,
  resolveTextRangeOffsets,
  type TextAnchorData,
  type TextRangeAnchorData,
  type TextSelectionPayload,
  type VisibleTextIndex,
} from "./textAnchor";
import {
  continuousWheelPixels,
  nextWheelTarget,
  scrollByViewportCommand,
  scrollMaxTop,
  scrollRatio,
  scrollTopForRange,
  scrollViewerStyles,
  type ReadingMode,
  type ScrollMetrics,
} from "./scrollLayout";
import { autoPageMarginsPx, COMPACT_PAGE_WIDTH_PX, MIN_COLUMN_WIDTH_PX } from "./pageLayout";
import { installPagedSwipe, type PagedSwipeHandlers } from "./pagedSwipe";
import { installPlainTap } from "./plainTap";
import {
  clientXToColumnX,
  columnForContentPoint,
  commitSpreadPosition,
  createSpreadGeometry,
  createSpreadLayout,
  occupiedColumns,
  type PagedViewportPort,
  type SpreadGeometry,
  type SpreadLayout,
  spreadForColumn,
  spreadStart,
  visibleLeafRange,
} from "./pagedSpread";
import { imageRequestFromTarget } from "./imageActivation";
import { columnAtPoint, containingFragmentAtPoint, type FragmentSpace } from "./fragmentGeometry";
import {
  foldSpreadIntoPages,
  resolveSpreadReadingArea,
  type SpreadReadingArea,
} from "./spreadReadingArea";

/** 常规布局应远早于此完成；极端字体/引擎停滞时只解除隐藏，不伪造 ready。 */
const INITIAL_RENDER_GATE_TIMEOUT_MS = 20_000;

/** 舒适双页写入 viewer 的 reader-owned 根内联属性；restore 只碰这些。 */
/** 无滚动抬手后等待续上的吸附/甩动动画的时长；期间出现滚动则改等 scrollend。 */
const NATIVE_SNAP_SETTLE_MS = 160;

const SPREAD_AREA_ROOT_STYLE_PROPERTIES = [
  "box-sizing",
  "width",
  "margin-left",
  "margin-right",
  "padding-left",
  "padding-right",
  "column-count",
  "column-width",
  "column-gap",
  "column-fill",
] as const;

export interface SpreadAreaSnapshot {
  readonly baseLeftPx: number;
  readonly baseRightPx: number;
  readonly marginLeftPx: number;
  readonly marginRightPx: number;
  readonly gapPx: number;
}

export type ChapterState =
  | { status: "loading" }
  | { status: "measuring" }
  | {
      status: "ready";
      pageCount: number;
      currentPage: number;
      empty: boolean;
      /** 当前布局的阅读方式；旧调用方不读该字段。 */
      mode?: ReadingMode;
      /** 滚动模式：本章 0..1 位置。 */
      scrollProgress?: number;
      /** 连续滚动模式：整本书 0..1 宏观位置。 */
      totalScrollProgress?: number;
      /** 窄窗回落后的有效列数。 */
      effectiveColumns?: 1 | 2;
      /** 是否已确认达到全书内容终点 */
      atEnd?: boolean;
      /** 叶页（物理列）编号区间，如 { first: 3, last: 4, total: 5 } */
      leafRange?: { first: number; last: number; total: number } | null;
      /** 实际舒适双页阅读区；非双页/回退时不提供，UI 不自行猜屏宽。 */
      spreadArea?: SpreadAreaSnapshot;
      /**
       * 原生滑动途中的页码预览：只供页码/进度条显示，阅读锚点尚未更新，
       * 宿主不得据此保存进度；滑动停下后会再发一次正式状态。
       */
      transient?: true;
    }
  | { status: "error"; message: string };

export interface ChapterMeasurementToken {
  disposed: boolean;
  loadSeq: number;
  expectedLoadSeq: number;
  contentDoc: Document | null;
  expectedDoc: Document;
  viewer: HTMLElement | null;
  expectedViewer: HTMLElement;
}

/** 异步字体/rAF边界后的统一过期检查，阻止旧文档进入后续布局补偿。 */
export function isChapterMeasurementCurrent(token: ChapterMeasurementToken): boolean {
  return (
    !token.disposed &&
    token.loadSeq === token.expectedLoadSeq &&
    token.contentDoc === token.expectedDoc &&
    token.viewer === token.expectedViewer
  );
}

/** True only for an authored inline width declaration (comments are inert). */
export function hasAuthoredInlineWidth(styleText: string): boolean {
  return hasAuthoredCssProperty(styleText, "width");
}

/** 脚注弹层数据（由分页器发往 UI 层）。 */
export interface FootnotePayload {  text: string;
  /** 图片注释/富文本注释的 HTML；无则为 undefined */
  html?: string;
  /** 标记在 iframe 内视口的矩形 */
  rect: { left: number; top: number; right: number; bottom: number };
  /** 点击标记固定（不再随鼠标移出关闭） */
  pinned: boolean;
}

export interface ReaderNoteForPaginator extends TextRangeAnchorData {
  id: string;
  selectedText?: string;
}

export interface SelectionContextPayload extends TextSelectionPayload {
  chapterPath: string;
}

/**
 * 正文图片激活请求；由现有 click 路由交给活动章节的 UI。
 */
export interface ImageActivationPayload {
  src: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
  chapterPath: string;
  linkHref?: string;
}

export interface LoadOptions {
  /** Apply current settings atomically when navigation supersedes a queued settings reload. */
  settings?: ReaderSettings;
  /** 是否有下一章（滚动模式章末卡片展示“进入下一章”或“全书完”） */
  hasNextChapter?: boolean;
  /** 是否有上一章（滚动模式章首向上越界判断） */
  hasPrevChapter?: boolean;
  /** 跳转到页内锚点（目录跳转用） */
  anchor?: string;
  /**
   * 显式章节跳转：同章重新加载也从开头开始（清空旧页号与旧阅读锚点）。
   * 目录里点击“当前章节”时使用；设置重载/窗口重排不传，继续保留位置。
   */
  resetPage?: boolean;
  /**
   * 进入章节后停在最后一页（向前回翻上一章时使用）。
   * paginator 会在新内容布局完成、翻到最后一页之后才显示内容，
   * 避免先渲染第一页再跳到最后页的闪页。
   */
  startAtEnd?: boolean;
  /** Persisted content position. It is applied before layout, never by DOM offset. */
  readingAnchor?: PersistedNavigationAnchor | ReadingAnchor | null;
  /** Saved page for records that have no valid content anchor. */
  fallbackPage?: number | null;
  /** Exact search/note target for cross-chapter jumps; resolved before reveal. */
  preciseNavigation?: PreciseNavigationRequest | null;
  /**
   * Internal settings-reload carry-over.  It preserves the already committed
   * search hit identity across a same-chapter document rebuild without
   * treating it as a new navigation.
   */
  preserveSearchHighlight?: SearchHighlightTarget | null;
}

/** Synchronous navigation that reuses the currently completed chapter layout. */
export interface WithinChapterNavigationOptions {
  /** Encoded fragment without the leading `#`; empty string clears :target. */
  fragment?: string;
  /** Persisted content anchor to restore in the current chapter. */
  readingAnchor?: {
    index: number;
    ratio: number;
    anchorTextOffset: number | null;
    anchorTextSnippet: string | null;
  } | null;
  /** 纯图片页的媒体身份锚点；连续宿主优先用文本，无文本时使用它。 */
  mediaAnchor?: MediaReadingAnchor | null;
  /** Page fallback used only when content/legacy anchors cannot be resolved. */
  fallbackPage?: number | null;
  /** Navigate to the natural first column and clear the old fragment. */
  toStart?: boolean;
  /** 连续模式对齐方式：reading-line 对齐到 20% 阅读线（书签恢复专用），context 对齐到顶部微小 inset（默认） */
  alignment?: "reading-line" | "context";
}

export interface ReadingAnchor extends TextAnchorData {
  index: number;
  ratio: number;
  charsRead: number;
  totalChars: number;
  mediaUnits?: number;
  /** B-155：观察到的纯图片媒体身份；文本锚点仍以 textOffset 为准。 */
  mediaAnchor?: MediaReadingAnchor | null;
}

export interface ExternalScrollAdapter {
  onWheelPixels(delta: number): void;
  onViewportStep(direction: 1 | -1): void;
}

export interface ReadingAnchorAndContentY {
  anchor: ReadingAnchor;
  contentY: number;
}

/**
 * 纯图片页的图内锚点（R3）。没有可解析文字时，只保存章内像素位置在窗口
 * 宽度变化后会落到图案之外；保存媒体身份与图内纵向比例才能重建同一图案。
 */
export interface MediaReadingAnchor {
  /** 媒体元素在本文档媒体列表中的顺序身份；同章重排/换设置后保持不变。 */
  index: number;
  tag: string;
  /** 源签名（id/class/viewBox/src 尾部）；顺序身份失效时用于回退匹配。 */
  signature: string;
  /** (锚点内容 y - 媒体顶) / 媒体高，图内纵向比例。 */
  ratio: number;
}

export interface MediaAnchorAndContentY {
  anchor: MediaReadingAnchor;
  contentY: number;
}

export interface ResolvedContentFraction {
  contentY: number;
  anchor: PersistedNavigationAnchor;
  mediaAnchor?: MediaReadingAnchor | null;
  fraction: number;
}

export interface PreciseNavigationRequest {
  requestId: number;
  kind: "search" | "note";
  /** Exact body ranges; omitted for note anchors that use persisted text only. */
  textHits?: ExactTextHit[];
  /** New-search identity context; absent for notes and legacy search requests. */
  occurrence?: SearchOccurrence;
}

export interface SearchHighlightTarget {
  requestId: number;
  textHits: ExactTextHit[];
  /** New-search identity context; absent for notes and legacy search requests. */
  occurrence?: SearchOccurrence;
}

function cloneSearchOccurrence(occurrence: SearchOccurrence | undefined): SearchOccurrence | undefined {
  return occurrence
    ? {
        before: occurrence.before,
        after: occurrence.after,
        hits: occurrence.hits.map((hit) => ({ ...hit })),
      }
    : undefined;
}

interface PendingPreciseNavigation {
  request: PreciseNavigationRequest;
  /** Immutable copy of the original request anchor; never a page-center sample. */
  anchor: ReadingAnchor | null;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** 采样点：x/y 均为 viewer 内容框内的像素（不含 viewer 的 border/padding）。 */
interface VisibleSamplePoint {
  x: number;
  y: number;
}

interface AnchorSampleOptions {
  viewer: HTMLElement;
  doc: Document;
  index: VisibleTextIndex;
  /** paginated 用可见列中心；scroll 用可用屏高比例 */
  mode: ReadingMode;
  /** scroll：可见区域高度比例；paginated：可见列宽度比例 */
  visibleRatio: number;
  /** paginated 分栏换算；scroll 忽略 */
  geometry?: { columnWidth: number; columnStep: number; viewStep: number; leadingColumns: number };
}

/** scroll：可见屏内固定高度；paginated：第一可见列（不是含 gap 的整屏中心）。 */
function visibleSamplePoints(options: AnchorSampleOptions): VisibleSamplePoint[] {
  const { viewer, mode, visibleRatio } = options;
  const height = viewer.clientHeight;
  const ys = mode === "scroll"
    ? [Math.round(height * visibleRatio)]
    : [Math.round(height * 0.5), Math.round(height * 0.5) - 40, Math.round(height * 0.5) + 40, Math.round(height * 0.5) - 80, Math.round(height * 0.5) + 80];
  const clampedYs = ys
    .map((y) => Math.max(2, Math.min(height - 2, y)))
    .filter((y, i, all) => y >= 2 && y <= height - 2 && all.indexOf(y) === i);
  if (mode === "scroll") {
    const x = Math.max(2, Math.round(viewer.clientWidth * 0.5));
    return clampedYs.map((y) => ({ x, y }));
  }
  const geometry = options.geometry;
  if (!geometry) return [];
  const columnWidth = Math.max(1, Math.min(geometry.columnWidth, viewer.clientWidth));
  const colInset = Math.max(2, Math.min(columnWidth * visibleRatio, columnWidth - 2));
  // caretPositionFromPoint / elementFromPoint 用 iframe 视口坐标：横向滚动已经
  // 被命中测试消化，不能再自己加 scrollLeft，否则点落在视口外、锚点永远采不到
  // （首屏 scrollLeft=0 时看起来正常，一翻页就静默失效）。
  // 版心左原点 = viewer 的 border + padding；第一可见列就在这里。
  const left = viewer.getBoundingClientRect().left + (viewer.clientLeft || 0) + viewerPaddingLeft(viewer);
  const x = left + colInset;
  return clampedYs.map((y) => ({ x, y }));
}

/** viewer 内容左原点所需的 padding-left（取不到时为 0）。 */
function viewerPaddingLeft(viewer: HTMLElement): number {
  try {
    const computed = viewer.ownerDocument.defaultView?.getComputedStyle(viewer);
    return parseFloat(computed?.paddingLeft ?? "") || 0;
  } catch {
    return 0;
  }
}

function visibleElementAt(
  doc: Document,
  viewer: HTMLElement,
  point: VisibleSamplePoint
): Element | null {
  const caretDoc = doc as CaretDocument;
  const fromCaret = caretDoc.caretPositionFromPoint?.(point.x, point.y)?.offsetNode ?? null;
  if (fromCaret && fromCaret.nodeType === 3) return (fromCaret as Text).parentElement;
  const fromRange = caretDoc.caretRangeFromPoint?.(point.x, point.y)?.startContainer ?? null;
  if (fromRange && fromRange.nodeType === 3) return (fromRange as Text).parentElement;
  const hit = doc.elementFromPoint(point.x, point.y);
  if (hit && hit !== viewer && hit !== doc.body && hit !== doc.documentElement) return hit;
  return null;
}

/** 在给定采样点上建立文本/legacy 锚点；返回是否真的采到了内容。 */
function captureAnchorAtPoint(
  options: AnchorSampleOptions,
  point: VisibleSamplePoint
): ReadingAnchor | null {
  const { viewer, doc, index } = options;
  const caretDoc = doc as CaretDocument;
  let textNode: Text | null = null;
  let rawOffset = 0;
  const modern = caretDoc.caretPositionFromPoint?.(point.x, point.y);
  if (modern && modern.offsetNode.nodeType === 3) {
    textNode = modern.offsetNode as Text;
    rawOffset = modern.offset;
  } else {
    const range = caretDoc.caretRangeFromPoint?.(point.x, point.y);
    if (range && range.startContainer.nodeType === 3) {
      textNode = range.startContainer as Text;
      rawOffset = range.startOffset;
    }
  }
  const textOffset = textNode ? index.offsetForNode(textNode, rawOffset) : null;
  const el = textNode?.parentElement ?? visibleElementAt(doc, viewer, point);
  const idx = el ? index.elementIndex(el, viewer) : -1;
  const rect = el ? (el as HTMLElement).getBoundingClientRect() : null;
  if (textOffset === null && idx < 0) return null;
  const ratio = rect && rect.width > 0
    ? Math.min(1, Math.max(0, (point.x - rect.left) / rect.width))
    : 0;
  return {
    index: idx,
    ratio,
    charsRead: textOffset ?? 0,
    totalChars: index.totalChars,
    mediaUnits: index.mediaUnits,
    textOffset,
    textSnippet: textOffset === null ? null : index.snippetAt(textOffset),
  };
}

/** 依次尝试采样点；caret API 缺失时回退到可见元素，避免整章进度归零。 */
function captureVisibleAnchor(options: AnchorSampleOptions): ReadingAnchor | null {
  for (const point of visibleSamplePoints(options)) {
    const anchor = captureAnchorAtPoint(options, point);
    if (anchor) return anchor;
  }
  const geometry = options.geometry;
  const fallbackPoint = options.mode === "scroll"
    ? visibleSamplePoints(options)[0]
    : geometry
      ? {
          // 同 visibleSamplePoints：这里也必须是视口坐标。
          x:
            options.viewer.getBoundingClientRect().left +
            (options.viewer.clientLeft || 0) +
            viewerPaddingLeft(options.viewer) +
            2,
          y: Math.max(2, Math.round(options.viewer.clientHeight * 0.5)),
        }
      : undefined;
  return fallbackPoint ? captureAnchorAtPoint(options, fallbackPoint) : null;
}

export type PreciseNavigationStatus =
  | "located"
  | "located-reference"
  | "unresolved"
  | "unsupported-highlight"
  | "cancelled";

/** Pure restore precedence shared by initial layout and tests. */
export function resolveRestoredPage({
  pageCount,
  anchorCol,
  fallbackPage,
  currentPage,
}: {
  pageCount: number;
  anchorCol: number | null;
  fallbackPage: number | null;
  currentPage: number;
}): { page: number; consumeFallback: boolean } {
  const last = Math.max(0, pageCount - 1);
  if (anchorCol !== null) {
    // A saved fallback belongs only to this load. Consume it even when the
    // higher-priority text/legacy anchor wins, so later image reflow cannot
    // jump back to the old page.
    return { page: Math.min(Math.max(0, anchorCol), last), consumeFallback: fallbackPage !== null };
  }
  if (fallbackPage !== null) {
    return { page: Math.min(Math.max(0, fallbackPage), last), consumeFallback: true };
  }
  return { page: Math.min(Math.max(0, currentPage), last), consumeFallback: false };
}

type ResolvedAnchorColumn = { col: number; source: "text" | "legacy" };

/** 屏号换算：列号减前置空列后除以有效列数（总约定 2）。 */
export function columnToView(
  physicalColumn: number,
  leadingColumns: number,
  columns: 1 | 2
): number {
  return Math.floor((physicalColumn - leadingColumns) / columns);
}

/**
 * 单章分页控制器：把一章 XHTML 渲染进 iframe，用 CSS 多栏布局分页。
 *
 * 核心机制（同源 blob iframe，父窗口可直接操作内容 DOM）：
 * 1. sanitizeChapter 产出注入过阅读器样式/CSP 的 HTML，blob URL 赋给 iframe.src
 * 2. iframe load 后（子资源已就绪），等待 document.fonts.ready
 * 3. 容器全宽，列宽 = 页宽；正文版心由注入 CSS 的 em 上限居中控制
 * 4. 页数 = 内容占据的列数；翻页 = 调 scrollLeft
 * 5. 阅读位置用文本内容锚点保留：成功排版后以 code-point offset/snippet
 *    通过 Range 选择新列；页面中心仅作只读 caret 采样，legacy 元素/页码兜底。
 */
/** 页内 fragment 的原始 hash 与用于 getElementById 的解码锚点。 */
export interface FragmentNavigation {
  hash: string;
  anchor: string;
}

/**
 * 纯 fragment 链接才由当前章节处理。保留原始编码 hash 给 location，
 * 同时把可解码值用于 DOM id 查找；畸形百分号编码则沿用原始值，避免点击报错。
 */
export function getFragmentNavigation(href: string): FragmentNavigation | null {
  if (!isFragmentOnly(href)) return null;
  const encodedAnchor = href.slice(1);
  if (!encodedAnchor) return null;
  let anchor = encodedAnchor;
  try {
    anchor = decodeURIComponent(encodedAnchor);
  } catch {
    // 使用原值：某些不规范 EPUB 可能真的以 `%` 作为 id 的一部分。
  }
  return { hash: `#${encodedAnchor}`, anchor };
}

/**
 * `history.replaceState` 不会激活 :target；只有 location.hash 导航会。
 * blob iframe 理应同源，但在章节卸载或权限变化时访问 location 仍可能抛异常，
 * 因此同步失败不能阻断分页器的显式列定位。
 */
export function syncFragmentHash(win: Window | null | undefined, hash: string): void {
  if (hash !== "" && (hash.length < 2 || !hash.startsWith("#"))) return;
  try {
    const iframeLocation = win?.location;
    if (iframeLocation && iframeLocation.hash !== hash) iframeLocation.hash = hash;
  } catch {
    // iframe 已卸载/不可访问时仍继续 jumpToAnchor；不让链接点击抛到 UI。
  }
}

type BoxWidthStyle = Pick<
  CSSStyleDeclaration,
  | "width"
  | "boxSizing"
  | "paddingLeft"
  | "paddingRight"
  | "borderLeftWidth"
  | "borderRightWidth"
>;

/** computed width 转为与水平 margin 布局一致的 border-box 宽度。 */
export function getBorderBoxWidth(style: BoxWidthStyle): number {
  const width = parseFloat(style.width);
  if (!Number.isFinite(width)) return 0;
  if (style.boxSizing === "border-box") return width;
  return (
    width +
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0) +
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0)
  );
}

type MarginStyle = Pick<CSSStyleDeclaration, "margin" | "marginLeft" | "marginRight">;

/** 作者 inline style 是否明确使用了水平百分比 margin。 */
export function hasPercentageHorizontalMargin(style: MarginStyle): boolean {
  if (style?.marginLeft?.includes("%") || style?.marginRight?.includes("%")) return true;
  const margin = typeof style?.margin === "string" ? style.margin.trim() : "";
  if (!margin) return false;
  const values = margin.split(/\s+/).filter(Boolean);
  if (values.length === 0) return false;
  const horizontal =
    values.length === 1
      ? [values[0]]
      : values.length === 2 || values.length === 3
        ? [values[1]]
        : [values[1], values[3]];
  return horizontal.some((value) => value.includes("%"));
}

function styleHasPercentageHorizontalMargin(style: CSSStyleDeclaration): boolean {
  if (style?.marginLeft?.includes("%") || style?.marginRight?.includes("%")) return true;
  const margin = typeof style?.margin === "string" ? style.margin.trim() : "";
  if (!margin) return false;
  const values = margin.split(/\s+/).filter(Boolean);
  if (values.length === 0) return false;
  const horizontal =
    values.length === 1
      ? [values[0]]
      : values.length === 2 || values.length === 3
        ? [values[1]]
        : [values[1], values[3]];
  return horizontal.some((value) => value.includes("%"));
}

const HORIZONTAL_MARGIN_PROPERTIES = [
  "margin",
  "margin-left",
  "margin-right",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
] as const;

/**
 * 当前元素是否在注释外的 inline style 中明确声明了任一水平 margin。
 * `margin` 简写即使只写为 0 也算作者意图：这里判断的是来源而非数值。
 */
function hasAuthoredInlineHorizontalMargin(el: HTMLElement): boolean {
  const styleText = el.getAttribute("style") ?? "";
  return HORIZONTAL_MARGIN_PROPERTIES.some((property) =>
    hasAuthoredCssProperty(styleText, property)
  );
}

type AuthoredHorizontalMarginResult = boolean | undefined;

function ruleHasHorizontalMargin(style: CSSStyleDeclaration): boolean {
  return HORIZONTAL_MARGIN_PROPERTIES.some(
    (property) => style.getPropertyValue(property).trim() !== ""
  );
}

/**
 * 判断当前元素有没有作者/用户明确声明的水平 margin。
 *
 * 调用时 L3 `.reader-top` 的 auto margin 已临时移除，因此同一
 * `data-reader=overrides` 样式表末尾的 customCss 仍可作为用户意图读取，
 * 而内建 auto margin 不会造成假阳性。无法读取的 stylesheet、未知条件或
 * 未来 grouping rule 不能安全否定，返回 undefined 维持 C-04 的旧保守行为。
 */
export function hasAuthoredHorizontalMargin(
  doc: Document,
  el: HTMLElement
): AuthoredHorizontalMarginResult {
  if (hasAuthoredInlineHorizontalMargin(el)) return true;

  let unknownSource = false;
  const walk = (rules: CSSRuleList): boolean => {
    for (const rule of Array.from(rules)) {
      const active = getActiveCssCondition(rule, doc.defaultView);
      if (active === false) continue;
      if (active === undefined) {
        unknownSource = true;
        continue;
      }

      if (rule.type === 1) {
        const styleRule = rule as CSSStyleRule;
        const selector = styleRule.selectorText ?? "";
        if (selector && ruleHasHorizontalMargin(styleRule.style)) {
          try {
            if (el.matches(selector)) return true;
          } catch {
            // Invalid/unavailable selector matching cannot prove that the
            // computed nonzero margin comes from UA CSS.
            unknownSource = true;
          }
        }
      }

      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules && walk(nested.cssRules)) return true;
      } catch {
        unknownSource = true;
      }
    }
    return false;
  };

  for (const sheet of Array.from(doc.styleSheets ?? [])) {
    try {
      if (walk(sheet.cssRules)) return true;
    } catch {
      unknownSource = true;
    }
  }
  return unknownSource ? undefined : false;
}

const HORIZONTAL_SIZING_PROPERTIES = ["width", "min-width", "max-width"] as const;
type AuthoredSizingIntentResult = boolean | undefined;

function ruleHasHorizontalSizing(style: CSSStyleDeclaration): boolean {
  return HORIZONTAL_SIZING_PROPERTIES.some(
    (property) => style.getPropertyValue(property).trim() !== ""
  );
}

/**
 * 判断直接子元素是否存在作者/用户的 width/min-width/max-width sizing intent。
 *
 * reader overrides 中唯一已知的默认 sizing 是 L3 的 `max-width:40rem`；它
 * 不应阻止 C-40。其余 reader stylesheet 命中规则无法和 customCss 在旧引擎
 * 中可靠区分，因此返回 undefined，宁可保守保留 C-04，也不吞掉用户 sizing。
 */
export function hasAuthoredSizingIntent(
  doc: Document,
  el: HTMLElement
): AuthoredSizingIntentResult {
  const inlineStyle = el.getAttribute("style") ?? "";
  if (HORIZONTAL_SIZING_PROPERTIES.some((property) => hasAuthoredCssProperty(inlineStyle, property))) {
    return true;
  }
  if (el.hasAttribute("width")) return true;

  let unknownSource = false;
  const walk = (rules: CSSRuleList, readerSheet: boolean): boolean => {
    for (const rule of Array.from(rules)) {
      const active = getActiveCssCondition(rule, doc.defaultView);
      if (active === false) continue;
      if (active === undefined) {
        // Keyframes declarations are not selector-applied sizing sources;
        // their cssRules must not make an otherwise complete static cascade
        // probe unknown (a separate animation layout issue is out of scope).
        if (rule.type === 7) continue;
        unknownSource = true;
        continue;
      }

      if (rule.type === 1) {
        const styleRule = rule as CSSStyleRule;
        const selector = styleRule.selectorText ?? "";
        if (selector && ruleHasHorizontalSizing(styleRule.style)) {
          let matches = false;
          try {
            matches = el.matches(selector);
          } catch {
            unknownSource = true;
          }
          if (matches) {
            if (
              readerSheet &&
              selector.includes("#epub-viewer") &&
              selector.includes(".reader-top") &&
              styleRule.style.getPropertyValue("width").trim() === "" &&
              styleRule.style.getPropertyValue("min-width").trim() === "" &&
              styleRule.style.getPropertyValue("max-width").trim() === `${TEXT_MEASURE.maxEm}rem`
            ) {
              // Known L3 reader default; it is not author sizing intent.
            } else {
              // customCss is appended to the same reader stylesheet in the
              // current sanitizer. Without declaration provenance, a match
              // there is unknown rather than proof of author sizing.
              if (readerSheet) {
                unknownSource = true;
              } else {
                return true;
              }
            }
          }
        }
      }

      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules && walk(nested.cssRules, readerSheet)) return true;
      } catch {
        unknownSource = true;
      }
    }
    return false;
  };

  for (const sheet of Array.from(doc.styleSheets ?? [])) {
    const owner = sheet.ownerNode as Element | null;
    const readerSheet = owner?.hasAttribute?.("data-reader") || owner?.getAttribute?.("data-reader") != null;
    try {
      if (walk(sheet.cssRules, readerSheet)) return true;
    } catch {
      unknownSource = true;
    }
  }
  return unknownSource ? undefined : false;
}

/** Only a known UA-only margin may bypass C-04; unknown sources preserve legacy behavior. */
export function shouldApplyBookMarginCompensation(
  authoredHorizontalMargin: AuthoredHorizontalMarginResult
): boolean {
  return authoredHorizontalMargin !== false;
}

/**
 * Mirrors the C-04 candidate gate: resolved zero/auto margins cannot trigger
 * compensation, while an unparsed expression remains conservative/meaningful.
 */
export function isMeaningfulHorizontalMargin(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "auto" && parseFloat(normalized) !== 0;
}

/** C-16 percentage margins never reach C-37/C-04, so they need no CSSOM source probe. */
export function shouldProbeAuthoredHorizontalMargin(
  percentageMargin: boolean | undefined,
  left: string,
  right: string
): boolean {
  return (
    percentageMargin !== true &&
    (isMeaningfulHorizontalMargin(left) || isMeaningfulHorizontalMargin(right))
  );
}

type TypedStyleMapHost = {
  computedStyleMap?: () => {
    get(property: string): { toString(): string } | undefined;
  };
};

/**
 * CSS Typed OM 保留最终获胜 margin 的百分比/calc 表达式；传统
 * getComputedStyle() 则已将它解析为 px。调用方必须先解除阅读器的
 * reader-top auto margin，避免读到 L3 默认值而不是作者最终级联。
 * 返回 undefined 表示当前引擎不支持或读取失败，供兼容回退使用。
 */
export function hasComputedPercentageHorizontalMargin(el: Element): boolean | undefined {
  try {
    const styleMap = (el as Element & TypedStyleMapHost).computedStyleMap?.();
    if (!styleMap) return undefined;
    return ["margin-left", "margin-right"].some((property) =>
      styleMap.get(property)?.toString().includes("%")
    );
  } catch {
    return undefined;
  }
}

export type BoxSizing = "content-box" | "border-box";

/** 只解析解除 reader auto margin 后的 Typed OM 最终值，不从几何猜 auto。 */
export function resolvedMarginKind(value: string | undefined): "auto" | "length" | "unknown" {
  if (value === "auto") return "auto";
  return value !== undefined && /^-?(?:\d+(?:\.\d*)?|\.\d+)px$/u.test(value)
    ? "length"
    : "unknown";
}

/**
 * 普通 auto-width 块的 margin / border / padding 均计入版心预算。
 * 调用者已确认非 float/intrinsic/fullpage/固定版式，无作者 sizing，非负长度边距。
 * 窄屏标题在旧 isAutoLikeHorizontalMargin 判定之前调用；宽屏标题原路径保留。
 * 有 padding/border 的无作者 sizing 顶层块用 marginLeft/Right=0 修正 L3 默认限宽。
 */
export function planAutoBlockBox(input: {
  containerWidth: number;
  measureWidth: number;
  marginLeft: number;
  marginRight: number;
  boxSizing: BoxSizing;
  paddingBorderWidth: number;
}): { marginLeft: number; marginRight: number; maxWidth: number } {
  const measure = Math.min(input.containerWidth, input.measureWidth);
  const inset = (input.containerWidth - measure) / 2;
  const extra = input.boxSizing === "content-box" ? input.paddingBorderWidth : 0;
  return {
    marginLeft: inset + input.marginLeft,
    marginRight: inset + input.marginRight,
    maxWidth: Math.max(0, measure - input.marginLeft - input.marginRight - extra),
  };
}

/**
 * 只对已确认溢出的普通正文图片/背景图盒收紧 max-width，保留更小的作者上限。
 * containingContentWidth 是实际块级包含盒的 content-box 宽（inline 链接需上溯）；auto margin 按 0 预算。
 * authoredMaxWidth 为 computed px，none 由调用者传 Infinity；未知值不进此函数。
 * 不修改 width/height/max-height，不以 object-fit 代替元素自身限宽。
 */
export function planContainedMediaMaxWidth(input: {
  containingContentWidth: number;
  marginLeft: number;
  marginRight: number;
  boxSizing: BoxSizing;
  paddingBorderWidth: number;
  authoredMaxWidth: number;
}): number {
  const extra = input.boxSizing === "content-box" ? input.paddingBorderWidth : 0;
  const available = input.containingContentWidth - input.marginLeft - input.marginRight - extra;
  return Math.min(input.authoredMaxWidth, Math.max(0, available));
}

function resolveBlockContainingContentWidth(
  viewer: HTMLElement | null,
  scrollMode: boolean | undefined,
  effectiveColumnWidth: number | undefined,
  contentDoc: Document | null,
  parent: HTMLElement | null,
  parentStyle: CSSStyleDeclaration | null
): number {
  if (!viewer) return 0;
  if (parent && parent !== viewer) {
    const paddingLeft = parseFloat(parentStyle?.paddingLeft ?? "") || 0;
    const paddingRight = parseFloat(parentStyle?.paddingRight ?? "") || 0;
    return Math.max(0, (parent.clientWidth || 0) - paddingLeft - paddingRight);
  }
  const style =
    parentStyle ?? contentDoc?.defaultView?.getComputedStyle(viewer) ?? null;
  const paddingLeft = parseFloat(style?.paddingLeft ?? "") || 0;
  const paddingRight = parseFloat(style?.paddingRight ?? "") || 0;
  if (scrollMode) {
    return Math.max(0, (viewer.clientWidth || 0) - paddingLeft - paddingRight);
  }
  if (typeof effectiveColumnWidth === "number" && Number.isFinite(effectiveColumnWidth) && effectiveColumnWidth > 0) {
    return effectiveColumnWidth;
  }
  return Math.max(0, (viewer.clientWidth || 0) - paddingLeft - paddingRight);
}

/** 旧引擎读不到 Typed OM 时返回 undefined；true length 值由调用方用 resolvedMarginKind 判定。 */
export function readComputedHorizontalMarginSpecifiedValues(
  el: Element
): { left?: string; right?: string } | undefined {
  try {
    const styleMap = (el as Element & TypedStyleMapHost).computedStyleMap?.();
    if (!styleMap) return undefined;
    return {
      left: styleMap.get("margin-left")?.toString(),
      right: styleMap.get("margin-right")?.toString(),
    };
  } catch {
    return undefined;
  }
}

type PercentageWidthValue = number | null | undefined;

function parsePercentageWidthValue(value: string): number | null {
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))%$/u);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

type TypedWidthStyleMapHost = {
  computedStyleMap?: () => {
    get(property: string): { toString(): string } | undefined;
  };
};

type WidthCascadeCandidate = {
  value: string;
  important: boolean;
  specificity: number;
  order: number;
};

function selectorSpecificity(selector: string, el: Element): number | undefined {
  const matching = selector
    .split(",")
    .map((part) => part.trim())
    .filter((part) => {
      try {
        return part !== "" && el.matches(part);
      } catch {
        return false;
      }
    });
  const candidate = matching.length > 0 ? matching : [selector];
  let best = 0;
  for (const part of candidate) {
    // These pseudo-classes have selector-specific specificity rules which
    // this small fallback parser intentionally does not implement.  A legacy
    // engine must not guess their cascade order and accidentally exempt C-31.
    if (/(?::where|:is|:not|:has)\s*\(/u.test(part)) return undefined;
    const withoutStrings = part.replace(/(["']).*?\1/gu, "");
    const ids = (withoutStrings.match(/#[\w-]+/gu) ?? []).length;
    const classes = (withoutStrings.match(/(?:\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?)/gu) ?? []).length;
    const elements = (withoutStrings
      .replace(/#[\w-]+/gu, " ")
      .replace(/(?:\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?)/gu, " ")
      .match(/(?:^|[ >+~])([a-zA-Z][\w-]*)/gu) ?? []).length;
    best = Math.max(best, ids * 1_000_000 + classes * 1_000 + elements);
  }
  return best;
}

function getActiveCssCondition(
  rule: CSSRule,
  win: Window | null | undefined
): boolean | undefined {
  const conditional = rule as CSSRule & {
    conditionText?: string;
    media?: { mediaText?: string };
  };
  if (rule.type === 4) {
    const query = conditional.media?.mediaText;
    if (!query || !win || typeof win.matchMedia !== "function") return undefined;
    try {
      return win.matchMedia(query).matches;
    } catch {
      return undefined;
    }
  }
  if (rule.type === 12) {
    const query = conditional.conditionText;
    const css = (win as Window & { CSS?: { supports?: (condition: string) => boolean } } | null | undefined)?.CSS;
    if (!query || typeof css?.supports !== "function") return undefined;
    try {
      return css.supports(query);
    } catch {
      return undefined;
    }
  }
  // @layer, @container and future grouping rules have cascade/condition
  // semantics that this fallback intentionally does not model.  @import is
  // safe to recurse into as a source-order container; other unknown groups
  // must remain conservative.
  if (rule.type !== 1 && rule.type !== 3 && (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules) {
    return undefined;
  }
  return true;
}

/**
 * 读取页面元素最终获胜的作者 width 是否是明确百分比。
 *
 * Typed OM 在支持的引擎中提供当前最终值；旧 WebView 只能读取 CSSOM，
 * 因此回退只按简单选择器的基础重要性/特异性/源顺序排序，而不是宣称
 * 实现完整 CSS cascade。返回 null 表示已知不是百分比，undefined 表示
 * CSSOM 不完整/不可读，调用方必须对后者保持 C-31 原行为。
 */
export function getAuthoredPercentageWidth(el: Element, doc: Document): PercentageWidthValue {
  try {
    const typedMap = (el as Element & TypedWidthStyleMapHost).computedStyleMap?.();
    const typed = typedMap?.get("width");
    if (typed) {
      // A present Typed OM value is the final computed value.  If it is px,
      // do not resurrect an earlier author percentage from CSSOM.
      const typedText = typed.toString();
      if (typedText.trim() !== "") return parsePercentageWidthValue(typedText);
    }
  } catch {
    // Fall through to the CSSOM/inline cascade fallback.
  }

  const inlineStyle = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  const inlineValue = inlineStyle?.getPropertyValue?.("width") ?? "";
  const inlinePriority = inlineStyle?.getPropertyPriority?.("width") ?? "";
  let best: WidthCascadeCandidate | null = inlineValue
    ? {
        value: inlineValue,
        important: inlinePriority === "important",
        specificity: 1_000_000_000,
        order: Number.MAX_SAFE_INTEGER,
      }
    : null;
  let order = 0;
  let unknownSheet = false;
  let readerSheetHasMatchingWidth = false;
  const isBetter = (next: WidthCascadeCandidate, current: WidthCascadeCandidate | null): boolean => {
    if (!current) return true;
    if (next.important !== current.important) return next.important;
    if (next.specificity !== current.specificity) return next.specificity > current.specificity;
    return next.order >= current.order;
  };
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      order += 1;
      const active = getActiveCssCondition(rule, doc.defaultView);
      if (active === false) continue;
      if (active === undefined) {
        unknownSheet = true;
        continue;
      }
      if (rule.type === 1) {
        const styleRule = rule as CSSStyleRule;
        const selector = styleRule.selectorText ?? "";
        if (selector) {
          let matches = false;
          try {
            matches = el.matches(selector);
          } catch {
            unknownSheet = true;
            matches = false;
          }
          const value = styleRule.style.getPropertyValue("width");
          if (matches && value) {
            const specificity = selectorSpecificity(selector, el);
            if (specificity === undefined) {
              unknownSheet = true;
              continue;
            }
            const candidate: WidthCascadeCandidate = {
              value,
              important: styleRule.style.getPropertyPriority("width") === "important",
              specificity,
              order,
            };
            if (isBetter(candidate, best)) best = candidate;
          }
        }
      }
      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules) walk(nested.cssRules);
      } catch {
        unknownSheet = true;
      }
    }
  };

  for (const sheet of Array.from(doc.styleSheets ?? [])) {
    const owner = sheet.ownerNode as Element | null;
    const isReaderSheet = owner?.hasAttribute?.("data-reader") || owner?.getAttribute?.("data-reader") != null;
    try {
      if (isReaderSheet) {
        // `customCss` is appended to this same reader stylesheet.  In an old
        // WebView we cannot distinguish it from built-in overrides reliably;
        // a matching explicit width therefore makes the author-only fallback
        // unknown instead of letting an earlier EPUB rule form a false group.
        const inspectReaderWidth = (rules: CSSRuleList): void => {
          for (const rule of Array.from(rules)) {
            const active = getActiveCssCondition(rule, doc.defaultView);
            if (active === undefined) {
              unknownSheet = true;
              continue;
            }
            if (active === false) continue;
            if (rule.type === 1) {
              const styleRule = rule as CSSStyleRule;
              const selector = styleRule.selectorText ?? "";
              const value = styleRule.style.getPropertyValue("width");
              if (selector && value) {
                try {
                  if (el.matches(selector)) readerSheetHasMatchingWidth = true;
                } catch {
                  unknownSheet = true;
                }
              }
            }
            const nested = rule as CSSRule & { cssRules?: CSSRuleList };
            try {
              if (nested.cssRules) inspectReaderWidth(nested.cssRules);
            } catch {
              unknownSheet = true;
            }
          }
        };
        inspectReaderWidth(sheet.cssRules);
      } else {
        walk(sheet.cssRules);
      }
    } catch {
      unknownSheet = true;
    }
  }

  // An inline !important declaration wins over every author stylesheet.  It
  // remains usable even when an unrelated external sheet is unreadable.
  if ((unknownSheet || readerSheetHasMatchingWidth) && inlinePriority !== "important") return undefined;
  if (!best) return null;
  return parsePercentageWidthValue(best.value);
}

export interface PercentageFloatGroupEntry {
  eligible: boolean;
  readerTop: boolean;
  float: string;
  clear: string;
  /** null = known non-percentage (e.g. px); undefined = unreadable/unknown. */
  percentageWidth: PercentageWidthValue;
  marginLeft?: string;
  marginRight?: string;
  position?: string;
  writingMode?: string;
  direction?: string;
  authorFullWidthIntent?: boolean;
  percentageMargin?: boolean | undefined;
}

/**
 * C-31 的连续作者栅格门控。只对至少两个直接 sibling、同方向、明确为
 * 百分比且总和约等于一整行的 float 组返回 true；其他元素逐项保持旧补偿。
 */
export function getPercentageFloatGroupMembers(
  entries: readonly PercentageFloatGroupEntry[]
): boolean[] {
  const result = entries.map(() => false);
  let index = 0;
  while (index < entries.length) {
    const first = entries[index];
    const direction = first.float.trim().toLowerCase();
    if (
      !first.eligible ||
      !first.readerTop ||
      first.clear.trim().toLowerCase() !== "none" ||
      !/^(?:left|right)$/u.test(direction) ||
      typeof first.percentageWidth !== "number" ||
      first.percentageWidth <= 0 ||
      first.percentageWidth > 100
    ) {
      index += 1;
      continue;
    }
    const group: number[] = [index];
    let sum = first.percentageWidth;
    let cursor = index + 1;
    while (cursor < entries.length) {
      const entry = entries[cursor];
      const width = entry.percentageWidth;
      if (
        !entry.eligible ||
        !entry.readerTop ||
        entry.clear.trim().toLowerCase() !== "none" ||
        entry.float.trim().toLowerCase() !== direction ||
        typeof width !== "number" ||
        width <= 0 ||
        width > 100
      ) {
        break;
      }
      group.push(cursor);
      sum += width;
      cursor += 1;
    }
    if (group.length >= 2 && sum >= 99 && sum <= 101) {
      for (const member of group) result[member] = true;
    }
    index = Math.max(cursor, index + 1);
  }
  return result;
}

/**
 * 阶段 2 的完整安全门。粗粒度 C-31 组还必须是物理水平、静态/相对定位、
 * 无全宽意图，且最终级联 margin 已经解析为有限近零值；任何信息缺失都
 * 保守回退到作者原始 float，不尝试以百分比猜测布局。
 */
export function getSafePercentageFloatGroupMembers(
  entries: readonly PercentageFloatGroupEntry[]
): boolean[] {
  const coarse = getPercentageFloatGroupMembers(entries);
  const safe = coarse.map(() => false);
  const finiteNearZero = (value: string | undefined): boolean => {
    if (value === undefined) return false;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && Math.abs(parsed) <= 0.5;
  };
  let index = 0;
  while (index < coarse.length) {
    if (!coarse[index]) {
      index += 1;
      continue;
    }
    const group: number[] = [];
    while (index < coarse.length && coarse[index]) group.push(index++);
    const valid = group.every((member) => {
      const entry = entries[member];
      return (
        /^(?:static|relative)$/u.test((entry.position ?? "").trim().toLowerCase()) &&
        (entry.writingMode ?? "").trim().toLowerCase() === "horizontal-tb" &&
        (entry.direction ?? "").trim().toLowerCase() === "ltr" &&
        entry.authorFullWidthIntent === false &&
        entry.percentageMargin === false &&
        finiteNearZero(entry.marginLeft) &&
        finiteNearZero(entry.marginRight)
      );
    });
    if (valid) for (const member of group) safe[member] = true;
  }
  return safe;
}

/** 将完整百分比组投影到当前包含块与 40rem 版心中的较小宽度。 */
export function getPercentageFloatGroupTargetWidths(
  percentages: readonly number[],
  parentWidth: number,
  contentWidth: number
): number[] | null {
  if (
    percentages.length < 2 ||
    !Number.isFinite(parentWidth) ||
    !Number.isFinite(contentWidth) ||
    parentWidth <= 0 ||
    contentWidth <= 0 ||
    percentages.some((value) => !Number.isFinite(value) || value <= 0 || value > 100)
  ) return null;
  const total = percentages.reduce((sum, value) => sum + value, 0);
  if (total < 99 || total > 101) return null;
  const targetParent = Math.min(parentWidth, contentWidth);
  return percentages.map((percentage) =>
    Math.min(parentWidth * percentage / 100, targetParent * percentage / 100)
  );
}

export interface PercentageFloatGroupRect {
  left: number;
  right: number;
  top: number;
  width: number;
}

/** 组写回后的事务式几何门，失败时调用方必须恢复整组。 */
export function isPercentageFloatGroupGeometryValid({
  rects,
  viewerLeft,
  scrollLeft,
  step,
  parentWidth,
  contentWidth,
  epsilon = 0.75,
}: {
  rects: readonly (readonly PercentageFloatGroupRect[])[];
  viewerLeft: number;
  scrollLeft: number;
  step: number;
  parentWidth: number;
  contentWidth: number;
  epsilon?: number;
}): boolean {
  if (
    rects.length < 2 ||
    !Number.isFinite(viewerLeft) ||
    !Number.isFinite(scrollLeft) ||
    !Number.isFinite(step) ||
    !Number.isFinite(parentWidth) ||
    !Number.isFinite(contentWidth) ||
    step <= 0 ||
    parentWidth <= 0 ||
    contentWidth <= 0
  ) return false;
  if (rects.some((memberRects) => memberRects.length !== 1)) return false;
  const first = rects[0][0];
  if (!first || first.width <= 0) return false;
  const expectedParentWidth = Math.min(parentWidth, contentWidth);
  const firstColumn = Math.floor((first.left - viewerLeft + scrollLeft + epsilon) / step);
  if (firstColumn < 0) return false;
  const columnStart = viewerLeft + firstColumn * step - scrollLeft;
  const columnLeft = columnStart + (parentWidth - expectedParentWidth) / 2;
  const columnRight = columnLeft + expectedParentWidth;
  return rects.every((memberRects) => {
    const rect = memberRects[0];
    if (!rect || rect.width <= 0) return false;
    const column = Math.floor((rect.left - viewerLeft + scrollLeft + epsilon) / step);
    return (
      column === firstColumn &&
      Math.abs(rect.top - first.top) <= epsilon &&
      rect.left >= columnLeft - epsilon &&
      rect.right <= columnRight + epsilon
    );
  });
}

/**
 * 兼容不支持 Typed OM 的旧 WebView：从可读样式表中寻找百分比声明。
 * 任何一个外链样式表不可读时，负结果都不可靠，返回 undefined 交给
 * 几何兜底；单个 SecurityError 不得中断整章测量。
 */
export function hasPercentageHorizontalMarginInRules(
  doc: Document,
  el: Element
): boolean | undefined {
  const walk = (rules: CSSRuleList): boolean => {
    for (const rule of Array.from(rules)) {
      const styleRule = rule as CSSStyleRule;
      if (typeof styleRule.selectorText === "string") {
        const selector = styleRule.selectorText ?? "";
        if (!selector) continue;
        try {
          if (el.matches(selector) && styleHasPercentageHorizontalMargin(styleRule.style)) {
            return true;
          }
        } catch {
          /* 复杂/伪类选择器匹配失败时忽略 */
        }
      }
      // @media/@supports/@layer 等嵌套规则都可能携带作者 margin 声明。
      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules && walk(nested.cssRules)) return true;
      } catch {
        // 当前 sheet 已经可读时，单条嵌套规则的失败只代表该分支不可判定；
        // 继续扫描其他规则，外层 sheet 的不可读标记由调用处统一处理。
      }
    }
    return false;
  };

  let unreadableSheet = false;
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      if (walk(sheet.cssRules)) return true;
    } catch {
      unreadableSheet = true;
    }
  }
  return unreadableSheet ? undefined : false;
}

/** 百分比声明只有解析出实际水平偏移时才进入页面相对布局分支。 */
export function isPercentageMarginLayout(
  hasPercentage: boolean,
  computedLeft: string,
  computedRight: string
): boolean {
  if (!hasPercentage) return false;
  return (parseFloat(computedLeft) || 0) !== 0 || (parseFloat(computedRight) || 0) !== 0;
}

/**
 * 最后一道跨引擎兜底：未知来源的 margin 在作者原位仍留有明确余量，但
 * C-04 再叠加正文版心会越出包含块时，保留作者原位。仅接受有限、非负、
 * 非 auto-like 的显式 margin；普通 2em 缩进与作者原位本就越列不命中。
 */
export function shouldKeepContainingBlockMarginsWhenBaseWouldOverflow({
  parentWidth,
  width,
  marginLeft,
  marginRight,
}: {
  parentWidth: number;
  width: number;
  marginLeft: number;
  marginRight: number;
}): boolean {
  if (
    !Number.isFinite(parentWidth) ||
    !Number.isFinite(width) ||
    !Number.isFinite(marginLeft) ||
    !Number.isFinite(marginRight) ||
    parentWidth <= 0 ||
    width < 0 ||
    marginLeft < 0 ||
    marginRight < 0
  ) {
    return false;
  }
  const base = (parentWidth - width) / 2;
  if (
    isAutoLikeHorizontalMargin({ parentWidth, width, marginLeft, marginRight })
  ) {
    return false;
  }
  const epsilon = 0.5;
  // CSS auto margin 会在 getComputedStyle 中变成“恰好填满剩余空间”的 px。
  // 只有作者原位仍留出明确余量，才能证明不是这类 auto-resolved 布局。
  const originalHasRoom = marginLeft + width + marginRight < parentWidth - epsilon;
  const withReaderBaseOverflows =
    base + marginLeft + width + marginRight > parentWidth + epsilon;
  return originalHasRoom && withReaderBaseOverflows;
}

/**
 * 正对称水平 margin 表达的是双侧留白，而不是向某一侧缩进。
 * 仅接受正有限值；负 margin 即使相等也可能是作者有意的双侧出血。
 */
export function isSymmetricHorizontalMargin(left: string, right: string): boolean {
  const ml = parseFloat(left);
  const mr = parseFloat(right);
  return (
    Number.isFinite(ml) &&
    Number.isFinite(mr) &&
    ml > 0 &&
    mr > 0 &&
    Math.abs(ml - mr) < 0.5
  );
}

export interface ReaderTopUaSymmetricInsetInput {
  /** 只允许阅读器版心的直接子元素。 */
  readerTop: boolean;
  /** 只有 C-37 已证明没有作者/用户水平 margin 时才可进入。 */
  authoredHorizontalMargin: AuthoredHorizontalMarginResult;
  /** UA inset 不参与 float/fullpage 等已有更高优先级路径。 */
  float: string;
  fullpage: boolean;
  percentageMargin: boolean | undefined;
  parentWidth: number;
  /** getBorderBoxWidth() 的当前 border-box 宽度。 */
  borderBoxWidth: number;
  /** getComputedStyle().width；用于把 border-box 结果换回 max-width。 */
  cssWidth: number;
  boxSizing: string;
  marginLeft: string;
  marginRight: string;
}

/**
 * C-37 follow-up：UA 默认的 blockquote 等对称水平 margin 是盒内双侧留白，
 * 不是 C-04 的单侧版心偏移。将其折算为居中的有效 max-width；返回值按
 * 当前 box-sizing 表示（content-box 返回内容宽度，border-box 返回外框宽度）。
 *
 * 该纯函数只接受 reader-top、明确 UA-only、非浮动/非全页、非百分比且有限
 * 的正对称 margin。目标宽度同时受包含块限制，避免窄视口出现负宽或溢出。
 */
export function getReaderTopUaSymmetricInsetMaxWidth(
  input: ReaderTopUaSymmetricInsetInput
): number | null {
  if (
    !input.readerTop ||
    input.authoredHorizontalMargin !== false ||
    input.fullpage ||
    input.float.trim().toLowerCase() !== "none" ||
    input.percentageMargin === true
  ) {
    return null;
  }
  if (
    !Number.isFinite(input.parentWidth) ||
    !Number.isFinite(input.borderBoxWidth) ||
    !Number.isFinite(input.cssWidth) ||
    input.parentWidth <= 0 ||
    input.borderBoxWidth <= 0 ||
    input.cssWidth < 0
  ) {
    return null;
  }
  const marginLeft = Number.parseFloat(input.marginLeft);
  const marginRight = Number.parseFloat(input.marginRight);
  if (
    !Number.isFinite(marginLeft) ||
    !Number.isFinite(marginRight) ||
    marginLeft <= 0 ||
    marginRight <= 0 ||
    Math.abs(marginLeft - marginRight) > 0.5
  ) {
    return null;
  }

  const currentBorderBox = Math.min(input.borderBoxWidth, input.parentWidth);
  const targetBorderBox = Math.max(
    0,
    Math.min(input.parentWidth, currentBorderBox - marginLeft - marginRight)
  );
  const extraBox = Math.max(0, input.borderBoxWidth - input.cssWidth);
  const borderBoxSizing = input.boxSizing.trim().toLowerCase() === "border-box";
  const target = borderBoxSizing ? targetBorderBox : targetBorderBox - extraBox;
  if (!Number.isFinite(target) || target < 0) return null;
  return target;
}

/**
 * getComputedStyle 会把 `margin:auto` 解析为实际 px。只有两侧余量都等于
 * 当前盒子的居中余量时，才能把它当作作者/阅读器的 auto 居中，而不是
 * 显式写出的相等 margin。
 */
export function isAutoLikeHorizontalMargin({
  parentWidth,
  width,
  marginLeft,
  marginRight,
}: {
  parentWidth: number;
  width: number;
  marginLeft: number;
  marginRight: number;
}): boolean {
  if (
    !Number.isFinite(parentWidth) ||
    !Number.isFinite(width) ||
    !Number.isFinite(marginLeft) ||
    !Number.isFinite(marginRight)
  ) {
    return false;
  }
  const autoCenter = (parentWidth - width) / 2;
  return (
    autoCenter > 0 &&
    marginLeft > 0 &&
    Math.abs(marginLeft - marginRight) < 0.5 &&
    Math.abs(marginLeft - autoCenter) < 0.5
  );
}

/**
 * C-18 的正对称 margin 豁免只属于 fit/max-content 这类 intrinsic-size
 * 容器。普通 width:auto/固定宽度元素仍由 C-04 把作者 margin 映射到正文
 * 版心；否则目录标题的显式左右缩进会再次被 L3 auto margin 吞掉。
 */
export function shouldKeepSymmetricMarginsCentered(
  left: string,
  right: string,
  hasIntrinsicSizeIntent: boolean
): boolean {
  return hasIntrinsicSizeIntent && isSymmetricHorizontalMargin(left, right);
}

export interface CenteredAuthorMarginInput {
  readerTop: boolean;
  float: string;
  writingMode: string;
  fullpage: boolean;
  intrinsicSize: boolean;
  percentageMargin: boolean | undefined;
  authoredHorizontalMargin: AuthoredHorizontalMarginResult;
  authoredSizingIntent: AuthoredSizingIntentResult;
  textAlign: string;
  marginLeft: string;
  marginRight: string;
}

/**
 * C-40：普通页面级居中块的显式对称 margin 是双侧留白，不是 C-04 单向
 * 版心偏移。只有 margin/sizing 来源都已知为作者声明且没有 sizing intent
 * 时才跳过 C-04；未知 CSSOM、固定宽度盒、float、fit/fullpage 和百分比
 * margin 全部保留旧路径。
 */
export function shouldKeepCenteredAuthorMargins(
  input: CenteredAuthorMarginInput
): boolean {
  return (
    input.readerTop &&
    input.float.trim().toLowerCase() === "none" &&
    input.writingMode.trim().toLowerCase() === "horizontal-tb" &&
    !input.fullpage &&
    !input.intrinsicSize &&
    input.percentageMargin !== true &&
    input.authoredHorizontalMargin === true &&
    input.authoredSizingIntent === false &&
    input.textAlign.trim().toLowerCase() === "center" &&
    isSymmetricHorizontalMargin(input.marginLeft, input.marginRight)
  );
}

export interface ReaderTopFloatContainmentInput {
  /** 只允许 viewer 的直接子页面级元素进入。 */
  readerTop: boolean;
  /** 必须是浏览器最终计算出的物理方向 float。 */
  float: string;
  /** `.illus` 等整页布局不能被版心补偿改变。 */
  fullpage: boolean;
  parentWidth: number;
  width: number;
  /** 阅读器默认版心的 border-box 上限（通常为 40rem）。 */
  contentWidth: number;
  marginLeft: string;
  marginRight: string;
  /** 作者明确要求全宽/突破版心时保持原布局。 */
  authorFullWidthIntent: boolean;
}

export interface ReaderTopFloatLayoutInput extends ReaderTopFloatContainmentInput {
  /** 作者 margin 来源；undefined 表示无法证明安全级联。 */
  authoredHorizontalMargin: AuthoredHorizontalMarginResult;
  /** true/undefined 都不能安全地重写百分比或未知 margin。 */
  percentageMargin: boolean | undefined;
  position: string;
  writingMode: string;
  /** Physical left/right float placement is owned by this containing block. */
  parentWritingMode?: string;
  direction: string;
}

/**
 * 统一的顶层浮动布局单元门控。
 *
 * 只有横排（或横排包含块内的竖排引文）、静态/相对定位、有限非负 margin 且没有明确突破
 * 版心意图的单项 float 才能投影到阅读器版心。返回的两侧 margin 是
 * border-box 外侧 margin：浮动侧加上阅读器版心 inset，另一侧保留书值。
 * 百分比、未知级联、负值、绝对定位和其他书写组合返回 null，由调用方
 * 以原始测量值保留书籍布局，绝不落入 C-04/C-18。
 */
export function getReaderTopFloatLayoutMargins(
  input: ReaderTopFloatLayoutInput
): { left: number; right: number } | null {
  const float = input.float.trim().toLowerCase();
  const position = input.position.trim().toLowerCase();
  const writingMode = input.writingMode.trim().toLowerCase();
  const direction = input.direction.trim().toLowerCase();
  if (
    !input.readerTop ||
    input.fullpage ||
    !/^(?:left|right)$/u.test(float) ||
    !/^(?:static|relative)$/u.test(position) ||
    (writingMode !== "horizontal-tb" &&
      !(/^(?:vertical-rl|vertical-lr)$/u.test(writingMode) && input.parentWritingMode === "horizontal-tb")) ||
    direction !== "ltr"
  ) return null;
  if (
    !Number.isFinite(input.parentWidth) ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.contentWidth) ||
    input.parentWidth <= 0 ||
    input.width < 0 ||
    input.contentWidth <= 0 ||
    input.width > input.contentWidth + 0.5 ||
    input.authorFullWidthIntent ||
    input.percentageMargin === true
  ) return null;

  // A failed CSSOM probe is intentionally conservative when the element has
  // an actual margin. A zero-margin element does not need the author-source
  // distinction and can still use the legacy C-31 projection.
  const parseMargin = (value: string): number | null => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "auto") return 0;
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const marginLeft = parseMargin(input.marginLeft);
  const marginRight = parseMargin(input.marginRight);
  if (marginLeft === null || marginRight === null || marginLeft < 0 || marginRight < 0) return null;
  if (
    input.authoredHorizontalMargin === undefined &&
    (marginLeft > 0.5 || marginRight > 0.5)
  ) return null;

  const inset = Math.max(
    0,
    (input.parentWidth - Math.min(input.parentWidth, input.contentWidth)) / 2
  );
  const left = float === "left" ? inset + marginLeft : marginLeft;
  const right = float === "right" ? inset + marginRight : marginRight;
  // Never create a new overflow while containing an otherwise valid float.
  if (left + input.width + right > input.parentWidth + 0.5) return null;
  return { left, right };
}

/** Nonnegative length insets on auto-sized grouping blocks belong inside L3.
 * Percentage positioning only qualifies when symmetric; explicit/unknown sizing stays authored.
 */
export function getReaderAutoBlockInsets(input: {
  /** Headings retain the established C-24/C-40 alignment contract. */
  heading?: boolean;
  /** Length insets are for grouping containers, not inline-only display titles. */
  groupedBlockContent?: boolean;
  percentage: boolean | undefined;
  authoredSizing: boolean | undefined;
  float: string;
  display: string;
  position: string;
  writingMode: string;
  parentWidth: number;
  contentWidth: number;
  marginLeft: number;
  marginRight: number;
  borderBoxExtra: number;
}): { left: number; right: number; maxWidth: number } | null {
  const { parentWidth, contentWidth, marginLeft, marginRight, borderBoxExtra } = input;
  if (input.heading || input.percentage === undefined || input.authoredSizing !== false || input.float !== "none" ||
    (input.percentage === false && input.groupedBlockContent !== true) ||
    !/^(?:block|flow-root|flex|grid)$/u.test(input.display) ||
    !/^(?:static|relative)$/u.test(input.position) || input.writingMode !== "horizontal-tb" ||
    ![parentWidth, contentWidth, marginLeft, marginRight, borderBoxExtra].every(Number.isFinite) ||
    parentWidth <= 0 || contentWidth <= 0 || marginLeft < 0 || marginRight < 0 || marginLeft + marginRight <= 0 ||
    (input.percentage && (marginLeft <= 0 || marginRight <= 0 || Math.abs(marginLeft - marginRight) > 0.5)) || marginLeft + marginRight >= parentWidth || borderBoxExtra < 0
  ) return null;
  const measure = Math.min(parentWidth, contentWidth);
  const inset = (parentWidth - measure) / 2;
  const left = input.percentage ? marginLeft / parentWidth * measure : marginLeft;
  const right = input.percentage ? marginRight / parentWidth * measure : marginRight;
  const maxWidth = measure - left - right - borderBoxExtra;
  return maxWidth > 0 ? { left: inset + left, right: inset + right, maxWidth } : null;
}

/**
 * L3/L4 浮动页面级元素的版心内缩纯决策门。
 *
 * Chromium 会让没有作者 margin 的顶层 float 直接贴在多栏 viewer 的窗口
 * 边缘；普通 reader-top 则由 L3 auto margin 居中。这里仅给“窄于 40rem、
 * 没有作者水平 margin、也没有全宽意图”的页面级 float 恢复同一版心边缘。
 * 纯函数不触碰 DOM，供 applyBookMargins 与稳定回归测试共同使用。
 */
export function getReaderTopFloatContainmentMargins(
  input: ReaderTopFloatContainmentInput
): { left: number; right: number } | null {
  const epsilon = 0.5;
  const float = input.float.trim().toLowerCase();
  if (!input.readerTop || input.fullpage || !/^(?:left|right)$/u.test(float)) {
    return null;
  }
  if (
    !Number.isFinite(input.parentWidth) ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.contentWidth) ||
    input.parentWidth <= 0 ||
    input.width < 0 ||
    input.contentWidth <= 0 ||
    input.width > input.contentWidth + epsilon ||
    input.authorFullWidthIntent
  ) {
    return null;
  }
  const meaningful = (value: string): boolean => {
    if (!value || value.trim().toLowerCase() === "auto") return false;
    const parsed = parseFloat(value);
    // Unknown expressions (`calc`, `var`, env-dependent values) are treated as
    // meaningful so a conservative fallback never overwrites author layout.
    return !Number.isFinite(parsed) || Math.abs(parsed) > epsilon;
  };
  if (meaningful(input.marginLeft) || meaningful(input.marginRight)) return null;

  const inset = Math.max(0, (input.parentWidth - Math.min(input.parentWidth, input.contentWidth)) / 2);
  // Match the physical float side: a right float gets right margin to move its
  // right edge inward; a left float gets left margin to move its left edge in.
  return float === "right" ? { left: 0, right: inset } : { left: inset, right: 0 };
}

export interface ReaderTopAutoMarginRestoreInput {
  /** 只允许 viewer 的直接子页面级元素进入。 */
  readerTop: boolean;
  /** float 是独立布局单元，由 C-31/C-39 处理。 */
  float: string;
  /** 只处理常规块级盒；inline/inline-block 等保持书的行内布局。 */
  display: string;
  position: string;
  writingMode: string;
  /** `.illus` 等整页布局不能被版心补偿改变。 */
  fullpage: boolean;
  percentageMargin: boolean | undefined;
  /** 当前测量出的 border-box 宽度。 */
  borderBoxWidth: number;
  /** 阅读器默认版心的 border-box 上限（通常为 40rem）。 */
  contentWidth: number;
}

/**
 * L3-C53 纯决策门：恢复被书 `!important` 零 margin 压掉的页面级居中。
 *
 * L3 用零特异性 `:where(#epub-viewer) .reader-top{margin:auto!important}`
 * 居中页面级块；书里带标签的 `!important` 重置（如
 * `div.toolbar{margin:.5em 0!important}`）特异性更高，两边都 important 时
 * 书获胜，普通顶层块因此贴在栏左缘而不是版心。computed 零值只可能来自
 * 真正赢下级联的声明，所以这里只为“已经落在版心宽度内的常规横排块”
 * 写回 auto；float、百分比、全页图、竖排、绝对定位和超过版心的盒保持
 * 书布局。纯函数不触碰 DOM，供 applyBookMargins 与回归测试共用。
 */
export function shouldRestoreReaderTopAutoMargin(
  input: ReaderTopAutoMarginRestoreInput
): boolean {
  const epsilon = 0.5;
  return (
    input.readerTop &&
    !input.fullpage &&
    input.percentageMargin !== true &&
    input.float.trim().toLowerCase() === "none" &&
    /^(?:block|flow-root|flex|grid)$/u.test(input.display.trim().toLowerCase()) &&
    /^(?:static|relative)$/u.test(input.position.trim().toLowerCase()) &&
    input.writingMode.trim().toLowerCase() === "horizontal-tb" &&
    Number.isFinite(input.borderBoxWidth) &&
    Number.isFinite(input.contentWidth) &&
    input.borderBoxWidth > 0 &&
    input.contentWidth > 0 &&
    input.borderBoxWidth <= input.contentWidth + epsilon
  );
}

export interface AutoMarginFix {
  el: HTMLElement;
  left: InlineStyleValue;
  right: InlineStyleValue;
}

/**
 * 只用于 C-53 已有纯门判定通过的零 margin 常规块。
 * read/decide 循环内 add，循环完全结束后统一 flush。不要包住 float 试验等相依阶段。
 * 每个候选每测量轮只 add 一次；保持现有候选唯一性，不额外维护全局缓存。
 */
export function createAutoMarginBatch() {
  const queued: AutoMarginFix[] = [];
  return {
    add(el: HTMLElement): void {
      queued.push({
        el,
        left: snapshotInlineStyleProperty(el.style, "margin-left"),
        right: snapshotInlineStyleProperty(el.style, "margin-right"),
      });
    },
    flush(registerRestore: (fix: AutoMarginFix) => void): void {
      for (const fix of queued) {
        // 先登记原值，继续复用 paginator.restoreBookMargins 的恢复职责。
        registerRestore(fix);
        fix.el.setAttribute("data-reader-margin-fixed", "1");
        fix.el.style.setProperty("margin-left", "auto", "important");
        fix.el.style.setProperty("margin-right", "auto", "important");
      }
      queued.length = 0;
    },
    get size(): number {
      return queued.length;
    },
  };
}

/**
 * 只把明确的全宽/突破表达式视为作者意图；`max-width` 本身是上限，不能
 * 证明作者要求突破版心。`min()/max()/clamp()` 混合表达式也不作猜测，
 * 除非它明确包含 viewport 单位（例如 `calc(100vw - 2rem)`）。
 */
export function isAuthorFullWidthValue(
  value: string,
  property: "width" | "max-width" | "min-width"
): boolean {
  const compact = value.trim().toLowerCase().replace(/\s+/g, "");
  if (!compact || compact === "auto" || property === "max-width") return false;
  if (/^100(?:\.0+)?%$/u.test(compact)) return true;
  // A plain calc with a page-relative 100% base is an explicit full-page
  // expression; bounded min/max/clamp forms intentionally do not qualify.
  if (/^calc\(100%[+-]/u.test(compact)) return true;
  // Viewport units express page-relative/full-page intent even when a narrow
  // window makes their current computed width happen to fit inside 40rem.
  return /(?:dvw|svw|lvw|vw|vi|vmin|vmax)(?:$|[^a-z])/u.test(compact);
}

/**
 * 图片出血意图只认真正的 viewport 相对宽度或 >100% 百分比；
 * 普通 width:100% 是随包含盒流式宽度，不能当作出血。
 */
function isMediaBreakoutValue(
  value: string,
  property: "width" | "max-width" | "min-width"
): boolean {
  const compact = value.trim().toLowerCase().replace(/\s+/g, "");
  if (!compact || compact === "auto" || compact === "none") return false;
  if (/^100(?:\.0+)?%$/u.test(compact)) return false;
  const percent = compact.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))%$/u);
  if (percent && Number(percent[1]) > 100) return true;
  return isAuthorFullWidthValue(value, property);
}

type FullWidthRuleResult = boolean | undefined;

/** 只在当前生效的 author CSSOM 条件分支中寻找明确全宽意图。 */
export function hasAuthoredFullWidthIntentInRules(
  doc: Document,
  el: HTMLElement,
  isIntentValue: (value: string, property: "width" | "max-width" | "min-width") => boolean = isAuthorFullWidthValue
): FullWidthRuleResult {
  const win = doc.defaultView;
  const conditionState = (rule: CSSRule): FullWidthRuleResult => {
    const conditional = rule as CSSRule & {
      conditionText?: string;
      media?: { mediaText?: string };
    };
    if (rule.type === 4) {
      const query = conditional.media?.mediaText;
      if (!query || !win || typeof win.matchMedia !== "function") return undefined;
      try {
        return win.matchMedia(query).matches;
      } catch {
        return undefined;
      }
    }
    if (rule.type === 12) {
      const query = conditional.conditionText;
      const css = (win as Window & { CSS?: { supports?: (condition: string) => boolean } }).CSS;
      if (!query || typeof css?.supports !== "function") return undefined;
      try {
        return css.supports(query);
      } catch {
        return undefined;
      }
    }
    return true;
  };

  const walk = (rules: CSSRuleList): FullWidthRuleResult => {
    let unknownCondition = false;
    for (const rule of Array.from(rules)) {
      const active = conditionState(rule);
      if (active === false) continue;
      if (active === undefined) {
        unknownCondition = true;
        continue;
      }
      const styleRule = rule as CSSStyleRule;
      if (typeof styleRule.selectorText === "string" && styleRule.selectorText) {
        try {
          if (
            el.matches(styleRule.selectorText) &&
            (["width", "max-width", "min-width"] as const).some((property) =>
              isIntentValue(styleRule.style.getPropertyValue(property), property)
            )
          ) {
            return true;
          }
        } catch {
          /* 复杂选择器匹配失败时继续扫描其他规则。 */
        }
      }
      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules) {
          const nestedResult = walk(nested.cssRules);
          if (nestedResult === true) return true;
          if (nestedResult === undefined) unknownCondition = true;
        }
      } catch {
        // 对无法识别的条件/规则保守不推断，调用方会跳过本次补偿。
        unknownCondition = true;
      }
    }
    return unknownCondition ? undefined : false;
  };
  let unknownSheet = false;
  for (const sheet of Array.from(doc.styleSheets)) {
    const owner = sheet.ownerNode as Element | null;
    // Reader-injected overrides contain the L3 max-width rules themselves;
    // they are not author intent and must not veto this compatibility fix.
    const readerMarker = owner?.getAttribute?.("data-reader");
    if (owner?.hasAttribute?.("data-reader") || readerMarker != null) {
      continue;
    }
    try {
      const result = walk(sheet.cssRules);
      if (result === true) return true;
      if (result === undefined) unknownSheet = true;
    } catch {
      // An unreadable author sheet is an unknown source; do not infer intent.
      unknownSheet = true;
    }
  }
  return unknownSheet ? undefined : false;
}

function hasAuthorFullWidthIntent(doc: Document, el: HTMLElement): boolean {
  const inline = el.style;
  if (
    (["width", "max-width", "min-width"] as const).some((property) =>
      isAuthorFullWidthValue(inline.getPropertyValue(property), property)
    )
  ) {
    return true;
  }
  // Unknown author CSS conditions are treated as intent for this gate: the
  // layout fix must not overwrite a rule whose full-width meaning we cannot
  // reliably determine in the current engine.
  return hasAuthoredFullWidthIntentInRules(doc, el) !== false;
}

function hasAuthorMediaBreakoutIntent(doc: Document, el: HTMLElement): boolean {
  const inline = el.style;
  if (
    (["width", "min-width"] as const).some((property) =>
      isMediaBreakoutValue(inline.getPropertyValue(property), property)
    )
  ) {
    return true;
  }
  // Unknown author CSS conditions are treated as intent: do not overwrite a
  // media breakout whose cascade we cannot fully inspect.
  return hasAuthoredFullWidthIntentInRules(doc, el, isMediaBreakoutValue) !== false;
}

interface InlineStyleValue {
  value: string;
  priority: string;
}

function snapshotInlineStyleProperty(
  style: CSSStyleDeclaration,
  property: string
): InlineStyleValue {
  return {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

/** 恢复 inline 属性时同时恢复 !important，空值则彻底移除 longhand。 */
export function restoreInlineStyleProperty(
  style: CSSStyleDeclaration,
  property: string,
  original: InlineStyleValue
): void {
  if (original.value === "") style.removeProperty(property);
  else style.setProperty(property, original.value, original.priority);
}

/**
 * 只有直接 img/svg 与源码格式化空白的 float 是正常的媒体浮动，不属于
 * C-08 要修复的文字 shrink-to-fit。注释等非渲染节点不影响判断。
 */
export function isMediaOnlyFloatContent(nodes: Iterable<Node>): boolean {
  let hasMedia = false;
  for (const node of nodes) {
    if (node.nodeType === 3) {
      if ((node.textContent ?? "").trim() !== "") return false;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = (node as Element).tagName.toLowerCase();
    if (tag !== "img" && tag !== "svg") return false;
    hasMedia = true;
  }
  return hasMedia;
}

const MEDIA_ONLY_TAGS = new Set(["img", "svg", "image", "video", "audio", "canvas"]);

/**
 * Recursive variant used only for the trailing decorative-float guard. Wrapper
 * elements and comments are allowed, while any non-whitespace text vetoes the
 * media-only classification. A media element itself counts as the payload;
 * SVG descendants are still visited so embedded visible text is not hidden.
 */
export function isMediaOnlyFloatSubtree(nodes: Iterable<Node>): boolean {
  let hasMedia = false;
  const visit = (node: Node): boolean => {
    if (node.nodeType === 3) return (node.textContent ?? "").trim() === "";
    if (node.nodeType === 8) return true;
    if (node.nodeType !== 1) return true;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (MEDIA_ONLY_TAGS.has(tag)) hasMedia = true;
    const children = (el as unknown as { childNodes?: Iterable<Node> }).childNodes;
    if (!children) return true;
    for (const child of children) if (!visit(child)) return false;
    return true;
  };
  for (const node of nodes) if (!visit(node)) return false;
  return hasMedia;
}

export interface FloatFixRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TrailingFloatFixGeometry {
  float: string;
  position: string;
  mediaOnly: boolean;
  beforeColumns: readonly number[];
  afterColumns: readonly number[];
  afterRects: readonly FloatFixRect[];
  afterVisualRects: readonly FloatFixRect[];
  previousVisualRects: readonly FloatFixRect[];
  estimatedBeforeBottom: number;
  contentBottom: number;
  viewerLeft: number;
  scrollLeft: number;
  step: number;
  pageWidth: number;
  epsilon?: number;
}

/** Conservative, DOM-independent decision gate for the trailing media float. */
export function shouldApplyTrailingFloatMarginFix(g: TrailingFloatFixGeometry): boolean {
  const epsilon = g.epsilon ?? 0.5;
  if (!/^(?:left|right)$/u.test(g.float) || !/^(?:static|relative)$/u.test(g.position)) return false;
  if (!g.mediaOnly || g.beforeColumns.length < 2 || g.afterColumns.length !== 1) return false;
  if (!Number.isFinite(g.step) || g.step <= 0 || !Number.isFinite(g.pageWidth) || g.pageWidth <= 0) {
    return false;
  }
  if (!g.afterRects.length || !g.afterVisualRects.length) return false;
  if (
    !Number.isFinite(g.estimatedBeforeBottom) ||
    g.estimatedBeforeBottom <= g.contentBottom + epsilon
  ) {
    return false;
  }
  const columnFor = (x: number): number =>
    Math.floor((x + g.scrollLeft - g.viewerLeft + epsilon) / g.step);
  const afterColumn = g.afterColumns[0];
  const columnLeft = g.viewerLeft + afterColumn * g.step - g.scrollLeft;
  const columnRight = columnLeft + g.pageWidth;
  for (const rect of g.afterVisualRects) {
    if (
      rect.width <= epsilon ||
      rect.height <= epsilon ||
      columnFor(rect.left) !== afterColumn ||
      rect.left < columnLeft - epsilon ||
      rect.right > columnRight + epsilon
    ) {
      return false;
    }
  }
  const visualBottom = Math.max(...g.afterVisualRects.map((rect) => rect.bottom));
  if (visualBottom > g.contentBottom + epsilon) return false;
  for (const candidate of g.afterVisualRects) {
    for (const previous of g.previousVisualRects) {
      const overlapW = Math.min(candidate.right, previous.right) - Math.max(candidate.left, previous.left);
      const overlapH = Math.min(candidate.bottom, previous.bottom) - Math.max(candidate.top, previous.top);
      if (overlapW > epsilon && overlapH > epsilon) return false;
    }
  }
  return true;
}

/** 书籍常用全角空格/NBSP 把行内色块补到指定视觉列，不应继续参与行尾悬挂空白。 */
export function hasTrailingManualPaddingWhitespace(text: string): boolean {
  // 允许全角/NBSP 后再跟少量普通空格（EPUB 编辑器常混用），但必须
  // 至少出现一个不可折叠宽空白，避免把普通英文行尾空格误判为视觉补齐。
  return /[\u3000\u00a0 ]*[\u3000\u00a0][\u3000\u00a0 ]*$/u.test(text);
}

type InlineBoxVisualStyle = Pick<
  CSSStyleDeclaration,
  | "backgroundColor"
  | "borderLeftStyle"
  | "borderRightStyle"
  | "borderLeftWidth"
  | "borderRightWidth"
  | "paddingLeft"
  | "paddingRight"
>;

/** 是否存在足以让行尾空白具备视觉意义的盒子外观。 */
export function hasVisibleInlineBox(style: InlineBoxVisualStyle): boolean {
  const background = style.backgroundColor.trim().toLowerCase();
  const transparentBackground =
    background === "" ||
    background === "transparent" ||
    /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/u.test(background);
  const hasBorder =
    (style.borderLeftStyle !== "none" && (parseFloat(style.borderLeftWidth) || 0) > 0) ||
    (style.borderRightStyle !== "none" && (parseFloat(style.borderRightWidth) || 0) > 0);
  const hasPadding =
    (parseFloat(style.paddingLeft) || 0) > 0 || (parseFloat(style.paddingRight) || 0) > 0;
  return !transparentBackground || hasBorder || hasPadding;
}

/**
 * 行内盒原子化的纯决策门控。实际 DOM 写回前后都必须通过它：初始条件
 * 防止普通文字被处理，after 条件防止 inline-block 自身仍然越界时留下坏写回。
 */
export function shouldApplyInlineBoxOverflowFix({
  display,
  trailingPaddingWhitespace,
  visibleBox,
  textAlign,
  rectRight,
  containerRight,
  fixedRectRight,
  fixedWidth,
  containerWidth,
}: {
  display: string;
  trailingPaddingWhitespace: boolean;
  visibleBox: boolean;
  textAlign: string;
  rectRight: number;
  containerRight: number;
  fixedRectRight: number;
  fixedWidth: number;
  containerWidth: number;
}): boolean {
  const epsilon = 0.5;
  // `end` is direction-dependent (RTL ends on the left).  This compensation
  // is deliberately conservative until the line direction is part of the
  // geometry contract, so only an explicit physical right alignment qualifies.
  const rightAligned = textAlign.trim().toLowerCase() === "right";
  return (
    display === "inline" &&
    trailingPaddingWhitespace &&
    visibleBox &&
    rightAligned &&
    Number.isFinite(rectRight) &&
    Number.isFinite(containerRight) &&
    rectRight > containerRight + epsilon &&
    Number.isFinite(fixedRectRight) &&
    Number.isFinite(fixedWidth) &&
    Number.isFinite(containerWidth) &&
    fixedRectRight <= containerRight + epsilon &&
    fixedWidth <= containerWidth + epsilon
  );
}

export class ChapterPaginator {
  private blobUrl?: string;
  /** sanitize 本章外链 CSS 产生的局部 Blob URL；不包含 ResourceServer 共享资源。 */
  private chapterCssUrls = new OwnedBlobUrls();
  /** 尚未提交给 iframe 的 sanitize 任务；换章时也必须取消其 URL 所有权。 */
  private pendingCssUrls = new Set<OwnedBlobUrls>();
  private viewer: HTMLElement | null = null;
  private contentDoc: Document | null = null;
  private step = 0;
  private pageWidth = 0;
  /** 本次布局的分栏几何（B 的 computePagedGeometry 结果）。 */
  private spreadGeometry: SpreadGeometry | null = null;
  private spreadLayout: SpreadLayout | null = null;
  /** 本轮实际应用的舒适双页阅读区；回退/单页/滚动为 null。 */
  private spreadArea: SpreadReadingArea | null = null;
  /** 舒适双页根内联样式快照；restore 精确、仅限 reader-owned 属性。 */
  private spreadAreaStyleRestore: (() => void) | null = null;
  private tailSpacer: HTMLElement | null = null;
  private bookmarkSpreadCache = new Map<string, number>();

  get spreadLayoutSnapshot(): SpreadLayout | null {
    return this.spreadLayout;
  }

  private get geometry(): { columns: 1 | 2; columnWidth: number; columnStep: number; viewStep: number } | null {
    if (!this.spreadGeometry) return null;
    return {
      columns: this.spreadGeometry.columns,
      columnWidth: this.spreadGeometry.columnWidth,
      columnStep: this.spreadGeometry.columnStep,
      viewStep: this.spreadGeometry.spreadStep,
    };
  }

  private set geometry(
    g: { columns?: 1 | 2; columnWidth?: number; columnStep?: number; viewStep?: number } | null,
  ) {
    if (g) {
      const cols = g.columns ?? 1;
      const width = g.columnWidth ?? 0;
      const step = g.columnStep ?? width;
      this.spreadGeometry = {
        viewportWidth: width,
        columns: cols,
        gap: 0,
        columnWidth: width,
        columnStep: step,
        spreadStep: g.viewStep ?? cols * step,
      };
    } else {
      this.spreadGeometry = null;
    }
  }
  /** 最近一次完整 measure 使用的 iframe 视口；过滤 ResizeObserver 空转。 */
  private measuredViewport = { width: -1, height: -1 };
  private metrics = { pageCount: 1, currentPage: 0 };
  private loadSeq = 0;
  private disposed = false;
  /** 当前章节登记在 ResourceServer 的资源持有者；换章/销毁时释放。 */
  private resourceHolderId: number | null = null;
  /** Each measure owns its controller; lifecycle aborts all without cross-killing. */
  private measureControllers = new Set<AbortController>();
  private reflowTimer: number | undefined;
  private imgHandler = (): void => this.scheduleReflow();
  private linkHandler = (e: Event): void => this.handleLinkClick(e);
  private wheelHandler = (e: WheelEvent): void => this.handleWheel(e);
  private wheelAcc = 0;
  private scrollWheelAcc = 0;
  private scrollWheelResetTimer: number | undefined;
  private hasNextChapter = true;
  private hasPrevChapter = true;
  private lockedReverseDir: 1 | -1 | 0 = 0;
  private reverseLockUntil = 0;
  private sameDirThrottleUntil = 0;
  private keyHandler = (e: KeyboardEvent): void => this.handleKey(e);
  private footnoteHoverInHandler = (e: Event): void => this.handleFootnoteHoverIn(e);
  private footnoteHoverOutHandler = (e: MouseEvent): void => this.handleFootnoteHoverOut(e);
  private scrollHandler = (): void => this.handleScroll();
  private scrollEndHandler = (): void => {
    if (this.pendingWheelTarget !== null && Math.abs((this.viewer?.scrollTop ?? 0) - this.pendingWheelTarget) < 2) {
      this.cancelScrollAnimation();
    }
  };
  private pointerDownHandler = (): void => this.handleScrollPointerDown();
  private pendingWheelTarget: number | null = null;
  private scrollAnimFrame: number | null = null;
  private noteHighlightsApplied = false;
  private pendingAnchor: string | undefined;
  private pendingFallbackPage: number | null = null;
  private pendingPrecise: PendingPreciseNavigation | null = null;
  private searchHighlightTarget: SearchHighlightTarget | null = null;
  /** Built once after current chapter layout is stable; never spans documents. */
  private textIndex: VisibleTextIndex | null = null;
  private notes: ReaderNoteForPaginator[] = [];
  private selectionContextMenuHandler?: (payload: SelectionContextPayload | null) => void;
  private contextMenuHandler = (e: MouseEvent): void => this.handleContextMenu(e);
  private selectionChangeHandler = (): void => this.handleSelectionChange();
  private selectionContextMenuOpen = false;
  /** 本次加载需要“停在最后一页且翻好页再显示”（回翻上一章防闪页） */
  private pendingStartAtEnd = false;
  private lastState: ChapterState = { status: "loading" };
  /** 最终 display-ready（而非中途 status=ready）结果，供预加载槽位等待。 */
  private displayReadySeq = -1;
  private displayReadyResult = false;
  private displayReadyPromise: Promise<boolean> = Promise.resolve(false);
  /** 连续滚动的重排完成通知；见 setLayoutSettledHandler。 */
  private onLayoutSettled?: () => void;
  private resolveDisplayReady: ((ready: boolean) => void) | null = null;
  private recomputeRetries = 0;
  /** reflow 序号：丢弃过期测量结果，防快速缩放时旧布局覆盖新布局 */
  private reflowSeq = 0;
  /** 最近点击的脚注标记元素（供弹层随重排重新定位） */
  private lastFootnoteEl: HTMLElement | null = null;
  /** 当前脚注是否被点击固定（固定时不随 hover 移出关闭） */
  private footnotePinned = false;
  /** iframe 标记与宿主弹层共享的短暂 hover 交接窗口。 */
  private footnoteHoverGate: FootnoteHoverGate;
  /** 第二遍 margin 处理写回过的元素与原始 inline 值（下次测量前恢复） */
  private marginFixes: Array<{
    el: HTMLElement;
    left: InlineStyleValue;
    right: InlineStyleValue;
    maxWidth?: InlineStyleValue;
  }> = [];
  /**
   * 正文图片/顶层背景图盒局部限宽快照。保存原 inline max-width/priority 与首次读到的
   * 作者 computed 上限（px/Infinity），使重测时不把上轮补丁当作者约束。
   */
  private containedMediaFixes: Array<{
    el: HTMLElement;
    maxWidth: InlineStyleValue;
    authoredMaxWidth: number;
  }> = [];
  /** 页面级百分比间距在重排/换章前完整恢复。 */
  private restorePercentageSpacing: () => void = () => {};
  private inlineClipFixes: Array<{ el: HTMLElement; overflowX: InlineStyleValue }> = [];
  /** fit-content 补偿写回过的元素与原始 inline max-width（下次测量前恢复） */
  private fitContentFixes: Array<{ el: HTMLElement; maxWidth: string }> = [];
  /** float 收缩补偿写回过的元素（下次测量前清除 width） */
  private floatFixes: HTMLElement[] = [];
  /**
   * 顶层浮动布局单元的完整事务快照。与 C-08 的 width 补偿分离，确保
   * margin/max-width/priority 和 marker 在重排、换章、异常路径都可恢复。
   */
  private floatLayoutFixes: Array<{
    el: HTMLElement;
    left: InlineStyleValue;
    right: InlineStyleValue;
    width: InlineStyleValue;
    maxWidth: InlineStyleValue;
  }> = [];
  /** 末尾媒体 float 的临时负 margin-top 写回（每轮测量前恢复）。 */
  private trailingFloatFixes: Array<{ el: HTMLElement; marginTop: InlineStyleValue }> = [];
  /** 行尾悬挂空白导致越过 computed-right 包含块的可见行内盒写回。 */
  private inlineBoxFixes: Array<{
    el: HTMLElement;
    display: InlineStyleValue;
    textIndent: InlineStyleValue;
  }> = [];
  /** 首次布局显示门；token 与 loadSeq 一致，旧章不能揭示新章。 */
  private displayGate: VisibilityGate;
  /** L5 backdrop-filter 分片补偿的完整恢复函数；下一轮测量前必须恢复。 */
  private backdropCompatibilityRestore: (() => void) | null = null;

  /** 滚动模式：viewer 是唯一正文 scroller；分页专用补偿在滚动下不执行。 */
  private scrollStyleRestore: (() => void) | null = null;
  /** 连续宿主接管纵向 pan 时，临时覆盖 viewer 用户滚动；保留原内联值和 priority。 */
  private externalScrollOwnershipRestore: (() => void) | null = null;
  /** 单页分页折叠 body 左右 padding 前的内联值快照。 */
  private parentPaddingRestore: (() => void) | null = null;
  /** 连续滚动 iframe 上下缓冲（见 setContinuousBleed）。 */
  private continuousBleedPx = 0;
  /** 当前 iframe 文档上的横滑清理函数；换章/销毁时必须解除。 */
  private pagedSwipeCleanup: (() => void) | null = null;
  /** 触摸分页时 viewer 改为合成滚动的原内联值快照；null 表示未接管。 */
  private compositedPagedScrollRestore: (() => void) | null = null;
  private compositedPagedScrollViewer: HTMLElement | null = null;
  /**
   * 触摸“滑动”翻页交给原生横向滚动 + scroll-snap：拖动、惯性与落页都由合成线程
   * 逐帧推进。JS 逐帧写 scrollLeft 在 WebView 同步合成下约三成帧重复或跳两步。
   */
  private nativeSnapEnabled = false;
  /** 仅在一次触摸手势内开启吸附，避免重排或程序化滚动被就近吸附。 */
  private nativeSnapArmed = false;
  private nativeSnapScrolled = false;
  /** 原生吸附手势的手指仍在屏幕上。 */
  private nativeSnapTouching = false;
  /** 取消无滚动抬手后的收尾计时器。 */
  private nativeSnapSettleCancel: (() => void) | null = null;
  private nativeSnapLayer: HTMLElement | null = null;
  private nativeSnapKey = "";
  private nativeSnapListenersViewer: HTMLElement | null = null;
  private readonly nativeSnapScrollHandler = (): void => {
    if (!this.nativeSnapArmed) return;
    this.nativeSnapScrolled = true;
    this.scheduleNativeSnapLivePage();
  };
  /** 原生滚动途中已向宿主报告的页（只用于页码显示）；null 表示未报告。 */
  private nativeSnapLivePage: number | null = null;
  private nativeSnapLiveFrame: number | null = null;
  private readonly nativeSnapScrollEndHandler = (): void => this.commitNativeSnap();
  /** 普通轻点检测清理函数；用于手机工具栏显隐。 */
  private plainTapCleanup: (() => void) | null = null;
  /** 最近一次 scroll 事件的 rAF 合并句柄。 */
  private scrollFrame: number | undefined;
  private scrollFrameKind: "raf" | "timer" = "raf";
  /** 滚动进度只在真实变化时发布，同值事件不关闭弹注。 */
  private lastScrollTop = 0;

  /** 阅读位置锚点：中心只是采样坐标，不参与任何分页样式或结构。 */
  private anchor: ReadingAnchor | null = null;
  /** 普通翻页只登记一次下一帧采样；代次/页号不符时丢弃旧结果。 */
  private pendingAnchorFrame: number | null = null;
  private pendingAnchorFrameKind: "raf" | "timer" = "timer";
  private pendingAnchorLoadSeq = -1;
  private pendingAnchorPage = -1;
  /** 导航代次：显式位置提交会作废任何已排队/已出队的旧采样回调。 */
  private anchorSampleEpoch = 0;
  private pendingAnchorEpoch = -1;
  private anchorPath: string | undefined;
  /** 本次加载入口携带的不可变锚点副本（滚动入口定位用）。 */
  private pendingRestoreAnchor: ReadingAnchor | null = null;
  /** 最近一次布局的有效列数（1/2）；窄窗回落结果。 */
  private effectiveColumns: 1 | 2 = 1;
  /** 前置空列数（page-break-before:always 等）；列→屏换算用。 */
  private leadingColumns = 0;
  /** 滚动模式下的虚拟屏数（进度口径，不用于定位）。 */
  private scrollPageCount = 1;
  /** 宿主连续滚动投影状态门，防止投影滚动事件反向触发章内导航或重置。 */
  private isProjectingScroll = false;

  constructor(
    private iframe: HTMLIFrameElement,
    private server: ResourceServer,
    private settings: ReaderSettings,
    private strictXml: boolean,
    private onState: (s: ChapterState) => void,
    private onIssues?: (issues: string[]) => void,
    /** 固定版式书：不做行宽自适应，整页显示 */
    private fixedLayout = false,
    /** 书内链接点击回调（已解析为书内路径，含可选锚点），供阅读器跳转 */
    private onNavigate?: (href: string) => void,
    /** 有效书内链接真正改变位置前通知 UI 记录一次可撤销快照。 */
    private onBeforeInternalNavigate?: (href: string) => void,
    /** 不需要重载章节的同章锚点跳转已同步完成。 */
    private onInternalNavigationSettled?: () => void,
    /** 滚轮翻页回调（累积阈值后触发，1=下一页 -1=上一页） */
    private onWheelNavigate?: (dir: 1 | -1) => void,
    /** 键盘翻页回调（焦点在书页内时也有效） */
    private onKeyNavigate?: (dir: 1 | -1) => void,
    /** 脚注弹层回调（含文本/HTML/固定状态），由阅读器 UI 显示 */
    private onFootnote?: (payload: FootnotePayload) => void,
    /** 桌面端 hover 离开脚注标记时关闭弹层（移动端无 hover，弹层由点击/✕ 关闭） */
    private onFootnoteClose?: () => void,
    /** 外部链接（http/https/mailto/tel）点击回调，由 App 层调系统默认浏览器打开 */
    private onExternalLink?: (url: string) => void,
    /** 首次测量、分页与最终入口定位全部完成，iframe 已可安全交互。 */
    private onDisplayReady?: () => void,
    /** 有效正文选区的现代右键菜单数据；通过 setter 可保持最新 UI 回调。 */
    onSelectionContextMenu?: (payload: SelectionContextPayload | null) => void,
    /** 精确搜索/笔记目标定位结果；未定位不伪装成功。 */
    private onPreciseNavigationStatus?: (status: {
      requestId: number;
      status: PreciseNavigationStatus;
      exact: boolean;
    }) => void,
    /** 正文图片激活（活动章节专用；由 UI 打开独立浮层）。 */
    private onImageActivation?: (image: ImageActivationPayload) => void,
    /** 连续滚动模式外部适配器；提供时滚轮与按键转交宿主，不再触发章末保护链。 */
    private externalScroll?: ExternalScrollAdapter,
    /** 翻页模式单指横滑；连续模式/缓存非活动章由调用方忽略。 */
    private pagedSwipe?: PagedSwipeHandlers,
    /** 手机普通轻点；只表达非交互正文短触，不阻止默认行为。 */
    private onPlainTap?: () => void,
    /** 普通轻点是否当前应忽略；由调用方检查活动章/输入暂停/ready 状态。 */
    private shouldIgnorePlainTap?: () => boolean
  ) {
    this.selectionContextMenuHandler = onSelectionContextMenu;
    this.displayGate = new VisibilityGate(this.iframe, {
      timeoutMs: INITIAL_RENDER_GATE_TIMEOUT_MS,
    });
    this.footnoteHoverGate = new FootnoteHoverGate(() =>
      this.resetFootnote({ notify: true, forceNotify: true })
    );
  }

  setExternalScroll(adapter?: ExternalScrollAdapter): void {
    this.externalScroll = adapter;
    this.applyExternalScrollOwnership();
  }

  /**
   * 连续滚动：宿主让 iframe 比可见视口上下各高出 bleed 像素作缓冲。版面仍按
   * 可见视口排（整页图填满的是可见高度，不是含缓冲的 iframe 高度）；下次测量生效。
   */
  setContinuousBleed(px: number): void {
    this.continuousBleedPx = Number.isFinite(px) && px > 0 ? Math.round(px) : 0;
  }

  /**
   * 连续宿主是唯一用户纵向滚动者时，禁止 iframe viewer 自己消费手指 pan。
   * overflow-y:hidden 仍允许脚本设置 scrollTop，因此投影路径保持可用。
   * 仅在外部适配器存在时生效；原内联值和 !important priority 在退出时恢复。
   */
  private applyExternalScrollOwnership(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    if (!this.externalScroll) {
      this.restoreExternalScrollOwnership();
      return;
    }
    if (!this.externalScrollOwnershipRestore) {
      const value = viewer.style.getPropertyValue("overflow-y");
      const priority = viewer.style.getPropertyPriority("overflow-y");
      this.externalScrollOwnershipRestore = () => {
        if (value) viewer.style.setProperty("overflow-y", value, priority);
        else viewer.style.removeProperty("overflow-y");
      };
    }
    viewer.style.setProperty("overflow-y", "hidden", "important");
  }

  private restoreExternalScrollOwnership(): void {
    this.externalScrollOwnershipRestore?.();
    this.externalScrollOwnershipRestore = null;
  }

  /**
   * 触摸分页的滑动翻页逐帧写 viewer.scrollLeft。overflow:hidden 的容器不走合成
   * 滚动，每帧都要重新栅格化整屏文字，平板上掉到 30–60fps。主指针为触摸时改为
   * overflow-x:scroll（隐藏滚动条、禁止原生横向 pan），滚动偏移交给合成器，
   * 版面与分页几何不变；鼠标/触控板为主的桌面不接管，避免原生横向滚动绕过分页。
   */
  /** 主指针为触摸（手机/平板）：滑动翻页的观感优先。 */
  private prefersTouchPaging(): boolean {
    try {
      return this.contentDoc?.defaultView?.matchMedia?.("(pointer: coarse)").matches === true;
    } catch {
      return false;
    }
  }

  private applyCompositedPagedScroll(): void {
    const viewer = this.viewer;
    const coarse = this.prefersTouchPaging();
    if (!viewer || !this.pagedSwipe || this.scrollMode || !coarse) {
      this.restoreCompositedPagedScroll();
      return;
    }
    if (this.compositedPagedScrollViewer === viewer) {
      this.syncNativeSnapViewer();
      return;
    }
    // 换章后旧 viewer 随旧文档丢弃，快照不再回写。
    this.compositedPagedScrollRestore = null;
    const properties = ["overflow-x", "scrollbar-width", "touch-action"] as const;
    const snapshot = properties.map((property) => ({
      property,
      value: viewer.style.getPropertyValue(property),
      priority: viewer.style.getPropertyPriority(property),
    }));
    const scrollLeft = viewer.scrollLeft;
    viewer.style.setProperty("overflow-x", "scroll", "important");
    viewer.style.setProperty("scrollbar-width", "none");
    viewer.style.setProperty("touch-action", "pan-y pinch-zoom");
    viewer.scrollLeft = scrollLeft;
    this.compositedPagedScrollRestore = () => {
      const left = viewer.scrollLeft;
      for (const item of snapshot) {
        if (item.value) viewer.style.setProperty(item.property, item.value, item.priority);
        else viewer.style.removeProperty(item.property);
      }
      viewer.scrollLeft = left;
    };
    this.compositedPagedScrollViewer = viewer;
    this.syncNativeSnapViewer();
  }

  private restoreCompositedPagedScroll(): void {
    this.teardownNativeSnap();
    if (this.compositedPagedScrollViewer === this.viewer) this.compositedPagedScrollRestore?.();
    this.compositedPagedScrollRestore = null;
    this.compositedPagedScrollViewer = null;
  }

  /** 宿主按翻页动画设置开关（仅“滑动”）；关闭时恢复 JS 跟手。 */
  setNativeSnapPaging(enabled: boolean): void {
    this.nativeSnapEnabled = enabled;
    this.syncNativeSnapViewer();
  }

  private nativeSnapAvailable(): boolean {
    const viewer = this.viewer;
    const win = this.contentDoc?.defaultView as (Window & { onscrollend?: unknown }) | null | undefined;
    return Boolean(
      this.nativeSnapEnabled && viewer && !this.scrollMode && !this.disposed &&
      this.compositedPagedScrollViewer === viewer && win && "onscrollend" in win,
    );
  }

  /** 横向 pan 与 scrollend 监听随 viewer 与开关同步。 */
  private syncNativeSnapViewer(): void {
    const viewer = this.viewer;
    if (!this.nativeSnapAvailable() || !viewer) {
      this.teardownNativeSnap();
      if (viewer && this.compositedPagedScrollViewer === viewer && !this.scrollMode) {
        viewer.style.setProperty("touch-action", "pan-y pinch-zoom", "important");
      }
      return;
    }
    viewer.style.setProperty("touch-action", "pan-x pan-y pinch-zoom", "important");
    viewer.style.setProperty("overscroll-behavior-x", "contain");
    if (this.nativeSnapListenersViewer !== viewer) {
      this.removeNativeSnapListeners();
      viewer.addEventListener("scroll", this.nativeSnapScrollHandler, { passive: true });
      viewer.addEventListener("scrollend", this.nativeSnapScrollEndHandler);
      this.nativeSnapListenersViewer = viewer;
    }
  }

  private removeNativeSnapListeners(): void {
    const viewer = this.nativeSnapListenersViewer;
    if (!viewer) return;
    viewer.removeEventListener("scroll", this.nativeSnapScrollHandler);
    viewer.removeEventListener("scrollend", this.nativeSnapScrollEndHandler);
    this.nativeSnapListenersViewer = null;
  }

  private teardownNativeSnap(): void {
    this.disarmNativeSnap();
    this.removeNativeSnapListeners();
    this.nativeSnapLayer?.remove();
    this.nativeSnapLayer = null;
    this.nativeSnapKey = "";
  }

  /** 同章各屏的 scrollLeft 起点（双页跨页按 spread 起点）。 */
  private nativeSnapOffsets(): number[] {
    const count = this.metrics.pageCount;
    const offsets: number[] = [];
    if (this.spreadLayout) {
      for (let i = 0; i < count; i++) offsets.push(spreadStart(this.spreadLayout, i));
      return offsets;
    }
    const step = this.viewStepPx;
    if (!(step > 0)) return offsets;
    for (let i = 0; i < count; i++) offsets.push(i * step);
    return offsets;
  }

  /** 原生滚动能否接手该方向：同章还有相邻屏才交给原生，章首/章尾仍走 JS 跨章。 */
  canNativeScroll(direction: 1 | -1): boolean {
    if (!this.nativeSnapAvailable() || !this.viewer) return false;
    const offsets = this.nativeSnapOffsets();
    if (offsets.length < 2) return false;
    const left = this.viewer.scrollLeft;
    return direction === 1 ? left < offsets[offsets.length - 1] - 1 : left > offsets[0] + 1;
  }

  /** 手指按下：按当前排版放置吸附点（零尺寸裁剪层，不撑大 scrollWidth）并开启吸附。 */
  beginNativeSnapGesture(): void {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (!this.nativeSnapAvailable() || !viewer || !doc) return;
    const offsets = this.nativeSnapOffsets();
    if (offsets.length < 2) return;
    const key = offsets.map((value) => value.toFixed(2)).join(",");
    if (!this.nativeSnapLayer || this.nativeSnapLayer.parentNode !== viewer || this.nativeSnapKey !== key) {
      this.nativeSnapLayer?.remove();
      const layer = doc.createElement("epub-snap-points");
      layer.setAttribute("aria-hidden", "true");
      layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:clip;pointer-events:none;";
      for (const offset of offsets) {
        const point = doc.createElement("span");
        point.style.cssText = `position:absolute;top:0;left:${offset}px;width:1px;height:1px;scroll-snap-align:start;scroll-snap-stop:always;`;
        layer.appendChild(point);
      }
      viewer.appendChild(layer);
      this.nativeSnapLayer = layer;
      this.nativeSnapKey = key;
    }
    this.nativeSnapScrolled = false;
    this.nativeSnapTouching = true;
    this.clearNativeSnapSettle();
    if (!this.nativeSnapArmed) {
      viewer.style.setProperty("scroll-snap-type", "x mandatory");
      this.nativeSnapArmed = true;
    }
  }

  /**
   * 手指抬起。本手势有原生滚动时等 scrollend 提交；没有时也不能立刻撤吸附：
   * 上一次甩动/吸附动画可能仍在合成线程上进行（快速连翻时轻点会先打断再
   * 续上），此刻撤掉 scroll-snap-type 会把动画截停在两页之间，或让屏幕停在
   * 旧帧。短暂等待：期间出现滚动就交给 scrollend，否则按落点收尾。
   */
  endNativeSnapGesture(): void {
    this.nativeSnapTouching = false;
    if (!this.nativeSnapArmed || this.nativeSnapScrolled) return;
    this.clearNativeSnapSettle();
    const win = this.contentDoc?.defaultView;
    if (!win || typeof win.setTimeout !== "function") {
      this.commitNativeSnap();
      return;
    }
    const handle = win.setTimeout(() => {
      this.nativeSnapSettleCancel = null;
      if (this.nativeSnapArmed && !this.nativeSnapScrolled && !this.nativeSnapTouching) this.commitNativeSnap();
    }, NATIVE_SNAP_SETTLE_MS);
    this.nativeSnapSettleCancel = () => win.clearTimeout(handle);
  }

  private clearNativeSnapSettle(): void {
    const cancel = this.nativeSnapSettleCancel;
    this.nativeSnapSettleCancel = null;
    cancel?.();
  }

  /**
   * 原生滚动途中按最近的屏实时报告页码：连续翻页时 scrollend 要等全部停下才来，
   * 只在提交时更新会让底栏页码停在起点。每帧最多算一次、只在跨过半屏换页时
   * 才发状态（一次翻页约一次，与 JS 翻页同频）；不改 metrics、不采样锚点，
   * 正式提交仍由 commitNativeSnap 完成。
   */
  private scheduleNativeSnapLivePage(): void {
    const win = this.contentDoc?.defaultView;
    if (this.nativeSnapLiveFrame !== null || !win || typeof win.requestAnimationFrame !== "function") return;
    this.nativeSnapLiveFrame = win.requestAnimationFrame(() => {
      this.nativeSnapLiveFrame = null;
      if (!this.nativeSnapArmed || !this.viewer || this.disposed) return;
      const page = this.nearestNativeSnapPage();
      if (page === null) return;
      if (page === (this.nativeSnapLivePage ?? this.metrics.currentPage)) return;
      this.nativeSnapLivePage = page;
      this.emit({ ...this.readyState(false, page), transient: true } as ChapterState);
    });
  }

  private nearestNativeSnapPage(): number | null {
    if (!this.viewer) return null;
    const offsets = this.nativeSnapOffsets();
    if (offsets.length === 0) return null;
    const left = this.viewer.scrollLeft;
    let page = 0;
    for (let i = 1; i < offsets.length; i++) {
      if (Math.abs(offsets[i] - left) < Math.abs(offsets[page] - left)) page = i;
    }
    return page;
  }

  private clearNativeSnapLivePage(): void {
    if (this.nativeSnapLiveFrame !== null) {
      this.contentDoc?.defaultView?.cancelAnimationFrame?.(this.nativeSnapLiveFrame);
      this.nativeSnapLiveFrame = null;
    }
    this.nativeSnapLivePage = null;
  }

  private disarmNativeSnap(): void {
    this.clearNativeSnapSettle();
    this.clearNativeSnapLivePage();
    if (!this.nativeSnapArmed) return;
    this.nativeSnapArmed = false;
    this.nativeSnapScrolled = false;
    this.nativeSnapListenersViewer?.style.removeProperty("scroll-snap-type");
    this.viewer?.style.removeProperty("scroll-snap-type");
  }

  /**
   * 原生滚动与吸附动画结束：按落点提交页码（关闭弹注、发布进度、采样锚点）。
   * 手指仍按着时（新手势打断了上一次甩动）不提交，等抬手后再收尾，否则本
   * 手势剩余的原生滚动会在没有吸附的情况下停在任意位置。
   */
  private commitNativeSnap(): void {
    if (!this.nativeSnapArmed || !this.viewer || this.nativeSnapTouching) return;
    const offsets = this.nativeSnapOffsets();
    const left = this.viewer.scrollLeft;
    const page = this.nearestNativeSnapPage() ?? 0;
    const livePage = this.nativeSnapLivePage;
    this.disarmNativeSnap();
    if (offsets.length === 0) return;
    if (page !== this.metrics.currentPage || Math.abs(offsets[page] - left) > 0.5) this.setPage(page);
    // 途中报告过别的页、最后又落回原页时 setPage 不会再发状态，这里补一次。
    else if (livePage !== null && livePage !== page) this.emit(this.readyState(false));
  }

  /**
   * 连续滚动订阅：滚动模式下每次重排（窗口尺寸变化、图片晚加载触发的
   * scheduleReflow）完成最终测量后回调，宿主据此重测章节真实高度。
   * 只表示“本章布局已稳定”，不重复报告首次 display-ready。
   */
  setLayoutSettledHandler(handler?: () => void): void {
    this.onLayoutSettled = handler;
  }

  /**
   * 当前 iframe 视口是否已经完成过一次分页器测量。
   * 连续视图在宿主尺寸变化后必须先等本方法为真再提交章节高度：否则会把
   * iframe 刚改高度、内容尚未重排完的中间值当成真实内容高写进布局表。
   */
  isMeasuredForViewport(): boolean {
    return (
      this.iframe.clientWidth === this.measuredViewport.width &&
      this.iframe.clientHeight === this.measuredViewport.height
    );
  }

  setSelectionContextMenuHandler(handler?: (payload: SelectionContextPayload | null) => void): void {
    this.selectionContextMenuHandler = handler;
  }

  /** 清除 iframe 内原生文本选区（关闭选区菜单或进入笔记编辑时使用）。 */
  clearTextSelection(): void {
    this.selectionContextMenuOpen = false;
    this.contentDoc?.getSelection()?.removeAllRanges();
    this.selectionContextMenuHandler?.(null);
  }

  /** 当前设置是否为滚动模式（fixedLayout 由调用方归一化为 paginated）。 */
  private get scrollMode(): boolean {
    return this.settings?.readingMode === "scroll";
  }


  /**
   * 物理列宽：双栏时是单列宽，不是整屏宽；由 B 的几何唯一决定。
   */
  private get effectiveColumnWidth(): number {
    return this.spreadGeometry?.columnWidth ?? this.pageWidth;
  }


  /** 图片的最近非 inline 块级包含盒；inline 链接必须上溯，不能用 clientWidth=0。 */
  private getMediaContainingBlock(img: HTMLElement, win: Window): HTMLElement {
    const viewer = this.viewer as HTMLElement;
    let node = img.parentElement;
    while (node && node !== viewer) {
      const display = win.getComputedStyle(node).display.trim().toLowerCase();
      // inline-block/inline-flex 等本身建立包含块，不能当纯 inline 链接跳过；
      // 只有无自身宽度的 inline/ruby/contents 需要继续上溯。
      if (display !== "inline" && display !== "ruby" && display !== "ruby-text" && display !== "contents") {
        return node;
      }
      node = node.parentElement;
    }
    return viewer;
  }

  /** computed max-width 只在明确为 px 或 none 时进入计算；未知表达式保守跳过。 */
  private parseAuthoredMediaMaxWidth(value: string): number | undefined {
    const normalized = value.trim().toLowerCase();
    if (normalized === "none") return Infinity;
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)px$/u.test(normalized)) return undefined;
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
  }

  private get effectiveColumnStep(): number {
    return this.spreadGeometry?.columnStep ?? this.step ?? this.pageWidth + this.settings.gapPx;
  }

  private get effectiveViewStep(): number {
    return this.spreadGeometry?.spreadStep ?? this.effectiveColumnStep;
  }

  private scrollMetrics(): ScrollMetrics {
    const viewer = this.viewer;
    if (!viewer) return { contentHeight: 0, viewportHeight: 0 };
    return { contentHeight: viewer.scrollHeight, viewportHeight: viewer.clientHeight };
  }

  setNotes(notes: ReaderNoteForPaginator[]): "applied" | "unsupported" | "deferred" {
    const isSame =
      this.notes.length === notes.length &&
      this.notes.every(
        (n, i) =>
          n.id === notes[i].id &&
          n.startTextOffset === notes[i].startTextOffset &&
          n.endTextOffset === notes[i].endTextOffset
      );
    this.notes = notes.slice();
    if (!this.contentDoc || !this.viewer || !this.textIndex) return "deferred";
    if (isSame && this.noteHighlightsApplied) {
      return "applied";
    }
    const result = this.applyNoteHighlights();
    if (result === "applied") {
      this.noteHighlightsApplied = true;
    }
    return result;
  }

  async load(path: string, opts: LoadOptions = {}): Promise<void> {
    this.pendingWheelTarget = null;
    this.noteHighlightsApplied = false;
    if (opts.settings) this.settings = opts.settings;
    if (opts.hasNextChapter !== undefined) {
      this.hasNextChapter = opts.hasNextChapter;
    }
    if (opts.hasPrevChapter !== undefined) {
      this.hasPrevChapter = opts.hasPrevChapter;
    }
    this.scrollWheelAcc = 0;
    this.abortMeasureWaits();
    const seq = ++this.loadSeq;
    this.cancelPendingAnchorSample?.();
    this.displayReadySeq = -1;
    this.displayReadyResult = false;
    this.resolveDisplayReady?.(false);
    this.displayReadyPromise = new Promise<boolean>((resolve) => {
      this.resolveDisplayReady = resolve;
    });
    this.disposed = false;
    this.recomputeRetries = 0;
    // 换章加载：丢弃旧锚点与旧页号（页号只对同章重排有意义，
    // 否则新章会沿袭上一章的页号，如"上一章13页→下一章也跳到第13页"）。
    // 目录里点击当前章（同章 + resetPage）：同样从开头/锚点重新开始。
    if (path !== this._currentPath || opts.resetPage) {
      this.anchor = null;
      this.anchorPath = undefined;
      this.metrics.currentPage = 0;
    }
    let preciseAnchor: ReadingAnchor | null = null;
    if (opts.readingAnchor) {
      preciseAnchor = this.setReadingAnchor(path, opts.readingAnchor);
    }
    this._currentPath = path;
    this.pendingAnchor = opts.anchor;
    this.pendingStartAtEnd = opts.startAtEnd === true;
    // blob 文档可能在下一个绘制帧立刻出现；先隐藏整个 iframe，既保留
    // 布局测量，又避免普通入口先显示二阶段补偿前的中间位置。
    this.displayGate.hold(seq);
    this.emit({ status: "loading" });
    this.iframe.removeEventListener("load", this.onIframeLoad);
    this.cleanupDoc();
    this.searchHighlightTarget = opts.preserveSearchHighlight
      ? {
          requestId: opts.preserveSearchHighlight.requestId,
          textHits: opts.preserveSearchHighlight.textHits.map((hit) => ({ ...hit })),
          occurrence: cloneSearchOccurrence(opts.preserveSearchHighlight.occurrence),
        }
      : null;
    this.pendingPrecise = opts.preciseNavigation
      ? { request: opts.preciseNavigation, anchor: preciseAnchor ? { ...preciseAnchor } : null }
      : null;
    this.pendingFallbackPage =
      typeof opts.fallbackPage === "number" && Number.isSafeInteger(opts.fallbackPage) && opts.fallbackPage >= 0
        ? opts.fallbackPage
        : null;
    // 恢复锚点与页码兜底一样，必须在 cleanupDoc() 之后写入：cleanupDoc 会清空
    // 上一份阅读态，写到它前面会被自己刚做的清理抹掉（滚动模式曾因此永远走页码兜底）。
    this.pendingRestoreAnchor = preciseAnchor ? { ...preciseAnchor } : null;
    this.iframe.src = "about:blank";
    // 旧 iframe 已开始卸载后才退还资源持有者：如果这是最后一个持有者，
    // LRU 淘汰不会撤销仍在显示的图片/字体 URL。
    this.releaseResourceHolder();

    // 资源准备与持有者登记必须是一次原子 acquire：递归发现 @import/url()
    // 期间，已经加载的依赖不会被预算淘汰；过期/失败时由原 ResourceServer 释放。
    const server = this.server;
    const acquireChapter = server.acquireChapter?.bind(server);
    const holderId: number | null = acquireChapter ? await acquireChapter(path) : null;
    if (holderId !== null && (seq !== this.loadSeq || this.disposed)) {
      server.releaseHolder?.(holderId);
      return;
    }
    this.resourceHolderId = holderId;

    const htmlText = this.server.textFor(path);
    if (htmlText === undefined) {
      this.releaseResourceHolder(holderId);
      this.emit({ status: "error", message: `章节资源缺失：${path}` });
      this.finishDisplayReady(seq, false);
      this.displayGate.release(seq);
      return;
    }

    // CSS Blob URL 的所有权只在本次 sanitize/load 内；提交 iframe 前仍属于
    // 局部任务，任何过期/异常路径都必须在这里回收。
    const ownedCssUrls = new OwnedBlobUrls();
    this.pendingCssUrls.add(ownedCssUrls);
    let sanitized;
    try {
      sanitized = await sanitizeChapter(htmlText, {
        basePath: path,
        strictXml: this.strictXml,
        urlFor: (p) => this.server.urlFor(p),
        getText: (p) => this.server.textFor(p),
        makeUrl: (text, mediaType) =>
          ownedCssUrls.add(URL.createObjectURL(new Blob([text], { type: mediaType }))),
        settings: this.settings,
      });
    } catch (e) {
      this.releaseResourceHolder(holderId);
      this.pendingCssUrls.delete(ownedCssUrls);
      ownedCssUrls.revokeAll();
      if (seq === this.loadSeq) {
        this.emit({ status: "error", message: `章节渲染失败：${(e as Error).message}` });
        this.finishDisplayReady(seq, false);
        this.displayGate.release(seq);
      }
      return;
    }
    if (seq !== this.loadSeq || this.disposed) {
      this.releaseResourceHolder(holderId);
      this.pendingCssUrls.delete(ownedCssUrls);
      ownedCssUrls.revokeAll();
      return;
    }
    let nextBlobUrl: string | undefined;
    try {
      nextBlobUrl = URL.createObjectURL(
        new Blob([sanitized.html], { type: "text/html; charset=utf-8" })
      );
      // iframe.src 提交是本次局部 CSS URL 转为当前章节所有权的边界。
      this.pendingCssUrls.delete(ownedCssUrls);
      this.chapterCssUrls = ownedCssUrls;
      this.blobUrl = nextBlobUrl;
      this.iframe.addEventListener("load", this.onIframeLoad);
      this.iframe.src = nextBlobUrl;
      if (sanitized.issues.length > 0) this.onIssues?.(sanitized.issues);
    } catch (e) {
      this.releaseResourceHolder(holderId);
      this.pendingCssUrls.delete(ownedCssUrls);
      ownedCssUrls.revokeAll();
      if (nextBlobUrl) URL.revokeObjectURL(nextBlobUrl);
      this.iframe.removeEventListener("load", this.onIframeLoad);
      if (this.blobUrl === nextBlobUrl) this.blobUrl = undefined;
      if (this.chapterCssUrls === ownedCssUrls) this.chapterCssUrls = new OwnedBlobUrls();
      if (seq === this.loadSeq && !this.disposed) {
        this.emit({ status: "error", message: `章节渲染失败：${(e as Error).message}` });
        this.finishDisplayReady(seq, false);
        this.displayGate.release(seq);
      }
      return;
    }
    // sanitize 较慢或快速换章时重新计算兜底时间；原 visibility 快照保持不变。
    this.displayGate.hold(seq);
  }

  private onIframeLoad = (): void => {
    const seq = this.loadSeq;
    if (this.disposed || !this.blobUrl || this.iframe.src !== this.blobUrl) return; // 忽略 about:blank 或已被取代的过期 load
    const doc = this.iframe.contentDocument;
    if (!doc) {
      this.emit({ status: "error", message: "无法访问章节内容" });
      this.finishDisplayReady(seq, false);
      this.displayGate.release(seq);
      return;
    }
    this.contentDoc = doc;
    const viewer = doc.getElementById(VIEWER_ID);
    if (!viewer) {
      this.emit({ status: "error", message: "章节缺少阅读器容器" });
      this.finishDisplayReady(seq, false);
      this.displayGate.release(seq);
      return;
    }
    this.viewer = viewer;
    this.applyExternalScrollOwnership();
    if (this.pagedSwipe && !this.scrollMode) {
      this.pagedSwipeCleanup?.();
      this.pagedSwipeCleanup = installPagedSwipe(doc, {
        onNext: () => this.pagedSwipe?.onNext(),
        onPrev: () => this.pagedSwipe?.onPrev(),
        shouldIgnore: (event) => this.pagedSwipe?.shouldIgnore(event) ?? true,
        onPreview: (dx) => this.pagedSwipe?.onPreview?.(dx),
        onGestureStart: () => {
          this.pagedSwipe?.onGestureStart?.();
          this.beginNativeSnapGesture();
        },
        nativeScroll: (direction) => this.canNativeScroll(direction),
        onGestureEnd: () => this.endNativeSnapGesture(),
        gestureSurface: viewer,
      });
    }
    this.applyCompositedPagedScroll();
    if (this.onPlainTap) {
      this.plainTapCleanup?.();
      this.plainTapCleanup = installPlainTap(doc, {
        onTap: () => this.onPlainTap?.(),
        shouldIgnore: () => this.shouldIgnorePlainTap?.() ?? false,
      });
    }
    const atEnd = this.pendingStartAtEnd;
    // 从真实 iframe load 重新开始兜底计时。显示门挂在 iframe 而非 viewer，
    // 可保证 blob 文档的第一帧也不会漏出，同时 visibility:hidden 仍可测量。
    this.displayGate.hold(seq);
    this.emit({ status: "measuring" });
    if (this.settings.theme === "dark" || this.settings.theme === "gray") {
      try {
        applyDarkThemeContrast(doc, { theme: this.settings.theme });
      } catch {
        // Contrast repair is conservative and must never block chapter display.
      }
    }
    doc.addEventListener("load", this.imgHandler, true);
    // 拦截书内链接：防止 iframe 自身导航导致内容丢失
    doc.addEventListener("click", this.linkHandler, true);
    // 固定脚注：点击正文空白处关闭（标记点击由 linkHandler 处理）
    doc.addEventListener("click", this.handleDocClick, true);
    // 桌面 hover 弹注（script.js 的鼠标行为）；移动端无 hover，走 click/touch
    doc.addEventListener("mouseover", this.footnoteHoverInHandler, true);
    doc.addEventListener("mouseout", this.footnoteHoverOutHandler, true);
    // 滚轮翻页（内容不可滚动，事件冒泡到文档即可捕获）
    doc.addEventListener("wheel", this.wheelHandler, { passive: false });
    // 键盘翻页：焦点在书页内时，方向键事件不会冒泡到主窗口，需在此监听
    doc.addEventListener("keydown", this.keyHandler);
    // 滚动模式：viewer 自身滚动，一帧一次更新位置；真实 pointerdown 关闭弹注。
    doc.addEventListener("scroll", this.scrollHandler, true);
    doc.addEventListener("scrollend", this.scrollEndHandler, true);
    doc.addEventListener("pointerdown", this.pointerDownHandler, true);
    // 阅读器内始终屏蔽浏览器原生右键菜单；只有有效正文选区才回调 UI。
    doc.addEventListener("contextmenu", this.contextMenuHandler);
    doc.addEventListener("selectionchange", this.selectionChangeHandler);
    void this.prepareChapterForDisplay(seq, atEnd)
      .then((prepared) => {
        if (!prepared || seq !== this.loadSeq || this.disposed) {
          if (seq === this.loadSeq && this.disposed === false) this.finishDisplayReady(seq, false);
          return;
        }
        // 先解除显示门，再通知 UI 消费加载期输入；这样缓冲翻页不会在
        // 锚点/章末定位之前执行，也不会依赖中途的 ready 状态事件。
        this.displayGate.release(seq);
        this.finishDisplayReady(seq, true);
        this.onDisplayReady?.();
      })
      .catch((error: unknown) => {
        if (seq === this.loadSeq && !this.disposed) {
          this.emit({
            status: "error",
            message: `章节布局失败：${error instanceof Error ? error.message : String(error)}`,
          });
          this.finishDisplayReady(seq, false);
        }
      })
      .finally(() => this.displayGate.release(seq));
  };

  /**
   * 首次章节 ready 边界：后续预渲染可以复用同一顺序，但本轮仍只准备主 iframe。
   * 返回前已经完成自愈重试与最终入口定位，调用方随后才可揭示内容。
   */
  private async prepareChapterForDisplay(seq: number, atEnd: boolean): Promise<boolean> {
    if (!(await this.measure(seq))) return false;
    if (seq !== this.loadSeq || this.disposed) return false;
    if (!this.scrollMode) {
      this.rebuildTextIndexForCurrentDoc();
    }
    const ready = await this.recompute(true, seq);
    if (!ready || seq !== this.loadSeq || this.disposed) return false;

    // Exact search/note targets must be resolved before the display gate is
    // released.  A failed exact match may remain at its reference anchor, but
    // it is never reported as a located highlight.
    const preciseStatus = this.applyPendingPreciseNavigation();
    // 目录跳转：最终页数稳定后定位到锚点所在页。
    if (preciseStatus === null && this.pendingAnchor) {
      this.jumpToAnchor(this.pendingAnchor);
      this.pendingAnchor = undefined;
    }
    if (atEnd && !this.scrollMode) {
      this.pendingStartAtEnd = false;
      this.setPage(Math.max(0, this.metrics.pageCount - 1));
    }
    return true;
  }

  /** 最终显示门已解除且入口定位完成。 */
  get isDisplayReady(): boolean {
    return this.displayReadySeq === this.loadSeq && this.displayReadyResult;
  }

  /** 等待当前（或指定代次）章节完成最终 display-ready。 */
  waitForDisplayReady(expectedLoadSeq: number = this.loadSeq): Promise<boolean> {
    if (expectedLoadSeq !== this.loadSeq) return Promise.resolve(false);
    if (this.displayReadySeq === expectedLoadSeq) return Promise.resolve(this.displayReadyResult);
    return this.displayReadyPromise;
  }

  /** 加载并等待最终 display-ready；预加载器不得只等待 iframe load。 */
  async loadAndWaitForDisplay(path: string, opts: LoadOptions = {}): Promise<boolean> {
    const loading = this.load(path, opts);
    const expectedLoadSeq = this.loadSeq;
    await loading;
    return this.waitForDisplayReady(expectedLoadSeq);
  }

  private finishDisplayReady(seq: number, ready: boolean): void {
    if (seq !== this.loadSeq || this.displayReadySeq === seq) return;
    this.displayReadySeq = seq;
    this.displayReadyResult = ready;
    const resolve = this.resolveDisplayReady;
    this.resolveDisplayReady = null;
    resolve?.(ready);
  }


  private async measure(expectedLoadSeq: number = this.loadSeq): Promise<boolean> {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (
      !doc ||
      !viewer ||
      !isChapterMeasurementCurrent({
        disposed: this.disposed,
        loadSeq: this.loadSeq,
        expectedLoadSeq,
        contentDoc: this.contentDoc,
        expectedDoc: doc,
        viewer: this.viewer,
        expectedViewer: viewer,
      })
    ) {
      return false;
    }
    const win = doc.defaultView;
    const measuredWidth = this.iframe.clientWidth;
    const measuredHeight = this.iframe.clientHeight;
    // 舒适双页的根内联样式先精确恢复，再恢复其余二阶段补偿。
    this.restoreSpreadReadingAreaStyles();
    // 第二遍 margin / fit-content 处理写回的 inline 值要先恢复，
    // 避免字号/窗口变化后按旧值布局
    this.restoreInlineBoxFixes();
    this.restoreFloatLayoutFixes();
    this.restoreBookMargins();
    this.restoreContainedMediaFixes();
    this.restoreFitContentFix();
    this.restoreFloatWidths();
    this.restoreTrailingFloatFixes();
    this.restorePercentageSpacing();
    this.restorePercentageSpacing = applyReaderRootPercentageSpacing(
      doc,
      viewer,
      TEXT_MEASURE.maxEm * this.settings.fontSizePx,
    );
    const parent = viewer.parentElement;
    const parentCs = parent && doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
    const baseW = parent?.clientWidth || this.iframe.clientWidth || viewer.clientWidth;
    // 书可能声明 body padding（如 LK 的 0 5px），分页宽度要用内容区宽度，
    // 否则 viewer 会溢出 body 右侧，出现横向滚动条。
    const pageW = Math.max(
      0,
      baseW -
        (parseFloat(parentCs?.paddingLeft ?? "") || 0) -
        (parseFloat(parentCs?.paddingRight ?? "") || 0)
    );
    const baseH = parent?.clientHeight || this.iframe.clientHeight || viewer.clientHeight;
    const pageH = Math.max(
      0,
      baseH -
        (parseFloat(parentCs?.paddingTop ?? "") || 0) -
        (parseFloat(parentCs?.paddingBottom ?? "") || 0)
    );
    const em = this.settings.fontSizePx;
    // [页面选项] 四边距只在这里扣一次：left/right 缩小可用宽度，而不是额外
    // 给 viewer 再叠加一层水平留白；top/bottom 有显式值时取代旧 em 默认。
    const margins = this.settings.pageMarginsPx ?? {};
    const gap = this.settings.gapPx;
    const h = pageH;
    const scrollMode = this.scrollMode;
    // 旧单页/滚动语义保留：滚动左右默认 16px；分页左右无显式值时宽屏为 0，
    // 窄屏（手机竖屏）用 autoPageMarginsPx 的紧凑口径，避免正文贴边。
    const compactAuto = !scrollMode && !this.fixedLayout && pageW > 0 && pageW < COMPACT_PAGE_WIDTH_PX;
    const autoMargins = autoPageMarginsPx(em, compactAuto);
    const marginLeft = Math.max(0, margins.left ?? (scrollMode ? 16 : this.fixedLayout ? 0 : autoMargins.left));
    const marginRight = Math.max(0, margins.right ?? (scrollMode ? 16 : this.fixedLayout ? 0 : autoMargins.right));
    const legacyW = scrollMode ? pageW : Math.max(0, pageW - marginLeft - marginRight);
    // 极窄/矮窗口只缩小有效留白以留出正文，不修改保存值。
    const requestedTop = margins.top !== undefined
      ? Math.max(0, margins.top)
      : this.fixedLayout ? 0 : scrollMode ? 12 : compactAuto ? autoMargins.top : TEXT_MEASURE.vTopEm * em;
    const requestedBottom = margins.bottom !== undefined
      ? Math.max(0, margins.bottom)
      : this.fixedLayout ? 0 : scrollMode ? 12 : compactAuto ? autoMargins.bottom : TEXT_MEASURE.vBottomEm * em;
    const verticalBudget = Math.max(0, pageH - 2 * em);
    const verticalScale = requestedTop + requestedBottom > verticalBudget && requestedTop + requestedBottom > 0
      ? verticalBudget / (requestedTop + requestedBottom)
      : 1;
    // 纯图片页（封面/插图，无文字）：不加上下留白，整页显示
    const hasText = (viewer.textContent ?? "").trim().length > 0;
    const hasImg = viewer.querySelector("img") !== null;
    const pureImagePage = !this.fixedLayout && !hasText && hasImg;
    const viewerClasses = viewer.classList;
    const fullpageVisual =
      viewerClasses?.contains?.("fullpage-image") === true ||
      viewerClasses?.contains?.("pure-image-page") === true;
    const onlyChildClass =
      viewer.children.length === 1
        ? (viewer.firstElementChild as HTMLElement | null)?.className ?? ""
        : "";
    const fullpageChild =
      typeof onlyChildClass === "string" &&
      /(?:^|\s)(?:illus|kuchie|cover|duokan-image-fullscreen)(?:\s|$)/u.test(onlyChildClass);
    const padTop = pureImagePage ? 0 : Math.round(requestedTop * verticalScale);
    const padBottom = pureImagePage ? 0 : Math.round(requestedBottom * verticalScale);
    const requestedColumns = this.fixedLayout || scrollMode ? 1 : this.settings.columnsPerView === 2 ? 2 : 1;

    // 舒适双页仅用于普通横排 LTR 可重排正文；eligible 与预算是否足够分开：
    // 非横排/RTL/纯图 eligible=false，仍走原 requestedColumns 路径；
    // eligible=true 但核心返回 null 才是窄窗/大字号单页回退。
    const comfortSpreadRequested =
      requestedColumns === 2 && hasText && !pureImagePage && !fullpageVisual && !fullpageChild;
    let comfortEligible = false;
    if (comfortSpreadRequested) {
      try {
        const viewerCs = win?.getComputedStyle(viewer);
        comfortEligible =
          viewerCs?.writingMode.trim().toLowerCase() === "horizontal-tb" &&
          viewerCs?.direction.trim().toLowerCase() === "ltr";
      } catch {
        comfortEligible = false;
      }
    }
    let comfortArea: SpreadReadingArea | null = null;
    if (comfortEligible) {
      const viewerInsets = this.readViewerHorizontalInsets(viewer, win);
      comfortArea = resolveSpreadReadingArea({
        availableWidth: pageW,
        fontSizePx: em,
        viewerInsetLeft: viewerInsets.left,
        viewerInsetRight: viewerInsets.right,
        leftPx: margins.left,
        rightPx: margins.right,
        // auto 时忽略 gapPx；manual（含显式 0）才把数值交给核心。
        gapPx: this.settings.spreadGapMode === "manual" ? gap : undefined,
      });
    }

    // 统一列/屏换算的唯一来源：列宽、列步长、翻屏步长都来自本轮 geometry。
    let w = legacyW;
    let geometry: SpreadGeometry;
    // 双页同理：每页按 [左边距 | 正文 | 右边距] 排，中缝 = 左右边距之和（像实体书
    // 摊开），viewer 撑满整屏，一屏跨页的步长恰好等于整屏宽，翻页时整个跨页连同
    // 两侧空白一起滑动。正文仍受舒适栏宽上限约束，屏幕更宽时多出的空间按比例
    // 分给每页两侧（中缝随之变宽），不拉长行。手动中缝保持原有居中阅读区。
    // 书自带的 body 左右 padding（如 0.5em）同样折进每页（单页与双页共用）。
    const authorInsetLeft = parent ? parseFloat(parentCs?.paddingLeft ?? "") || 0 : 0;
    const authorInsetRight = parent ? parseFloat(parentCs?.paddingRight ?? "") || 0 : 0;
    let spreadInsets: { left: number; right: number } | null = null;
    if (comfortArea && this.settings.spreadGapMode !== "manual") {
      const viewerInsets = this.readViewerHorizontalInsets(viewer, win);
      const fold = viewerInsets.left + viewerInsets.right === 0
        ? foldSpreadIntoPages(comfortArea, {
          fullWidth: pageW + authorInsetLeft + authorInsetRight,
          fontSizePx: em,
          authorInsetLeft,
          authorInsetRight,
        })
        : null;
      if (fold) {
        comfortArea = { ...comfortArea, geometry: fold.geometry, viewerBorderBoxWidth: fold.viewerBorderBoxWidth };
        spreadInsets = { left: fold.paddingLeftPx, right: fold.paddingRightPx };
        if (parent && authorInsetLeft + authorInsetRight > 0) this.foldParentHorizontalPadding(parent);
      }
    }
    if (comfortArea) {
      geometry = comfortArea.geometry;
      w = comfortArea.viewerBorderBoxWidth;
      this.spreadArea = comfortArea;
    } else if (comfortEligible) {
      // 普通横排但预算不足：走既有单页回退，不改保存的双页偏好。
      geometry = createSpreadGeometry(legacyW, gap, 1, MIN_COLUMN_WIDTH_PX);
      this.spreadArea = null;
    } else {
      geometry = createSpreadGeometry(legacyW, gap, requestedColumns, MIN_COLUMN_WIDTH_PX);
      this.spreadArea = null;
    }
    // 单页分页的左右边距属于“每一页”：viewer 撑满整屏，边距写成 viewer 的
    // 左右 padding，列间距 = 左边距 + 右边距，翻屏步长恰好等于整屏宽。
    // 若把边距留在 viewer 外（居中缩窄），翻页只在中间窗口里滑动，两侧是不动的长条。
    // 书自带的 body 左右 padding（如 0.5em）同理折进每页：body 横向 padding 清零、
    // 同宽加到 viewer padding，正文位置不变，滑动时两侧不再留不动的窄条。
    const insetLeft = marginLeft + authorInsetLeft;
    const insetRight = marginRight + authorInsetRight;
    const pageInsets = !scrollMode && !this.fixedLayout && !comfortArea && geometry.columns === 1 &&
      insetLeft + insetRight > 0 && legacyW > 0;
    if (pageInsets) {
      geometry = createSpreadGeometry(legacyW, insetLeft + insetRight, 1, MIN_COLUMN_WIDTH_PX);
      w = pageW + authorInsetLeft + authorInsetRight;
      if (parent && authorInsetLeft + authorInsetRight > 0) this.foldParentHorizontalPadding(parent);
    }
    this.spreadGeometry = geometry;
    this.effectiveColumns = geometry.columns;
    this.step = geometry.columnStep;
    this.pageWidth = geometry.columnWidth;
    this.bookmarkSpreadCache?.clear();
    // 分页模式先快照 reader-owned 根属性；scroll 由自己的 restore 管理。
    if (!scrollMode) this.snapshotSpreadReadingAreaStyles(viewer);
    viewer.style.position = "relative";
    viewer.style.width = `${w}px`;
    if (comfortArea && spreadInsets) {
      viewer.style.boxSizing = "border-box";
      viewer.style.marginLeft = "0px";
      viewer.style.marginRight = "0px";
      viewer.style.paddingLeft = `${spreadInsets.left}px`;
      viewer.style.paddingRight = `${spreadInsets.right}px`;
    } else if (comfortArea) {
      viewer.style.boxSizing = "border-box";
      viewer.style.marginLeft = `${comfortArea.marginLeftPx}px`;
      viewer.style.marginRight = `${comfortArea.marginRightPx}px`;
    }
    if (pageInsets) {
      viewer.style.boxSizing = "border-box";
      viewer.style.paddingLeft = `${insetLeft}px`;
      viewer.style.paddingRight = `${insetRight}px`;
    }
    viewer.style.paddingTop = `${padTop}px`;
    viewer.style.paddingBottom = `${padBottom}px`;
    this.applyCompositedPagedScroll();
    if (scrollMode) {
      viewer.style.columnCount = "auto";
      viewer.style.columnWidth = "auto";
      viewer.style.columnGap = "0px";
      viewer.style.columnFill = "auto";
    } else {
      viewer.style.columnCount = String(geometry.columns);
      viewer.style.columnWidth = "auto";
      viewer.style.columnGap = `${geometry.gap}px`;
      viewer.style.columnFill = "auto";
    }
    // 明确写入内容高；不设 100%（父级高在 body padding>0 时会比内容区大）。
    if (h > 0) {
      viewer.style.height = `${h}px`;
    } else {
      viewer.style.height = "100%";
    }
    // 连续滚动的 iframe 含上下缓冲：整页图按可见高度填满（sanitize 的
    // fullpage-image 规则读取该变量，未设置时仍为 100%）。
    const bleed = scrollMode ? this.continuousBleedPx : 0;
    if (bleed > 0 && h > 0) {
      viewer.style.setProperty?.("--reader-fill-height", `${Math.max(0, h - padTop - padBottom - 2 * bleed)}px`);
    } else {
      viewer.style.removeProperty?.("--reader-fill-height");
    }
    // 同步回流一次，确保 scrollWidth 反映新布局
    void viewer.scrollWidth;
    const waitController = new AbortController();
    this.measureControllers.add(waitController);
    try {
      // fonts.ready 极端情况下可能挂起（字体请求异常），5s 超时兜底
      const fonts = await waitForFontsReady(doc.fonts?.ready ?? Promise.resolve(), {
        signal: waitController.signal,
        timeoutMs: 5000,
      });
      if (fonts === "aborted") return false;
      if (
        !isChapterMeasurementCurrent({
          disposed: this.disposed,
          loadSeq: this.loadSeq,
          expectedLoadSeq,
          contentDoc: this.contentDoc,
          expectedDoc: doc,
          viewer: this.viewer,
          expectedViewer: viewer,
        })
      ) {
        return false;
      }
      // 布局稳定后再读一次（rAF 同样加超时兜底）
      const frames = await waitForDoubleRaf({
        signal: waitController.signal,
        timeoutMs: 2000,
        requestAnimationFrame: doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView),
        cancelAnimationFrame: doc.defaultView?.cancelAnimationFrame?.bind(doc.defaultView),
      });
      if (frames === "aborted") return false;
      if (
        !isChapterMeasurementCurrent({
          disposed: this.disposed,
          loadSeq: this.loadSeq,
          expectedLoadSeq,
          contentDoc: this.contentDoc,
          expectedDoc: doc,
          viewer: this.viewer,
          expectedViewer: viewer,
        })
      ) {
        return false;
      }
      // [L5-C18] fit-content 会改变最终 border-box 宽度，必须先稳定宽度再计算
      // 页面级 margin；反过来会把多栏中的异常旧宽度固化成错误横向位置。
      if (this.scrollMode) {
        // 滚动模式：分页专用的分片/尾部占位/backdrop 避免补偿都不执行。
        // viewer 是唯一纵向滚动容器，html/body 仍不承担正文滚动。
        const viewportHeight = Math.max(
          0,
          (parent?.clientHeight || this.iframe.clientHeight || viewer.clientHeight) -
            (parseFloat(parentCs?.paddingTop ?? "") || 0) -
            (parseFloat(parentCs?.paddingBottom ?? "") || 0)
        );
        this.applyScrollViewerStyles(viewportHeight, marginLeft, marginRight);
        this.applyReaderBodyPercentageSpacingForMeasure(
          doc,
          viewer,
          Math.max(
            0,
            viewer.clientWidth -
              (parseFloat(win?.getComputedStyle(viewer).paddingLeft ?? "") || 0) -
              (parseFloat(win?.getComputedStyle(viewer).paddingRight ?? "") || 0),
          ),
        );
        this.applyFitContentFix();
        this.applyBookMargins();
        this.applyContainedMediaMaxWidth();
        void viewer.scrollHeight;
        this.pageWidth = Math.max(0, viewer.clientWidth);
        this.step = 0;
        this.restoreBackdropCompatibility();
        this.measuredViewport = { width: measuredWidth, height: measuredHeight };
        return isChapterMeasurementCurrent({
          disposed: this.disposed,
          loadSeq: this.loadSeq,
          expectedLoadSeq,
          contentDoc: this.contentDoc,
          expectedDoc: doc,
          viewer: this.viewer,
          expectedViewer: viewer,
        });
      }
      // [L5-C18] fit-content 会改变最终 border-box 宽度，必须先稳定宽度再计算
      // 页面级 margin；反过来会把多栏中的异常旧宽度固化成错误横向位置。
      this.applyReaderBodyPercentageSpacingForMeasure(doc, viewer, this.effectiveColumnWidth);
      this.applyFitContentFix();
      this.applyBookMargins();
      this.applyFloatShrinkFix();
      this.applyTrailingFloatMarginFix();
      this.applyInlineBoxOverflowFix();
      this.applyContainedMediaMaxWidth();
      if (!this.fixedLayout) {
        this.backdropCompatibilityRestore = applyBackdropCompatibility(doc, viewer, {
          // 双栏时传单列宽与列步长，不能传整屏宽。
          pageWidth: this.geometry?.columnWidth ?? this.pageWidth,
          step: this.geometry?.columnStep ?? this.step,
        });
      }
      // 只在整轮测量与二阶段补偿完成后提交尺寸；若测量期间窗口又变化，
      // ResizeObserver 仍会发现新尺寸并发起下一轮。
      this.measuredViewport = { width: measuredWidth, height: measuredHeight };
      return isChapterMeasurementCurrent({
        disposed: this.disposed,
        loadSeq: this.loadSeq,
        expectedLoadSeq,
        contentDoc: this.contentDoc,
        expectedDoc: doc,
        viewer: this.viewer,
        expectedViewer: viewer,
      });
    } finally {
      this.measureControllers.delete(waitController);
      waitController.abort();
    }
  }

  /** measure/cleanup 入口先恢复上一轮舒适双页的根内联样式。 */
  private restoreSpreadReadingAreaStyles(): void {
    const restore = this.spreadAreaStyleRestore;
    this.spreadAreaStyleRestore = null;
    restore?.();
    const restoreParent = this.parentPaddingRestore;
    this.parentPaddingRestore = null;
    restoreParent?.();
  }

  /** 单页分页把 viewer 父级（body）的左右 padding 折进页边距；下次测量前精确恢复。 */
  private foldParentHorizontalPadding(parent: HTMLElement): void {
    if (this.parentPaddingRestore) return;
    const style = parent.style as CSSStyleDeclaration | undefined;
    if (!style || typeof style.getPropertyValue !== "function") return;
    const snapshot = (["padding-left", "padding-right"] as const).map((property) => ({
      property,
      value: style.getPropertyValue(property),
      priority: style.getPropertyPriority(property),
    }));
    style.setProperty("padding-left", "0px", "important");
    style.setProperty("padding-right", "0px", "important");
    this.parentPaddingRestore = () => {
      for (const item of snapshot) {
        if (item.value) style.setProperty(item.property, item.value, item.priority);
        else style.removeProperty(item.property);
      }
    };
  }

  /** 只快照 reader-owned 根属性；不覆盖作者/用户对 viewer 的其他内联样式。 */
  private snapshotSpreadReadingAreaStyles(viewer: HTMLElement): void {
    if (this.spreadAreaStyleRestore) return;
    const style = viewer.style as CSSStyleDeclaration | undefined;
    if (!style || typeof style.getPropertyValue !== "function") return;
    const snapshot = SPREAD_AREA_ROOT_STYLE_PROPERTIES.map((property) => ({
      property,
      value: style.getPropertyValue(property),
      priority: style.getPropertyPriority(property),
    }));
    this.spreadAreaStyleRestore = () => {
      for (const item of snapshot) {
        if (item.value) style.setProperty(item.property, item.value, item.priority);
        else style.removeProperty(item.property);
      }
    };
  }

  /** viewer 自身 border+padding；作者 root padding 已在 pageW 前扣除，不能重复。 */
  private readViewerHorizontalInsets(
    viewer: HTMLElement,
    win: Window | null,
  ): { left: number; right: number } {
    try {
      const cs = win?.getComputedStyle(viewer);
      if (!cs) return { left: 0, right: 0 };
      const left =
        (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      const right =
        (parseFloat(cs.borderRightWidth) || 0) + (parseFloat(cs.paddingRight) || 0);
      return { left, right };
    } catch {
      return { left: 0, right: 0 };
    }
  }

  private restoreScrollView(): void {
    this.scrollStyleRestore?.();
    this.scrollStyleRestore = null;
  }

  /**
   * 正文直接子的百分比 spacing 在本轮单栏/局部内容宽确定后处理。
   * 调用时 restorePercentageSpacing 仍是根盒 padding 的恢复函数，事务式合并，
   * 重测/换章/清理一次恢复两阶段。
   */
  private applyReaderBodyPercentageSpacingForMeasure(
    doc: Document,
    viewer: HTMLElement,
    containingWidth: number,
  ): void {
    const resolveBody = applyReaderBodyPercentageSpacing(
      doc,
      viewer,
      containingWidth,
      TEXT_MEASURE.maxEm * this.settings.fontSizePx,
    );
    const restoreRoot = this.restorePercentageSpacing;
    this.restorePercentageSpacing = () => {
      resolveBody();
      restoreRoot();
    };
  }

  private applyScrollViewerStyles(viewportHeight: number, marginLeft = 0, marginRight = marginLeft): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const styles = scrollViewerStyles(viewportHeight, marginLeft, marginRight);
    if (!this.scrollStyleRestore) {
      const snapshot = styles.map(([property]) => ({
        property,
        value: viewer.style.getPropertyValue(property),
        priority: viewer.style.getPropertyPriority(property),
      }));
      this.scrollStyleRestore = () => {
        for (const item of snapshot) {
          if (item.value) viewer.style.setProperty(item.property, item.value, item.priority);
          else viewer.style.removeProperty(item.property);
        }
      };
    }
    for (const [property, value] of styles) {
      viewer.style.setProperty(property, value);
    }
    this.applyExternalScrollOwnership();
    this.applyCompositedPagedScroll();
  }

  /** ready 状态的唯一构造入口，避免滚动字段散落在各调用点。 */
  private readyState(empty: boolean, page = this.metrics.currentPage): ChapterState {
    if (this.scrollMode) {
      const metrics = this.scrollMetrics();
      return {
        status: "ready",
        pageCount: this.metrics.pageCount,
        currentPage: this.metrics.currentPage,
        empty,
        mode: "scroll",
        scrollProgress: scrollRatio(metrics, this.viewer?.scrollTop ?? 0),
        effectiveColumns: 1,
      };
    }
    const leafRange = this.spreadLayout
      ? visibleLeafRange(this.spreadLayout, page)
      : null;
    const atEnd = !this.hasNextChapter && page >= this.metrics.pageCount - 1;
    return {
      status: "ready",
      pageCount: this.metrics.pageCount,
      currentPage: page,
      empty,
      mode: "paginated",
      effectiveColumns: (this.spreadGeometry?.columns ?? this.effectiveColumns) as 1 | 2,
      atEnd,
      leafRange,
      ...(this.spreadArea
        ? {
            spreadArea: {
              baseLeftPx: this.spreadArea.baseLeftPx,
              baseRightPx: this.spreadArea.baseRightPx,
              marginLeftPx: this.spreadArea.marginLeftPx,
              marginRightPx: this.spreadArea.marginRightPx,
              gapPx: this.spreadArea.geometry.gap,
            },
          }
        : {}),
    };
  }

  private scrollToElement(el: Element, desiredInset: number): void {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (!viewer || !doc || this.scrollMode === false) return;
    const range = doc.createRange();
    try {
      range.selectNodeContents(el);
      const resolved = this.resolveScrollTopForRange(range, desiredInset);
      if (resolved !== null) viewer.scrollTop = resolved;
    } catch {
      const rect = (el as HTMLElement).getBoundingClientRect();
      const resolved = scrollTopForRange({
        rangeTop: rect.top,
        viewportTop: viewer.getBoundingClientRect().top,
        currentScrollTop: viewer.scrollTop,
        desiredInset,
        metrics: this.scrollMetrics(),
      }).scrollTop;
      viewer.scrollTop = resolved;
    }
  }

  /** 滚动位置与整章比例的唯一采样点：可见区域上方固定一点。 */
  private captureScrollAnchor(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !this.scrollMode) return;
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;
    const anchor = captureVisibleAnchor({ viewer, doc, index, mode: "scroll", visibleRatio: 0.12 });
    if (!anchor) return;
    this.anchor = anchor;
    this.anchorPath = this._currentPath;
  }

  private syncScrollMetrics(capture: boolean): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const metrics = this.scrollMetrics();
    const pageCount = this.scrollPageCount;
    const currentPage = Math.max(
      0,
      Math.min(pageCount - 1, Math.floor(scrollRatio(metrics, viewer.scrollTop) * pageCount))
    );
    this.lastScrollTop = viewer.scrollTop;
    this.metrics = { pageCount, currentPage };
    // 进度采样只在滚动中读取可见区域文字，不写回任何布局。
    if (capture) this.captureScrollAnchor();
    this.emit(this.readyState(false));
  }

  /** 滚动事件：一帧一次更新位置；真实 scrollTop 变化才关闭弹注。 */
  private handleScroll(): void {
    if (!this.scrollMode || this.disposed) return;
    if (this.isProjectingScroll) return;
    const viewer = this.viewer;
    if (!viewer) return;
    if (this.pendingWheelTarget !== null && Math.abs(viewer.scrollTop - this.pendingWheelTarget) < 2) {
      this.cancelScrollAnimation();
    }
    if (this.scrollFrame !== undefined) return;
    const win = this.contentDoc?.defaultView;
    const raf = win?.requestAnimationFrame?.bind(win);
    const run = (): void => {
      this.scrollFrame = undefined;
      this.syncScrollMetrics(true);
    };
    if (raf) {
      this.scrollFrameKind = "raf";
      this.scrollFrame = raf(run);
    } else {
      this.scrollFrameKind = "timer";
      this.scrollFrame = globalThis.setTimeout(run, 16) as unknown as number;
    }
    // 真实滚动改变即关闭当前弹注；同值事件不关闭。
    if (Math.abs(viewer.scrollTop - this.lastScrollTop) > 0.5) {
      this.resetFootnoteForContentChange();
    }
  }

  private cancelScrollFrame(): void {
    if (this.scrollFrame === undefined) return;
    const win = this.contentDoc?.defaultView;
    if (this.scrollFrameKind === "raf") {
      win?.cancelAnimationFrame?.(this.scrollFrame);
    } else {
      globalThis.clearTimeout(this.scrollFrame);
    }
    this.scrollFrame = undefined;
  }

  private cancelScrollAnimation(): void {
    if (typeof this.scrollAnimFrame === "number") {
      const win = this.contentDoc?.defaultView ?? (typeof window !== "undefined" ? window : null);
      win?.cancelAnimationFrame?.(this.scrollAnimFrame);
      this.scrollAnimFrame = null;
    }
    this.pendingWheelTarget = null;
  }

  /** 触摸/拖动开始不应沿用固定弹注（与滚动位置变化同一规则）。 */
  private handleScrollPointerDown(): void {
    if (!this.scrollMode || this.disposed) return;
    this.cancelScrollAnimation();
    this.resetFootnoteForContentChange();
  }

  /** 位置变化时关闭弹注并丢弃选区菜单，但保留搜索高亮。 */
  private resetFootnoteForContentChange(): void {
    this.closeFootnoteForNavigation();
    if (this.selectionContextMenuOpen) {
      this.selectionContextMenuOpen = false;
      this.selectionContextMenuHandler?.(null);
    }
  }

  /** 滚动模式下的入口定位：文字锚点 → 内容 y；legacy 元素锚点 → 元素顶边。 */
  private applyScrollRestore(
    fallbackPage: number | null,
    preciseAnchor: ReadingAnchor | null
  ): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const index = this.textIndex;
    const metrics = this.scrollMetrics();
    const inset = Math.round(Math.min(24, Math.max(0, metrics.viewportHeight * 0.04)));
    let rangeTop: number | null = null;
    if (preciseAnchor && this.anchorPath === this._currentPath) {
      if (index && preciseAnchor.textOffset !== null) {
        const offset = resolveTextAnchorOffset(index, preciseAnchor);
        if (offset !== null) {
          const position = index.positionForOffset(offset);
          if (position) {
            const range = this.contentDoc?.createRange();
            if (range) {
              try {
                range.setStart(position.node, position.rawOffset);
                range.setEnd(position.node, position.rawOffset);
                const rect = range.getBoundingClientRect();
                if (Number.isFinite(rect.top)) {
                  rangeTop = rect.top;
                  this.anchor = {
                    ...preciseAnchor,
                    textOffset: offset,
                    textSnippet: index.snippetAt(offset),
                    charsRead: offset,
                    totalChars: index.totalChars,
                    mediaUnits: index.mediaUnits,
                  };
                  this.anchorPath = this._currentPath;
                }
              } catch {
                rangeTop = null;
              }
            }
          }
        }
      }
      if (rangeTop === null && Number.isSafeInteger(preciseAnchor.index) && preciseAnchor.index >= 0) {
        const all = Array.from(viewer.querySelectorAll("*"));
        const el = all[preciseAnchor.index] as HTMLElement | undefined;
        const rect = el?.getBoundingClientRect();
        if (rect && Number.isFinite(rect.top)) rangeTop = rect.top + preciseAnchor.ratio * rect.height;
      }
    }
    if (rangeTop === null && fallbackPage !== null && fallbackPage > 0) {
      // 页码兜底只在同章内使用：按“可用屏高”近似旧位置。
      const max = scrollMaxTop(metrics);
      const ratio = Math.min(1, fallbackPage / Math.max(1, this.metrics.pageCount - 1));
      viewer.scrollTop = Math.round(max * ratio);
    } else if (rangeTop !== null) {
      const resolved = scrollTopForRange({
        rangeTop,
        viewportTop: viewer.getBoundingClientRect().top,
        currentScrollTop: viewer.scrollTop,
        desiredInset: inset,
        metrics,
      });
      viewer.scrollTop = resolved.scrollTop;
    } else if (this.pendingStartAtEnd) {
      viewer.scrollTop = scrollMaxTop(metrics);
    } else {
      viewer.scrollTop = 0;
    }
    this.lastScrollTop = viewer.scrollTop;
  }

  /** 滚动模式：一帧内的滚动范围换算与进度采样。 */
  private resolveScrollTopForRange(range: Range, desiredInset: number): number | null {
    const viewer = this.viewer;
    if (!viewer) return null;
    const rect = Array.from(range.getClientRects?.() ?? []).find(
      (candidate) => candidate.width > 0 || candidate.height > 0
    );
    const top = rect?.top ?? range.getBoundingClientRect?.().top;
    if (top === undefined || !Number.isFinite(top)) return null;
    return scrollTopForRange({
      rangeTop: top,
      viewportTop: viewer.getBoundingClientRect().top,
      currentScrollTop: viewer.scrollTop,
      desiredInset,
      metrics: this.scrollMetrics(),
    }).scrollTop;
  }

  private restoreContainedMediaFixes(): void {
    for (const fix of this.containedMediaFixes ?? []) {
      restoreInlineStyleProperty(fix.el.style, "max-width", fix.maxWidth);
    }
    this.containedMediaFixes = [];
  }

  /**
   * 分页与滚动正文普通图片/顶层背景图盒的局部 max-width 收紧。先恢复/复用原快照，再收集读数，
   * 最后批量写回；只处理实际越过块级包含盒的媒体，整页/固定版式/浮层/绝对定位
   * 与明确出血意图继续走原布局。固定版式不进入；不改 width/height/max-height。
   */
  private applyContainedMediaMaxWidth(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    const win = doc?.defaultView;
    if (!doc || !viewer || !win || this.fixedLayout) return;
    if (
      viewer.classList.contains("fullpage-image") ||
      viewer.classList.contains("pure-image-page")
    ) {
      return;
    }

    const priorFixes = this.containedMediaFixes ?? [];
    const existing = new Map<HTMLElement, (typeof priorFixes)[number]>();
    for (const fix of priorFixes) existing.set(fix.el, fix);
    const next: Array<{
      el: HTMLElement;
      maxWidth: InlineStyleValue;
      authoredMaxWidth: number;
    }> = [];
    const writes: Array<{ el: HTMLElement; value: number }> = [];
    const epsilon = 0.5;
    const media = Array.from(viewer.querySelectorAll("img, .reader-top")) as HTMLElement[];

    for (const element of media) {
      if (!element.isConnected || !element.parentElement) continue;
      if (element.closest(".illus, .kuchie, .cover, .duokan-image-fullscreen")) continue;

      const cs = win.getComputedStyle(element);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // 背景图片没有 <img>：只补普通顶层块，不改内联装饰和嵌套背景布局。
      if (element.localName !== "img" && (
        element.parentElement !== viewer ||
        cs.backgroundImage === "none" ||
        !/^(?:block|flow-root)$/u.test(cs.display) ||
        cs.writingMode !== "horizontal-tb"
      )) continue;
      if (cs.float.trim().toLowerCase() !== "none") continue;
      const position = cs.position.trim().toLowerCase();
      if (position === "absolute" || position === "fixed") continue;
      if (cs.transform.trim().toLowerCase() !== "none") continue;

      const existingFix = existing.get(element);
      const authoredMaxWidth =
        existingFix?.authoredMaxWidth ?? this.parseAuthoredMediaMaxWidth(cs.maxWidth);
      if (authoredMaxWidth === undefined) continue;

      const boxSizing: BoxSizing =
        cs.boxSizing === "border-box" ? "border-box" : "content-box";
      const paddingBorderWidth =
        (parseFloat(cs.paddingLeft) || 0) +
        (parseFloat(cs.paddingRight) || 0) +
        (parseFloat(cs.borderLeftWidth) || 0) +
        (parseFloat(cs.borderRightWidth) || 0);
      // 窄屏溢出的 auto margin 会解析为负数；它不是作者负缩进，不能
      // 把负值加回宽度预算，否则 380px 背景盒在 328px 列内仍被允许。
      const marginTokens = readComputedHorizontalMarginSpecifiedValues(element);
      const marginLeft = marginTokens?.left === "auto" ? 0 : parseFloat(cs.marginLeft) || 0;
      const marginRight = marginTokens?.right === "auto" ? 0 : parseFloat(cs.marginRight) || 0;
      const containing = this.getMediaContainingBlock(element, win);
      const containingStyle = win.getComputedStyle(containing);
      const containingContentWidth = resolveBlockContainingContentWidth(
        this.viewer,
        this.scrollMode,
        this.effectiveColumnWidth,
        this.contentDoc,
        containing,
        containingStyle
      );
      const available = containingContentWidth - marginLeft - marginRight;
      if (!(available > 0)) continue;

      if (!existingFix) {
        const currentBorderBox = getBorderBoxWidth(cs);
        if (!(currentBorderBox > available + epsilon)) continue;
      }

      // 先筛实际溢出，再读取作者 CSSOM，普通背景段落不增加规则扫描。
      if (hasAuthorMediaBreakoutIntent(doc, element)) continue;

      const planned = planContainedMediaMaxWidth({
        containingContentWidth,
        marginLeft,
        marginRight,
        boxSizing,
        paddingBorderWidth,
        authoredMaxWidth,
      });
      if (!Number.isFinite(planned) || planned < 0) continue;
      // 作者明确更小的上限（如 32px 图标）保持不动。
      if (!(planned < authoredMaxWidth - epsilon)) continue;

      const snapshot =
        existingFix?.maxWidth ?? snapshotInlineStyleProperty(element.style, "max-width");
      next.push({ el: element, maxWidth: snapshot, authoredMaxWidth });
      writes.push({ el: element, value: planned });
    }

    for (const fix of priorFixes) {
      if (!next.some((candidate) => candidate.el === fix.el)) {
        restoreInlineStyleProperty(fix.el.style, "max-width", fix.maxWidth);
      }
    }
    for (const write of writes) {
      write.el.style.setProperty("max-width", `${write.value}px`, "important");
    }
    this.containedMediaFixes = next;
  }

  private restoreBookMargins(): void {
    for (const fix of this.marginFixes) {
      fix.el.removeAttribute("data-reader-margin-fixed");
      restoreInlineStyleProperty(fix.el.style, "margin-left", fix.left);
      restoreInlineStyleProperty(fix.el.style, "margin-right", fix.right);
      if (fix.maxWidth) {
        restoreInlineStyleProperty(fix.el.style, "max-width", fix.maxWidth);
      }
    }
    this.marginFixes = [];
  }

  private applyBookMargins(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView) return;
    const win = doc.defaultView;
    // applyFitContentFix 先于本阶段执行；记录原始 fit-content 意图，避免
    // inline 40rem 写回后丢失“无 margin 时左对齐正文列”的既有语义。
    const fitContentElements = new Set(this.fitContentFixes.map((fix) => fix.el));

    const readerSheet = Array.from(doc.styleSheets).find(
      (s) => (s.ownerNode as Element | null)?.getAttribute?.("data-reader") === "overrides"
    );
    const candidates = Array.from(viewer.children).filter(
      (c): c is HTMLElement =>
        c.nodeType === 1 &&
        !c.classList.contains("illus") &&
        !c.classList.contains("kuchie") &&
        !c.classList.contains("cover") &&
        !c.classList.contains("duokan-image-fullscreen")
    );
    if (
      candidates.length === 0 ||
      viewer.classList.contains("fullpage-image") ||
      viewer.classList.contains("pure-image-page")
    ) return;
    const candidateSet = new Set(candidates);

    // 先暂时移除 L3 auto margin，再读取“作者/用户最终获胜的级联”。
    // getComputedStyle 会把百分比解析成 px，必须优先用 Typed OM 保留
    // 70% / calc(...%) 这类指定值；旧 WebView 才回退到 CSSOM 扫描。
    // 注意：多栏里元素若跨列碎片，getBoundingClientRect().width 会把碎片
    // 并成一个超宽矩形，必须用 computed width。
    const widths = new Map<HTMLElement, number>();
    const maxWidths = new Map<HTMLElement, string>();
    const percentageMargins = new Map<
      HTMLElement,
      {
        percentage: boolean | undefined;
        maxWidth?: InlineStyleValue;
        relaxedReaderMaxWidth: boolean;
      }
    >();
    const authoredHorizontalMargins = new Map<HTMLElement, AuthoredHorizontalMarginResult>();
    const authoredSizingIntents = new Map<HTMLElement, AuthoredSizingIntentResult>();
    const symmetricPercentageInsets = new Map<HTMLElement, { left: number; right: number; maxWidth: number }>();
    const contentBoxBudgetFixes: Array<{
      el: HTMLElement;
      containerWidth: number;
      marginLeft: number;
      marginRight: number;
      boxSizing: BoxSizing;
      paddingBorderWidth: number;
    }> = [];
    const restoreReaderMargins = readerSheet
      ? this.disableReaderTopMarginRules(readerSheet)
      : () => {};
    try {
      for (const el of candidates) {
        void el.offsetWidth;
        let cs = win.getComputedStyle(el);
        maxWidths.set(el, cs.maxWidth);

        const typedPercentage = hasComputedPercentageHorizontalMargin(el);
        const percentage =
          typedPercentage ??
          (hasPercentageHorizontalMargin(el.style) ||
            hasPercentageHorizontalMarginInRules(doc, el));
        const marginProbe: {
          percentage: boolean | undefined;
          maxWidth?: InlineStyleValue;
          relaxedReaderMaxWidth: boolean;
        } = { percentage, relaxedReaderMaxWidth: false };

        // 水平百分比 margin 是相对包含块的页面布局。若作者没有自己的 inline
        // max-width，暂时解除 L3 的 40rem 默认值，才能读到作者原本的剩余宽度。
        if (percentage === true) {
          const parent = el.parentElement;
          const parentStyle = parent ? win.getComputedStyle(parent) : win.getComputedStyle(viewer);
          const parentWidth = resolveBlockContainingContentWidth(
            this.viewer,
            this.scrollMode,
            this.effectiveColumnWidth,
            this.contentDoc,
            parent,
            parentStyle
          );
          const symmetric = isSymmetricHorizontalMargin(cs.marginLeft, cs.marginRight);
          const insets = symmetric ? getReaderAutoBlockInsets({
            heading: /^h[1-6]$/iu.test(el.localName),
            percentage, authoredSizing: hasAuthoredSizingIntent(doc, el),
            float: cs.float, display: cs.display, position: cs.position, writingMode: cs.writingMode,
            parentWidth, contentWidth: TEXT_MEASURE.maxEm * this.settings.fontSizePx,
            marginLeft: parseFloat(cs.marginLeft), marginRight: parseFloat(cs.marginRight),
            borderBoxExtra: Math.max(0, getBorderBoxWidth(cs) - parseFloat(cs.width)),
          }) : null;
          if (insets) symmetricPercentageInsets.set(el, insets);
          const maxWidth = snapshotInlineStyleProperty(el.style, "max-width");
          const relaxedReaderMaxWidth = !insets && maxWidth.value === "";
          marginProbe.maxWidth = maxWidth;
          marginProbe.relaxedReaderMaxWidth = relaxedReaderMaxWidth;
          if (relaxedReaderMaxWidth) {
            el.style.setProperty("max-width", "none");
            void el.offsetWidth;
            cs = win.getComputedStyle(el);
          }
        }
        // The source probe walks CSSOM. C-16 percentage margins return before
        // C-37/C-04, so only non-percentage candidates with an actual margin
        // can reach that branch. Zero/auto direct children intentionally
        // avoid an O(children × rules) scan here.
        if (shouldProbeAuthoredHorizontalMargin(percentage, cs.marginLeft, cs.marginRight)) {
          // Run while the L3 auto rules are removed. This distinguishes a UA
          // default (for example blockquote's 40px/40px) from an actual book
          // or customCss declaration before C-04 sees resolved px margins.
          authoredHorizontalMargins.set(el, hasAuthoredHorizontalMargin(doc, el));
          if (
            isSymmetricHorizontalMargin(cs.marginLeft, cs.marginRight) ||
            Array.from(el.children).some((child) => /^(?:block|flow-root|flex|grid|table|list-item)$/u.test(win.getComputedStyle(child).display))
          ) {
            // Fixed/unknown sizing intent must keep the conservative C-04 path;
            // only a definite absence can authorize C-40 natural centering or
            // the auto-width bilateral inset below.
            authoredSizingIntents.set(el, hasAuthoredSizingIntent(doc, el));
          }
        }
        percentageMargins.set(el, marginProbe);

        const borderBoxW = getBorderBoxWidth(cs);
        widths.set(el, borderBoxW > 0 ? borderBoxW : el.getBoundingClientRect().width);

        // [L3 默认版心预算] 仅先筛几何：普通顶层 auto-width 块若因自身
        // padding/border 让 content-box 边框盒超过默认版心，再查作者 sizing。
        // 这样不给每个普通段落增加 CSSOM 扫描，也避免改动作者显式 width。
        const parent = el.parentElement;
        const parentCs = parent ? win.getComputedStyle(parent) : null;
        const containerWidth = resolveBlockContainingContentWidth(
          this.viewer,
          this.scrollMode,
          this.effectiveColumnWidth,
          this.contentDoc,
          parent,
          parentCs
        );
        const measureWidth = TEXT_MEASURE.maxEm * this.settings.fontSizePx;
        const measure = Math.min(containerWidth, measureWidth);
        const contentWidthPx = Number.parseFloat(cs.width);
        const paddingBorderWidth =
          (parseFloat(cs.paddingLeft) || 0) +
          (parseFloat(cs.paddingRight) || 0) +
          (parseFloat(cs.borderLeftWidth) || 0) +
          (parseFloat(cs.borderRightWidth) || 0);
        const fullpage =
          el.classList.contains("illus") ||
          el.classList.contains("kuchie") ||
          el.classList.contains("cover") ||
          el.classList.contains("duokan-image-fullscreen");
        const tag = el.localName.toLowerCase();
        const horizontalMarginFree =
          !isMeaningfulHorizontalMargin(cs.marginLeft) &&
          !isMeaningfulHorizontalMargin(cs.marginRight);
        if (
          !this.fixedLayout &&
          el.classList.contains("reader-top") &&
          !fullpage &&
          horizontalMarginFree &&
          tag !== "img" &&
          tag !== "image" &&
          tag !== "svg" &&
          tag !== "video" &&
          tag !== "audio" &&
          tag !== "canvas" &&
          cs.float.trim().toLowerCase() === "none" &&
          /^(?:static|relative)$/u.test(cs.position.trim().toLowerCase()) &&
          cs.writingMode.trim().toLowerCase() === "horizontal-tb" &&
          /^(?:block|flow-root)$/u.test(cs.display.trim().toLowerCase()) &&
          percentage !== true &&
          cs.boxSizing === "content-box" &&
          paddingBorderWidth > 0.5 &&
          Number.isFinite(contentWidthPx) &&
          contentWidthPx <= measure + 0.5 &&
          borderBoxW > measure + 0.5 &&
          !/(?:fit-content|max-content)/u.test(cs.maxWidth)
        ) {
          if (hasAuthoredSizingIntent(doc, el) === false) {
            contentBoxBudgetFixes.push({
              el,
              containerWidth,
              marginLeft: parseFloat(cs.marginLeft) || 0,
              marginRight: parseFloat(cs.marginRight) || 0,
              boxSizing: "content-box",
              paddingBorderWidth,
            });
          }
        }
      }

      // 一次集中写回上述默认版心预算修正；随后继续现有边距判定。
      if (contentBoxBudgetFixes.length > 0) {
        for (const fix of contentBoxBudgetFixes) {
          const plan = planAutoBlockBox({
            containerWidth: fix.containerWidth,
            measureWidth: TEXT_MEASURE.maxEm * this.settings.fontSizePx,
            marginLeft: fix.marginLeft,
            marginRight: fix.marginRight,
            boxSizing: fix.boxSizing,
            paddingBorderWidth: fix.paddingBorderWidth,
          });
          this.marginFixes.push({
            el: fix.el,
            left: snapshotInlineStyleProperty(fix.el.style, "margin-left"),
            right: snapshotInlineStyleProperty(fix.el.style, "margin-right"),
            maxWidth: snapshotInlineStyleProperty(fix.el.style, "max-width"),
          });
          fix.el.setAttribute("data-reader-margin-fixed", "1");
          fix.el.style.setProperty("max-width", `${plan.maxWidth}px`);
          fix.el.style.setProperty("margin-left", `${plan.marginLeft}px`, "important");
          fix.el.style.setProperty("margin-right", `${plan.marginRight}px`, "important");
        }
        void viewer.offsetWidth;
      }

      const preserveFloatLayout = (el: HTMLElement, leftValue: string, rightValue: string): void => {
        const toPx = (value: string): string => {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? `${parsed}px` : "0px";
        };
        this.floatLayoutFixes.push({
          el,
          left: snapshotInlineStyleProperty(el.style, "margin-left"),
          right: snapshotInlineStyleProperty(el.style, "margin-right"),
          width: snapshotInlineStyleProperty(el.style, "width"),
          maxWidth: snapshotInlineStyleProperty(el.style, "max-width"),
        });
        el.setAttribute("data-reader-float-layout-fixed", "1");
        el.style.setProperty("margin-left", toPx(leftValue), "important");
        el.style.setProperty("margin-right", toPx(rightValue), "important");
      };

      // C-31 must inspect the complete direct-child sequence rather than the
      // filtered candidate list: an excluded fullscreen element or any normal
      // block between two floats is a real sibling boundary and must end the
      // percentage grid group.
      const groupEntries: PercentageFloatGroupEntry[] = Array.from(viewer.children).map((child) => {
        const el = child as HTMLElement;
        const cs = win.getComputedStyle(el);
        const fullpage =
          el.classList.contains("illus") ||
          el.classList.contains("kuchie") ||
          el.classList.contains("cover") ||
          el.classList.contains("duokan-image-fullscreen");
        const eligible = candidateSet.has(el) && !fullpage;
        const isFloat = /^(?:left|right)$/u.test(cs.float.trim().toLowerCase());
        return {
          eligible,
          readerTop: el.classList.contains("reader-top"),
          float: cs.float,
          clear: cs.clear,
          percentageWidth:
            eligible && isFloat
              ? getAuthoredPercentageWidth(el, doc)
              : null,
          marginLeft: cs.marginLeft,
          marginRight: cs.marginRight,
          position: cs.position,
          writingMode: cs.writingMode,
          direction: cs.direction,
          authorFullWidthIntent: eligible && isFloat ? hasAuthorFullWidthIntent(doc, el) : false,
          percentageMargin: percentageMargins.get(el)?.percentage,
        };
      });
      const percentageFloatGroupMembers = new Set<HTMLElement>();
      getPercentageFloatGroupMembers(groupEntries).forEach((member, index) => {
        if (member) percentageFloatGroupMembers.add(viewer.children[index] as HTMLElement);
      });
      const safePercentageFloatGroupMembers = new Set<HTMLElement>();
      getSafePercentageFloatGroupMembers(groupEntries).forEach((member, index) => {
        if (member) safePercentageFloatGroupMembers.add(viewer.children[index] as HTMLElement);
      });

      // Stage 2: process each safe complete percentage group as one layout
      // unit. No wrapper is inserted; only existing direct children receive
      // temporary inline width/margin declarations.
      const groupEntriesByElement = new Map<HTMLElement, PercentageFloatGroupEntry>();
      groupEntries.forEach((entry, index) => {
        groupEntriesByElement.set(viewer.children[index] as HTMLElement, entry);
      });
      const children = Array.from(viewer.children) as HTMLElement[];
      let groupIndex = 0;
      while (groupIndex < children.length) {
        const first = children[groupIndex];
        if (!percentageFloatGroupMembers.has(first)) {
          groupIndex += 1;
          continue;
        }
        const members: HTMLElement[] = [];
        while (
          groupIndex < children.length &&
          percentageFloatGroupMembers.has(children[groupIndex])
        ) {
          members.push(children[groupIndex++]);
        }
        if (!members.every((member) => safePercentageFloatGroupMembers.has(member))) continue;

        const firstEntry = groupEntriesByElement.get(members[0]);
        if (!firstEntry) continue;
        const parent = members[0].parentElement;
        const parentCs = parent && doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
        const parentW = resolveBlockContainingContentWidth(
          this.viewer,
          this.scrollMode,
          this.effectiveColumnWidth,
          this.contentDoc,
          parent,
          parentCs
        );
        const contentWidth = TEXT_MEASURE.maxEm * this.settings.fontSizePx;
        const targetWidths = getPercentageFloatGroupTargetWidths(
          members.map((member) => groupEntriesByElement.get(member)?.percentageWidth ?? NaN),
          parentW,
          contentWidth
        );
        if (!targetWidths) continue;
        const inset = Math.max(0, (parentW - Math.min(parentW, contentWidth)) / 2);
        const originalMargins = members.map((member) => {
          const cs = win.getComputedStyle(member);
          return { left: cs.marginLeft, right: cs.marginRight };
        });
        const snapshotStart = this.floatLayoutFixes.length;
        const floatDirection = firstEntry.float.trim().toLowerCase();
        members.forEach((member, index) => {
          const snapshot = {
            el: member,
            left: snapshotInlineStyleProperty(member.style, "margin-left"),
            right: snapshotInlineStyleProperty(member.style, "margin-right"),
            width: snapshotInlineStyleProperty(member.style, "width"),
            maxWidth: snapshotInlineStyleProperty(member.style, "max-width"),
          };
          this.floatLayoutFixes.push(snapshot);
          member.setAttribute("data-reader-float-layout-fixed", "1");
          member.style.setProperty("width", `${targetWidths[index]}px`, "important");
          const sideInset = index === 0 ? inset : 0;
          member.style.setProperty(
            "margin-left",
            `${floatDirection === "left" ? sideInset : 0}px`,
            "important"
          );
          member.style.setProperty(
            "margin-right",
            `${floatDirection === "right" ? sideInset : 0}px`,
            "important"
          );
        });
        void viewer.offsetWidth;
        const viewerRect = viewer.getBoundingClientRect();
        let viewerPaddingLeft = 0;
        try {
          viewerPaddingLeft = parseFloat(doc.defaultView?.getComputedStyle(viewer).paddingLeft ?? "") || 0;
        } catch {
          viewerPaddingLeft = 0;
        }
        const rects = members.map((member) =>
          Array.from(member.getClientRects()).map((rect) => ({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          }))
        );
        const validGeometry = isPercentageFloatGroupGeometryValid({
          rects,
          viewerLeft: viewerRect.left + (viewer.clientLeft || 0) + viewerPaddingLeft,
          scrollLeft: viewer.scrollLeft,
          step: this.step,
          parentWidth: parentW,
          contentWidth,
        });
        if (!validGeometry) {
          for (let index = snapshotStart; index < this.floatLayoutFixes.length; index += 1) {
            const fix = this.floatLayoutFixes[index];
            fix.el.removeAttribute("data-reader-float-layout-fixed");
            restoreInlineStyleProperty(fix.el.style, "margin-left", fix.left);
            restoreInlineStyleProperty(fix.el.style, "margin-right", fix.right);
            restoreInlineStyleProperty(fix.el.style, "width", fix.width);
            restoreInlineStyleProperty(fix.el.style, "max-width", fix.maxWidth);
          }
          this.floatLayoutFixes.splice(snapshotStart);
          // Keep the Stage 1 firewall in place after a failed group trial.
          members.forEach((member, index) =>
            preserveFloatLayout(member, originalMargins[index].left, originalMargins[index].right)
          );
        }
      }

      const autoMarginBatch = createAutoMarginBatch();
      for (const el of candidates) {
        // 同一测量周期内已修正过则跳过，避免把上次写回的 margin
        // 再当成书 margin 叠加一次（导致 namebox 732/-32 这类错误）。
        if (
          el.hasAttribute("data-reader-margin-fixed") ||
          el.hasAttribute("data-reader-float-layout-fixed")
        ) continue;
        void el.offsetWidth;
        const cs = win.getComputedStyle(el);
        const left = cs.marginLeft;
        const right = cs.marginRight;
        const parent = el.parentElement;
        const parentCs = parent && doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
        const parentW = resolveBlockContainingContentWidth(
          this.viewer,
          this.scrollMode,
          this.effectiveColumnWidth,
          this.contentDoc,
          parent,
          parentCs
        );
        const width = widths.get(el) ?? el.getBoundingClientRect().width;
        const meaningful = isMeaningfulHorizontalMargin;
        const originalMaxWidth = maxWidths.get(el) ?? "";
        const hadFitContent =
          fitContentElements.has(el) || /(?:fit-content|max-content)/.test(originalMaxWidth);
        const percentage = percentageMargins.get(el);
        const fullpage =
          el.classList.contains("illus") ||
          el.classList.contains("kuchie") ||
          el.classList.contains("cover") ||
          el.classList.contains("duokan-image-fullscreen");
        const isTopFloat =
          el.classList.contains("reader-top") && /^(?:left|right)$/u.test(cs.float.trim().toLowerCase());


        // Float is a separate layout unit. It must never fall through to the
        // ordinary block margin compensator, even when a conservative gate
        // decides that the original book geometry cannot be projected.
        if (isTopFloat) {
          const floatGroupMember = percentageFloatGroupMembers.has(el);
          const floatMargins = floatGroupMember
            ? null
            : getReaderTopFloatLayoutMargins({
                readerTop: true,
                float: cs.float,
                fullpage,
                parentWidth: parentW,
                width,
                contentWidth: TEXT_MEASURE.maxEm * this.settings.fontSizePx,
                marginLeft: left,
                marginRight: right,
                authorFullWidthIntent:
                  groupEntriesByElement.get(el)?.authorFullWidthIntent ??
                  hasAuthorFullWidthIntent(doc, el),
                authoredHorizontalMargin: authoredHorizontalMargins.get(el),
                percentageMargin: percentage?.percentage,
                position: cs.position,
                writingMode: cs.writingMode,
                parentWritingMode: parentCs?.writingMode,
                direction: cs.direction,
              });
          if (floatMargins) {
            preserveFloatLayout(el, `${floatMargins.left}px`, `${floatMargins.right}px`);
          } else if (floatGroupMember || !fullpage) {
            // Preserve the measured author/UA result through restoration of
            // L3 auto margins. This is deliberately a px snapshot for this
            // measure cycle; the next cycle restores and re-measures it.
            preserveFloatLayout(el, left, right);
          }
          continue;
        }

        // [L4-C16] 百分比水平 margin 已经以包含块为基准，不能再叠加版心
        // base。此时 max-width 已按需解除，computed width/margin 就是书的
        // 原始页面布局；用 inline important 穿过 L3 margin 默认值写回。
        if (isPercentageMarginLayout(percentage?.percentage === true, left, right)) {
          const insets = symmetricPercentageInsets.get(el);
          const ml = parseFloat(left) || 0;
          const mr = parseFloat(right) || 0;
          this.marginFixes.push({
            el,
            left: snapshotInlineStyleProperty(el.style, "margin-left"),
            right: snapshotInlineStyleProperty(el.style, "margin-right"),
            maxWidth: insets || percentage?.relaxedReaderMaxWidth ? percentage?.maxWidth : undefined,
          });
          el.setAttribute("data-reader-margin-fixed", "1");
          if (insets) el.style.setProperty("max-width", `${insets.maxWidth}px`);
          el.style.setProperty("margin-left", `${insets?.left ?? ml}px`, "important");
          el.style.setProperty("margin-right", `${insets?.right ?? mr}px`, "important");
          continue;
        }

        // 有百分比声明但实际水平值为 0：不属于流体定位，撤销上面为测量
        // 临时写入的 max-width，继续走普通版心逻辑。
        if (percentage?.relaxedReaderMaxWidth && percentage.maxWidth) {
          restoreInlineStyleProperty(el.style, "max-width", percentage.maxWidth);
        }

        // 书明确写了“收缩到内容宽度”（fit-content / max-content）且没有
        // 左右 margin：这是左对齐的内容容器，应放到版心列左缘，而不是
        // 被 L3 强制居中或贴在窗口最左。
        if (
          !meaningful(left) &&
          !meaningful(right) &&
          hadFitContent
        ) {
          const columnW = TEXT_MEASURE.maxEm * this.settings.fontSizePx;
          const desiredLeft = Math.max(0, (parentW - columnW) / 2);
          this.marginFixes.push({
            el,
            left: snapshotInlineStyleProperty(el.style, "margin-left"),
            right: snapshotInlineStyleProperty(el.style, "margin-right"),
          });
          el.setAttribute("data-reader-margin-fixed", "1");
          el.style.setProperty("margin-left", `${desiredLeft}px`, "important");
          el.style.setProperty(
            "margin-right",
            `${parentW - desiredLeft - width}px`,
            "important"
          );
          continue;
        }

        // [L3/L4-C31] Chromium may let a top-level float escape the reader's
        // 40rem containing block: with the reader auto margin temporarily
        // removed, restore only the physical float-side inset. Keep this
        // branch after the intrinsic-size path so C-18 retains precedence.
        // Explicit author margins, full-page classes, a box wider than the
        // reader measure, or authored full-width/breakout intent all remain
        // in the book's original layout.
        // [L3/L4-C37] UA blockquote margins describe symmetric inner留白.
        // Preserve that meaning by shrinking the effective max-width while
        // leaving reader-top auto centering in charge after this transaction.
        // This must stay after C-31 and before C-04; authored/unknown margins,
        // floats, full-page elements and intrinsic-size paths never enter it.
        const uaSymmetricMaxWidth =
          !hadFitContent
            ? getReaderTopUaSymmetricInsetMaxWidth({
                readerTop: el.classList.contains("reader-top"),
                authoredHorizontalMargin: authoredHorizontalMargins.get(el),
                float: cs.float,
                fullpage:
                  el.classList.contains("illus") ||
                  el.classList.contains("kuchie") ||
                  el.classList.contains("cover") ||
                  el.classList.contains("duokan-image-fullscreen"),
                percentageMargin: percentage?.percentage,
                parentWidth: parentW,
                borderBoxWidth: width,
                cssWidth: Number.parseFloat(cs.width),
                boxSizing: cs.boxSizing,
                marginLeft: left,
                marginRight: right,
              })
            : null;
        if (uaSymmetricMaxWidth !== null) {
          this.marginFixes.push({
            el,
            left: snapshotInlineStyleProperty(el.style, "margin-left"),
            right: snapshotInlineStyleProperty(el.style, "margin-right"),
            maxWidth: snapshotInlineStyleProperty(el.style, "max-width"),
          });
          el.setAttribute("data-reader-margin-fixed", "1");
          el.style.setProperty("max-width", `${uaSymmetricMaxWidth}px`, "important");
          continue;
        }

        // [L3/L4-C40] Explicit positive symmetric author margins on a normal
        // centered block are bilateral whitespace. Keep the restored reader
        // auto margins instead of translating the left value into C-04's
        // one-sided indentation. Fixed/unknown sizing intent stays conservative.
        if (
          shouldKeepCenteredAuthorMargins({
            readerTop: el.classList.contains("reader-top"),
            float: cs.float,
            writingMode: cs.writingMode,
            fullpage,
            intrinsicSize: hadFitContent,
            percentageMargin: percentage?.percentage,
            authoredHorizontalMargin: authoredHorizontalMargins.get(el),
            authoredSizingIntent: authoredSizingIntents.get(el),
            textAlign: cs.textAlign,
            marginLeft: left,
            marginRight: right,
          })
        ) {
          continue;
        }

        if (!meaningful(left) && !meaningful(right)) {
          if (
            !viewer.classList.contains("fullpage-image") &&
            !viewer.classList.contains("pure-image-page") &&
            shouldRestoreReaderTopAutoMargin({
              readerTop: el.classList.contains("reader-top"),
              float: cs.float,
              display: cs.display,
              position: cs.position,
              writingMode: cs.writingMode,
              fullpage: fullpage || viewer.classList.contains("fullpage-image") || viewer.classList.contains("pure-image-page"),
              percentageMargin: percentage?.percentage,
              borderBoxWidth: width,
              contentWidth: Math.min(parentW, TEXT_MEASURE.maxEm * this.settings.fontSizePx),
            })
          ) {
            autoMarginBatch.add(el);
          }
          continue;
        }

        // An auto-width grouping block's nonnegative margins fit *inside* the
        // default measure, just as they do inside a constrained parent link.
        // Otherwise a direct sibling is wider than an identical nested card.
        const blockInsets = authoredHorizontalMargins.get(el) === true ? getReaderAutoBlockInsets({
          heading: /^h[1-6]$/iu.test(el.localName),
          groupedBlockContent: Array.from(el.children).some((child) =>
            /^(?:block|flow-root|flex|grid|table|list-item)$/u.test(win.getComputedStyle(child).display)),
          percentage: percentage?.percentage, authoredSizing: authoredSizingIntents.get(el),
          float: cs.float, display: cs.display, position: cs.position, writingMode: cs.writingMode,
          parentWidth: parentW, contentWidth: TEXT_MEASURE.maxEm * this.settings.fontSizePx,
          marginLeft: parseFloat(left), marginRight: parseFloat(right),
          borderBoxExtra: Math.max(0, width - parseFloat(cs.width)),
        }) : null;
        if (blockInsets) {
          this.marginFixes.push({ el,
            left: snapshotInlineStyleProperty(el.style, "margin-left"),
            right: snapshotInlineStyleProperty(el.style, "margin-right"),
            maxWidth: snapshotInlineStyleProperty(el.style, "max-width"),
          });
          el.setAttribute("data-reader-margin-fixed", "1");
          el.style.setProperty("max-width", `${blockInsets.maxWidth}px`);
          el.style.setProperty("margin-left", `${blockInsets.left}px`, "important");
          el.style.setProperty("margin-right", `${blockInsets.right}px`, "important");
          continue;
        }

        // [L3/L4-C37] getComputedStyle exposes UA blockquote margins as px.
        // They are not author indentation and must retain the restored L3
        // reader-top auto centering instead of being reinterpreted by C-04.
        // `undefined` intentionally retains the old compatibility path.
        if (!shouldApplyBookMarginCompensation(authoredHorizontalMargins.get(el))) {
          continue;
        }

        const ml = parseFloat(left) || 0;
        const mr = parseFloat(right) || 0;

        // [L3/L4 窄屏固定长度缩进] 先看 Typed OM 的最终 margin token：
        // 长度 24/24 在窄屏也会恰好等于居中余量，不得再被 isAutoLike 当成 auto。
        // 只对单栏宽不超过默认版心的普通横排顶层标题生效；宽屏仍走原 C-24/C-04
        // 路径，因此宽屏目录位置保持不变。
        const heading = /^h[1-6]$/iu.test(el.localName);
        if (
          !this.fixedLayout &&
          heading &&
          el.classList.contains("reader-top") &&
          !fullpage &&
          cs.textAlign.trim().toLowerCase() !== "center" &&
          cs.float.trim().toLowerCase() === "none" &&
          /^(?:static|relative)$/u.test(cs.position.trim().toLowerCase()) &&
          cs.writingMode.trim().toLowerCase() === "horizontal-tb" &&
          /^(?:block|flow-root)$/u.test(cs.display.trim().toLowerCase()) &&
          percentage?.percentage === false &&
          !hadFitContent &&
          authoredSizingIntents.get(el) === false
        ) {
          const measureWidth = TEXT_MEASURE.maxEm * this.settings.fontSizePx;
          if (parentW <= measureWidth + 0.5) {
            const typedMargins = readComputedHorizontalMarginSpecifiedValues(el);
            const typedLeft = typedMargins?.left;
            const typedRight = typedMargins?.right;
            if (
              resolvedMarginKind(typedLeft) === "length" &&
              resolvedMarginKind(typedRight) === "length"
            ) {
              const typedMl = Number.parseFloat(typedLeft as string);
              const typedMr = Number.parseFloat(typedRight as string);
              if (
                Number.isFinite(typedMl) &&
                Number.isFinite(typedMr) &&
                typedMl >= 0 &&
                typedMr >= 0 &&
                typedMl + typedMr > 0 &&
                typedMl + typedMr < measureWidth
              ) {
                const paddingBorderWidth =
                  (parseFloat(cs.paddingLeft) || 0) +
                  (parseFloat(cs.paddingRight) || 0) +
                  (parseFloat(cs.borderLeftWidth) || 0) +
                  (parseFloat(cs.borderRightWidth) || 0);
                const plan = planAutoBlockBox({
                  containerWidth: parentW,
                  measureWidth,
                  marginLeft: typedMl,
                  marginRight: typedMr,
                  boxSizing: cs.boxSizing === "border-box" ? "border-box" : "content-box",
                  paddingBorderWidth,
                });
                if (plan.maxWidth > 0) {
                  this.marginFixes.push({
                    el,
                    left: snapshotInlineStyleProperty(el.style, "margin-left"),
                    right: snapshotInlineStyleProperty(el.style, "margin-right"),
                    maxWidth: snapshotInlineStyleProperty(el.style, "max-width"),
                  });
                  el.setAttribute("data-reader-margin-fixed", "1");
                  el.style.setProperty("max-width", `${plan.maxWidth}px`);
                  el.style.setProperty("margin-left", `${plan.marginLeft}px`, "important");
                  el.style.setProperty("margin-right", `${plan.marginRight}px`, "important");
                  continue;
                }
              }
            }
          }
        }

        // 作者/阅读器真正的 auto margin 即使在 computed style 中已变成 px，
        // 仍应保持居中；显式相等 margin 不会恰好等于全部剩余空间。
        if (
          isAutoLikeHorizontalMargin({
            parentWidth: parentW,
            width,
            marginLeft: ml,
            marginRight: mr,
          })
        ) {
          continue;
        }

        // [L3/L4-C18] fit/max-content 盒的 margin:1em 是双侧留白，经过
        // intrinsic-size 补偿后保持 reader auto 居中。普通 width:auto 或
        // 固定宽度元素仍走 C-04，保留作者相对正文版心的显式缩进。
        if (shouldKeepSymmetricMarginsCentered(left, right, hadFitContent)) continue;

        // [L3/L4-C16] Typed OM 和 CSSOM 都无法证明 margin 来源时，只在
        // 作者原位留有余量、叠加正文版心必越列的严格情形保留原位。
        // 这不是按尺寸猜百分比；普通 2em 缩进和原位本就越列都不会命中。
        if (
          percentage?.percentage === undefined &&
          shouldKeepContainingBlockMarginsWhenBaseWouldOverflow({
            parentWidth: parentW,
            width,
            marginLeft: ml,
            marginRight: mr,
          })
        ) {
          this.marginFixes.push({
            el,
            left: snapshotInlineStyleProperty(el.style, "margin-left"),
            right: snapshotInlineStyleProperty(el.style, "margin-right"),
          });
          el.setAttribute("data-reader-margin-fixed", "1");
          el.style.setProperty("margin-left", `${ml}px`, "important");
          el.style.setProperty("margin-right", `${mr}px`, "important");
          continue;
        }

        // 把书的不对称 margin 解释为“相对居中版心列的缩进”：
        // 正文列左缘 = (parent - width)/2；书 margin-left:2em 意味着
        // 元素左缘再缩进 2em，与正文首行 text-indent 对齐。
        const base = (parentW - width) / 2;
        let desiredLeft: number;
        let desiredRight: number;
        if (ml > 0) {
          desiredLeft = base + ml;
          desiredRight = parentW - desiredLeft - width;
        } else if (mr > 0) {
          desiredRight = base + mr;
          desiredLeft = parentW - desiredRight - width;
        } else {
          continue;
        }

        this.marginFixes.push({
          el,
          left: snapshotInlineStyleProperty(el.style, "margin-left"),
          right: snapshotInlineStyleProperty(el.style, "margin-right"),
        });
        el.setAttribute("data-reader-margin-fixed", "1");
        el.style.setProperty("margin-left", `${desiredLeft}px`, "important");
        el.style.setProperty("margin-right", `${desiredRight}px`, "important");
      }
      autoMarginBatch.flush((fix) => this.marginFixes.push(fix));
    } finally {
      restoreReaderMargins();
    }
  }

  private disableReaderTopMarginRules(sheet: CSSStyleSheet): () => void {
    const saved: Array<{
      style: CSSStyleDeclaration;
      left: string;
      leftPriority: string;
      right: string;
      rightPriority: string;
    }> = [];
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule.type !== CSSRule.STYLE_RULE) continue;
      const style = (rule as CSSStyleRule).style;
      const selector = (rule as CSSStyleRule).selectorText ?? "";
      if (!selector.includes("reader-top")) continue;
      if (style.marginLeft !== "auto" && style.marginRight !== "auto") continue;
      saved.push({
        style,
        left: style.getPropertyValue("margin-left"),
        leftPriority: style.getPropertyPriority("margin-left"),
        right: style.getPropertyValue("margin-right"),
        rightPriority: style.getPropertyPriority("margin-right"),
      });
      style.removeProperty("margin-left");
      style.removeProperty("margin-right");
    }
    return () => {
      for (const item of saved) {
        item.style.setProperty("margin-left", item.left, item.leftPriority);
        item.style.setProperty("margin-right", item.right, item.rightPriority);
      }
    };
  }

  private restoreFitContentFix(): void {
    for (const fix of this.fitContentFixes) {
      fix.el.style.setProperty("max-width", fix.maxWidth);
    }
    this.fitContentFixes = [];
  }

  private applyFitContentFix(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView) return;
    const win = doc.defaultView;
    for (const el of Array.from(viewer.querySelectorAll("*")) as HTMLElement[]) {
      if (el.closest(".illus, .kuchie, .cover, .duokan-image-fullscreen")) {
        continue;
      }
      const mw = win.getComputedStyle(el).maxWidth;
      if (!mw.includes("fit-content")) continue;
      this.fitContentFixes.push({ el, maxWidth: el.style.maxWidth });
      el.style.setProperty("max-width", `${TEXT_MEASURE.maxEm}rem`);
    }
  }

  private restoreFloatWidths(): void {
    for (const el of this.floatFixes) el.style.removeProperty("width");
    this.floatFixes = [];
  }

  private restoreFloatLayoutFixes(): void {
    for (const fix of this.floatLayoutFixes) {
      fix.el.removeAttribute("data-reader-float-layout-fixed");
      restoreInlineStyleProperty(fix.el.style, "margin-left", fix.left);
      restoreInlineStyleProperty(fix.el.style, "margin-right", fix.right);
      restoreInlineStyleProperty(fix.el.style, "width", fix.width);
      restoreInlineStyleProperty(fix.el.style, "max-width", fix.maxWidth);
    }
    this.floatLayoutFixes = [];
  }

  private restoreTrailingFloatFixes(): void {
    for (const fix of this.trailingFloatFixes) {
      restoreInlineStyleProperty(fix.el.style, "margin-top", fix.marginTop);
    }
    this.trailingFloatFixes = [];
  }

  private restoreInlineBoxFixes(): void {
    for (const fix of this.inlineClipFixes ?? []) {
      restoreInlineStyleProperty(fix.el.style, "overflow-x", fix.overflowX);
    }
    this.inlineClipFixes = [];
    for (const fix of this.inlineBoxFixes) {
      // The marker is only a per-measure guard.  It must not survive the
      // restore phase or a later resize/reflow would skip the candidate.
      fix.el.removeAttribute("data-reader-inline-box-fixed");
      restoreInlineStyleProperty(fix.el.style, "display", fix.display);
      restoreInlineStyleProperty(fix.el.style, "text-indent", fix.textIndent);
    }
    this.inlineBoxFixes = [];
  }

  private applyInlineBoxOverflowFix(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView) return;
    const win = doc.defaultView;
    const epsilon = 0.5;

    const isExcludedSemanticNode = (el: HTMLElement): boolean => {
      const tag = el.tagName.toLowerCase();
      if (tag === "a" || tag === "ruby" || tag === "rt" || tag === "rp" || tag === "sup") {
        return true;
      }
      return Boolean(el.closest("ruby, rt, rp, sup, .duokan-footnote, .zhangyue-footnote"));
    };

    type InlineFixRect = {
      left: number;
      right: number;
      top: number;
      bottom: number;
      width: number;
      height: number;
    };
    const toInlineFixRect = (r: DOMRect): InlineFixRect => ({
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    });
    const validInlineFixRect = (r: InlineFixRect): boolean =>
      Number.isFinite(r.left) &&
      Number.isFinite(r.right) &&
      Number.isFinite(r.top) &&
      Number.isFinite(r.bottom) &&
      Number.isFinite(r.width) &&
      Number.isFinite(r.height) &&
      r.width > 0 &&
      r.height > 0;

    const geometry = this.spreadGeometry;
    let space: FragmentSpace | null = null;
    if (geometry && geometry.columnWidth > 0 && geometry.columnStep > 0) {
      try {
        const viewerRect = viewer.getBoundingClientRect();
        const viewerStyle = win.getComputedStyle(viewer);
        const paddingLeft = parseFloat(viewerStyle.paddingLeft) || 0;
        space = {
          geometry,
          originClientX: viewerRect.left + (viewer.clientLeft || 0) + paddingLeft,
          scrollLeft: viewer.scrollLeft || 0,
        };
      } catch {
        space = null;
      }
    }
    // 分页正文片段必须按当前物理栏匹配；没有几何时不猜测整屏 union。
    if (!space) return;

    /** 目标 inline 必须只有一个可见 fragment；跨栏/多段目标留给原独立语义。 */
    const targetFragment = (el: HTMLElement): InlineFixRect | null => {
      const rects = Array.from(el.getClientRects()).map(toInlineFixRect).filter(validInlineFixRect);
      return rects.length === 1 ? rects[0] : null;
    };

    const lineContainer = (
      el: HTMLElement,
      target: InlineFixRect
    ): { el: HTMLElement; rect: InlineFixRect; textAlign: string } | null => {
      // 取目标片段左缘附近的内部点：右对齐盒可能向右越界，居中点会落到
      // 父片段/物理栏之外，反而让新匹配器拒绝正确目标。
      const point = {
        x: target.left + Math.min(1, target.width / 2),
        y: target.top + target.height / 2,
      };
      if (columnAtPoint(point, space) === null) return null;
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const cs = win.getComputedStyle(parent);
        if (/^(?:inline|ruby)$/u.test(cs.display)) continue;
        // 明确范围：横排 LTR、无 transform 的普通流父块。复杂坐标不套本匹配，
        // 保持原布局，不以整屏 union 兜底。
        if (
          cs.writingMode.trim().toLowerCase() !== "horizontal-tb" ||
          cs.direction.trim().toLowerCase() !== "ltr" ||
          cs.transform.trim().toLowerCase() !== "none" ||
          !/^(static|relative)$/u.test(cs.position.trim().toLowerCase()) ||
          cs.float.trim().toLowerCase() !== "none"
        ) {
          return null;
        }
        // 分页根自身 rect 跨整屏，不是可筛选的内容片段；直接取目标物理栏边界。
        if (parent === viewer) {
          const column = columnAtPoint(point, space);
          if (column === null) return null;
          const left = space.originClientX - space.scrollLeft + column * space.geometry.columnStep;
          return {
            el: parent,
            rect: {
              left,
              right: left + space.geometry.columnWidth,
              top: target.top,
              bottom: target.bottom,
              width: space.geometry.columnWidth,
              height: target.height,
            },
            textAlign: cs.textAlign,
          };
        }
        const rects = Array.from(parent.getClientRects()).map(toInlineFixRect).filter(validInlineFixRect);
        const matching = containingFragmentAtPoint(rects, point, space, epsilon);
        if (matching === null) return null;
        return { el: parent, rect: rects[matching], textAlign: cs.textAlign };
      }
      return null;
    };

    for (const el of Array.from(viewer.querySelectorAll("*")) as HTMLElement[]) {
      // Most chapter nodes do not carry manual padding whitespace.  Check
      // text before getComputedStyle to avoid forcing style/layout work for
      // every element on every measure pass.
      if (!hasTrailingManualPaddingWhitespace(el.textContent ?? "")) continue;
      if (el.hasAttribute("data-reader-inline-box-fixed") || isExcludedSemanticNode(el)) {
        continue;
      }
      const cs = win.getComputedStyle(el);
      if (cs.display !== "inline") continue;
      const originalDisplay = cs.display;
      if (!hasVisibleInlineBox(cs)) continue;

      const before = targetFragment(el);
      if (!before) continue;
      const container = lineContainer(el, before);
      if (!container || container.textAlign.trim().toLowerCase() !== "right") {
        continue;
      }
      if (before.right <= container.rect.right + epsilon) continue;

      // C-25: preserve inline alignment and unequal painted lengths. Clip
      // only a simple line whose entire non-whitespace content is inside it;
      // overflow:clip does not create a BFC or alter column fragmentation.
      const line = container.el;
      if (this.inlineClipFixes.some((fix) => fix.el === line)) continue;
      const lineStyle = win.getComputedStyle(line);
      const simpleLine = lineStyle.display === "block" && lineStyle.writingMode === "horizontal-tb" &&
        lineStyle.direction === "ltr" && lineStyle.transform === "none" && lineStyle.overflowX === "visible" && lineStyle.overflowY === "visible" &&
        Array.from(line.querySelectorAll("*")).every((child) =>
          win.getComputedStyle(child).display === "inline" && !child.matches("img, svg, ruby, sup, input"));
      if (simpleLine) {
        const walker = doc.createTreeWalker(line, 4 /* SHOW_TEXT */);
        const range = doc.createRange();
        let safe = true;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? "";
          const first = text.search(/\S/u);
          if (first < 0) continue;
          range.setStart(node, first);
          range.setEnd(node, text.trimEnd().length);
          if (Array.from(range.getClientRects()).some((r) => r.left < container.rect.left - epsilon || r.right > container.rect.right + epsilon)) {
            safe = false;
            break;
          }
        }
        if (safe && win.CSS.supports("overflow-x", "clip")) {
          this.inlineClipFixes.push({ el: line, overflowX: snapshotInlineStyleProperty(line.style, "overflow-x") });
          line.style.setProperty("overflow-x", "clip", "important");
          continue;
        }
      }

      const original = {
        display: snapshotInlineStyleProperty(el.style, "display"),
        textIndent: snapshotInlineStyleProperty(el.style, "text-indent"),
      };
      el.style.setProperty("display", "inline-block", "important");
      el.style.setProperty("text-indent", "0", "important");
      void el.offsetWidth;
      const after = targetFragment(el);
      if (!after) {
        restoreInlineStyleProperty(el.style, "display", original.display);
        restoreInlineStyleProperty(el.style, "text-indent", original.textIndent);
        continue;
      }
      const afterContainer = lineContainer(el, after) ?? container;
      const effective = shouldApplyInlineBoxOverflowFix({
        display: originalDisplay,
        trailingPaddingWhitespace: true,
        visibleBox: true,
        textAlign: container.textAlign,
        rectRight: before.right,
        containerRight: container.rect.right,
        fixedRectRight: after.right,
        fixedWidth: after.width,
        containerWidth: afterContainer.rect.width,
      });
      if (!effective) {
        restoreInlineStyleProperty(el.style, "display", original.display);
        restoreInlineStyleProperty(el.style, "text-indent", original.textIndent);
        continue;
      }
      el.setAttribute("data-reader-inline-box-fixed", "1");
      this.inlineBoxFixes.push({ el, ...original });
    }
  }

  private applyFloatShrinkFix(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView) return;
    const win = doc.defaultView;
    const canvas = doc.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const familiesOf = (fontFamily: string): string[] =>
      fontFamily
        .split(",")
        .map((f) => f.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);

    const textWidth = (text: string, parent: Element | null): number => {
      if (!text) return 0;
      const cs = parent ? win.getComputedStyle(parent) : null;
      const families = cs ? familiesOf(cs.fontFamily) : ["sans-serif"];
      const style = cs
        ? `${cs.fontWeight} ${cs.fontSize}`
        : "400 16px";
      for (const family of families) {
        ctx.font = `${style} ${family}`;
        const w = ctx.measureText(text).width;
        if (w > 0) return w;
      }
      return 0;
    };

    const measureNode = (node: Node): number => {
      if (node.nodeType === 3) {
        return textWidth(node.textContent ?? "", node.parentElement);
      }
      if (node.nodeType !== 1) return 0;
      const el = node as HTMLElement;
      if (el.tagName.toLowerCase() === "br") return 0;
      const cs = win.getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      if (tag !== "img" && tag !== "svg" && cs.display !== "inline") return 0;
      const r = el.getBoundingClientRect();
      if (r.width > 0) return r.width;
      const img = el as HTMLImageElement;
      if (img.naturalWidth) return img.naturalWidth;
      return 0;
    };

    for (const el of Array.from(viewer.querySelectorAll("*")) as HTMLElement[]) {
      const cs = win.getComputedStyle(el);
      if (cs.float === "none") continue;
      // C-08 measures horizontal inline advance. An orthogonal paragraph's
      // narrow physical width is the intended line thickness, not collapse.
      if (cs.writingMode !== "horizontal-tb") continue;
      if (hasAuthoredInlineWidth(el.getAttribute("style") ?? "")) continue;
      // 只修复“塌缩成逐字宽”的浮动元素；已有明确宽度且正常布局
      // （如目录标题 width:100% + float:left）不处理。
      const currentWidth = parseFloat(cs.width);
      if (!Number.isFinite(currentWidth) || currentWidth > 48) continue;
      // [L5-C23] 小头像等媒体本来就可能窄于 48px；源码缩进空白不是内容，
      // 不能由 Canvas 累加后反向撑宽其 float 容器。
      if (isMediaOnlyFloatContent(el.childNodes)) continue;
      if (
        Array.from(el.children).some((c) => {
          const d = win.getComputedStyle(c as Element).display;
          return (
            d.startsWith("block") ||
            d.startsWith("list-item") ||
            d === "table" ||
            d === "flex"
          );
        })
      ) {
        continue;
      }
      let maxContent = 0;
      let lineWidth = 0;
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 1 && (n as HTMLElement).tagName.toLowerCase() === "br") {
          maxContent = Math.max(maxContent, lineWidth);
          lineWidth = 0;
          continue;
        }
        lineWidth += measureNode(n);
      }
      maxContent = Math.max(maxContent, lineWidth);
      if (maxContent <= 0) continue;
      const padding =
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const border =
        (parseFloat(cs.borderLeftWidth) || 0) +
        (parseFloat(cs.borderRightWidth) || 0);
      const parent = el.parentElement;
      const parentCs =
        parent && doc.defaultView ? doc.defaultView.getComputedStyle(parent) : null;
      const avail =
        (parent ? parent.clientWidth : viewer.clientWidth) -
        (parseFloat(parentCs?.paddingLeft ?? "") || 0) -
        (parseFloat(parentCs?.paddingRight ?? "") || 0) -
        (parseFloat(cs.marginLeft) || 0) -
        (parseFloat(cs.marginRight) || 0);
      const target = Math.max(0, Math.min(maxContent + padding + border, avail));
      el.style.setProperty("width", `${target}px`);
      this.floatFixes.push(el);
    }
  }

  private applyTrailingFloatMarginFix(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !doc.defaultView || this.step <= 0 || this.pageWidth <= 0) return;
    const children = Array.from(viewer.children) as HTMLElement[];
    const candidate = children.at(-1);
    if (!candidate) return;
    const win = doc.defaultView;
    const cs = win.getComputedStyle(candidate);
    if (!/^(?:left|right)$/u.test(cs.float) || !/^(?:static|relative)$/u.test(cs.position)) return;
    if (!isMediaOnlyFloatSubtree(candidate.childNodes)) return;

    const viewerRect = viewer.getBoundingClientRect();
    const viewerCs = win.getComputedStyle(viewer);
    const paddingBottom = parseFloat(viewerCs.paddingBottom) || 0;
    const contentBottom = viewerRect.bottom - paddingBottom;
    // 列坐标原点是 viewer 内容盒左缘（单页边距写在 viewer 的左右 padding 里）。
    const viewerContentLeft = viewerRect.left + (viewer.clientLeft || 0) + (parseFloat(viewerCs.paddingLeft) || 0);
    const epsilon = 0.5;
    const toRect = (r: DOMRect): FloatFixRect => ({
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    });
    const rectsOf = (el: Element): FloatFixRect[] =>
      Array.from(el.getClientRects()).map(toRect).filter((r) => r.width > 0 && r.height > 0);
    const beforeRects = rectsOf(candidate);
    if (!beforeRects.length) return;
    const columnFor = (x: number): number =>
      Math.floor((x + viewer.scrollLeft - viewerContentLeft + epsilon) / this.step);
    const columnsFor = (rects: FloatFixRect[]): number[] =>
      Array.from(
        new Set(
          rects.flatMap((r) => [columnFor(r.left), columnFor(Math.max(r.left, r.right - epsilon))])
        )
      );
    const beforeColumns = columnsFor(beforeRects);
    if (beforeColumns.length < 2) return;
    const firstColumn = Math.min(...beforeColumns);
    const firstColumnTop = Math.min(
      ...beforeRects
        .filter((rect) => columnFor(rect.left) === firstColumn)
        .map((rect) => rect.top)
    );
    const scrollHeight = candidate.scrollHeight;
    if (!Number.isFinite(scrollHeight) || scrollHeight <= 0 || !Number.isFinite(firstColumnTop)) {
      return;
    }
    const estimatedBeforeBottom = firstColumnTop + scrollHeight;
    if (estimatedBeforeBottom <= contentBottom + epsilon) return;

    const originalMarginTop = snapshotInlineStyleProperty(candidate.style, "margin-top");
    const computedMarginTop = parseFloat(cs.marginTop);
    const shift = estimatedBeforeBottom - contentBottom + 1;
    if (!Number.isFinite(shift) || shift <= 0) return;
    const baseMargin = Number.isFinite(computedMarginTop) ? computedMarginTop : 0;
    candidate.style.setProperty("margin-top", `${baseMargin - shift}px`, "important");
    void viewer.offsetWidth;
    const afterRects = rectsOf(candidate);
    const visualRectsOf = (root: HTMLElement): FloatFixRect[] =>
      [root, ...Array.from(root.querySelectorAll("*")) as HTMLElement[]]
        .flatMap((el) => rectsOf(el));
    const afterVisualRects = visualRectsOf(candidate);
    const previousVisualRects = children
      .slice(0, -1)
      .flatMap((el) => visualRectsOf(el));
    const afterColumns = columnsFor(afterRects);
    const accepted = shouldApplyTrailingFloatMarginFix({
      float: cs.float,
      position: cs.position,
      mediaOnly: true,
      beforeColumns,
      afterColumns,
      afterRects,
      afterVisualRects,
      previousVisualRects,
      estimatedBeforeBottom,
      contentBottom,
      viewerLeft: viewerContentLeft,
      scrollLeft: viewer.scrollLeft,
      step: this.step,
      pageWidth: this.pageWidth,
      epsilon,
    });
    if (!accepted) {
      restoreInlineStyleProperty(candidate.style, "margin-top", originalMarginTop);
      return;
    }
    this.trailingFloatFixes.push({ el: candidate, marginTop: originalMarginTop });
  }

  private async recompute(
    useAnchor: boolean,
    loadSeq: number = this.loadSeq
  ): Promise<boolean> {
    // 章节代号校验：切章后旧章的延迟重排（图片加载防抖等）一律丢弃，
    // 否则旧 DOM 的锚点/页数会污染新章（表现：卡死在上一章末页）
    if (this.disposed || loadSeq !== this.loadSeq) return false;
    const viewer = this.viewer;
    // 分页需要列步长；滚动模式由 viewer 自身滚动，不依赖列步长。
    if (!viewer || (!this.scrollMode && this.step <= 0)) return false;
    // 自愈：viewer 为空但 body 里还有内容（内容落在容器外）时，重新包裹
    if (viewer.children.length === 0) {
      const doc = this.contentDoc;
      const body = doc?.body;
      let moved = 0;
      if (body) {
        const nodes = Array.from(body.childNodes);
        for (const n of nodes) {
          if (n === viewer) continue;
          viewer.appendChild(n);
          moved++;
        }
      }
      if (moved > 0) {
        this.textIndex = null;
        if (!(await this.measure(loadSeq))) return false;
        if (this.disposed || loadSeq !== this.loadSeq) return false;
        this.rebuildTextIndexForCurrentDoc();
        return this.recompute(useAnchor, loadSeq);
      }
    }
    if (this.scrollMode) {
      if (!this.fixedLayout) this.applyContainedMediaMaxWidth();
      this.recomputeScroll();
      const settled = !this.disposed && loadSeq === this.loadSeq;
      // 只有已稳定且仍属当前代次时才通知，过期结果不得触发宿主重测
      if (settled) this.onLayoutSettled?.();
      return settled;
    }
    // 图片晚加载后的既有 recompute 链也要套用同一局部限宽；已有快照时
    // 复用原作者上限，不把上一轮补丁当成新的作者约束。
    if (!this.fixedLayout) this.applyContainedMediaMaxWidth();
    const sw = viewer.scrollWidth;
    const hasContent =
      viewer.children.length > 0 || (viewer.textContent ?? "").trim().length > 0;
    if (sw <= 0 || !hasContent) {
      this.metrics = { pageCount: 1, currentPage: 0 };
      this.emit({ status: "ready", pageCount: 1, currentPage: 0, empty: true });
      return true;
    }
    // 纵向裁剪检测：只有横向分栏尚未生效时才可能靠重测修复。若内容已横向
    // 溢出（scrollWidth > clientWidth），多栏已成立；此处的纵向差异重测不会
    // 改变几何，重复 measure/double-rAF 只是空转。仍保留最多 2 次自愈重试。
    if (
      viewer.scrollHeight > viewer.clientHeight + 1 &&
      sw <= viewer.clientWidth + 1
    ) {
      if (this.recomputeRetries < 2) {
        this.recomputeRetries++;
        if (!(await this.measure(loadSeq))) return false;
        if (this.disposed || loadSeq !== this.loadSeq) return false;
        this.rebuildTextIndexForCurrentDoc();
        return this.recompute(useAnchor, loadSeq);
      }
    }
    this.recomputeInner(useAnchor, loadSeq);
    return !this.disposed && loadSeq === this.loadSeq;
  }

  /**
   * 滚动模式的最终定位：入口锚点、章末标记与文本高亮都在显示门内完成。
   * 页数只是“把当前章按可用屏高切成几屏”的进度口径，不用于定位。
   */
  private recomputeScroll(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    // B-151：先按真实内容判断空章，再决定是否追加“全书完”卡片。这样
    // 隐藏但非空的 nav/空白章节可以完成 ready(empty)，同时 H 不包含 reader 节点。
    if (this.getContinuousContentHeight() <= 0) {
      this.metrics = { pageCount: 1, currentPage: 0 };
      this.scrollPageCount = 1;
      this.pendingFallbackPage = null;
      this.pendingAnchor = undefined;
      this.pendingStartAtEnd = false;
      this.pendingRestoreAnchor = null;
      this.lastScrollTop = viewer.scrollTop;
      this.emit(this.readyState(true));
      return;
    }
    this.renderScrollChapterEnd();
    const metrics = this.scrollMetrics();
    const pageCount = Math.max(1, Math.ceil(metrics.contentHeight / Math.max(1, metrics.viewportHeight)));
    // 索引、笔记与搜索高亮必须在入口定位前重建（F4 保持）。
    this.rebuildTextIndexForCurrentDoc();
    this.applyScrollRestore(this.pendingFallbackPage, this.pendingRestoreAnchor);
    this.pendingFallbackPage = null;
    this.pendingAnchor = undefined;
    this.pendingStartAtEnd = false;
    this.scrollPageCount = pageCount;
    this.pendingRestoreAnchor = null;
    this.syncScrollMetrics(false);
  }

  /** 滚动模式章末自然过渡卡片：本章完 / 进入下一章 / 全书完提示 */
  private renderScrollChapterEnd(): void {
    if (
      !this.scrollMode ||
      !this.contentDoc ||
      !this.viewer ||
      typeof this.viewer.querySelector !== "function" ||
      typeof this.contentDoc.createElement !== "function"
    ) {
      return;
    }
    const existing = this.viewer.querySelector('[data-reader="chapter-end"]');
    if (existing) {
      existing.remove();
    }

    // 连续滚动模式下章节自然连续衔接，不插入切章卡片或切章按钮；仅全书末尾保留结束提示。
    if (this.hasNextChapter) {
      return;
    }

    const endEl = this.contentDoc.createElement("div");
    endEl.className = "reader-chapter-end";
    endEl.setAttribute("data-reader", "chapter-end");

    const divider = this.contentDoc.createElement("div");
    divider.className = "chapter-end-divider";
    const span = this.contentDoc.createElement("span");
    span.textContent = "全书完";
    divider.appendChild(span);
    endEl.appendChild(divider);

    const hint = this.contentDoc.createElement("div");
    hint.className = "chapter-end-hint";
    hint.textContent = "已读完全部章节";
    endEl.appendChild(hint);

    this.viewer.appendChild(endEl);
  }


  private recomputeInner(useAnchor: boolean, loadSeq: number): void {
    if (loadSeq !== this.loadSeq) return; // 过期章节：丢弃
    const viewer = this.viewer;
    if (!viewer || this.step <= 0) return;
    if (!this.textIndex) {
      this.rebuildTextIndexForCurrentDoc();
    }
    this.bookmarkSpreadCache.clear();

    const geometry = this.spreadGeometry ?? createSpreadGeometry(
      this.pageWidth,
      this.settings.gapPx,
      this.fixedLayout ? 1 : this.settings.columnsPerView === 2 ? 2 : 1,
      MIN_COLUMN_WIDTH_PX,
    );
    this.spreadGeometry = geometry;
    this.effectiveColumns = geometry.columns;

    const fragments = this.collectContentFragments();
    const occupied = occupiedColumns(fragments, geometry);
    const layout = createSpreadLayout(geometry, occupied);
    this.spreadLayout = layout;

    if (layout.empty) {
      this.removeTailSpacer();
      this.metrics = { pageCount: 1, currentPage: 0 };
      this.emit({
        status: "ready",
        pageCount: 1,
        currentPage: 0,
        empty: true,
        mode: "paginated",
        effectiveColumns: geometry.columns,
        leafRange: null,
      });
      return;
    }

    const pageCount = layout.pageCount;
    this.leadingColumns = layout.firstColumn;

    // 阅读位置保留：窗口缩放/设置变化用内容锚点定位；
    // 图片加载等内容变化保留当前页号（否则内容下移会把人拉到后几页）
    const resolvedAnchor = useAnchor ? this.resolveAnchorCol() : null;
    const anchorCol = resolvedAnchor?.col ?? null;
    const restored = resolveRestoredPage({
      pageCount,
      anchorCol,
      fallbackPage: this.pendingFallbackPage,
      currentPage: this.metrics.currentPage,
    });
    const current = restored.page;

    // 关键：唯一分页位置提交入口，并同步调整尾垫
    const commitResult = commitSpreadPosition(this.viewportPort, layout, current);
    const finalPage = commitResult.ok ? commitResult.page : current;
    this.metrics = { pageCount, currentPage: finalPage };

    // A legacy element anchor only chooses the column. Once there, observe
    // the current page centre to upgrade it to the text anchor used by new
    // progress writes; no layout rule is changed.
    if (resolvedAnchor?.source === "legacy") this.captureAnchor();
    this.emit(this.readyState(false));
    // 粘性锚点：使用锚点恢复时不重新取样（否则恢复后页心可能是下一段，
    // 反复缩放会逐段漂移）；仅当无锚点（首次加载）时建立
    if (anchorCol === null) this.captureAnchor();
    // A failed content/legacy anchor must consume the saved page only after it
    // has really been applied. It cannot be overwritten by the fresh centre
    // sample above before this point.
    if (restored.consumeFallback) this.pendingFallbackPage = null;
  }

  /** @internal 供测试与历史布局边界校验复用 */
  contentExtent(): { minX: number; maxX: number } {
    const viewer = this.viewer as any;
    if (!viewer) return { minX: 0, maxX: 0 };
    const fixes = new Set<any>((this.inlineClipFixes ?? []).map((f) => f.el));
    const all = Array.from(viewer.querySelectorAll?.("*") ?? []) as any[];
    let minX = Infinity;
    let maxX = -Infinity;
    for (const el of all) {
      if (fixes.has(el)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          const l = r.left + (viewer.scrollLeft || 0);
          const right = (r.right ?? r.left + r.width) + (viewer.scrollLeft || 0);
          if (l < minX) minX = l;
          if (right > maxX) maxX = right;
        }
        continue;
      }
      let skip = false;
      for (const fixEl of fixes) {
        const children = fixEl.querySelectorAll?.("*") ? Array.from(fixEl.querySelectorAll("*")) : [];
        if (children.includes(el)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        const l = r.left + (viewer.scrollLeft || 0);
        const right = (r.right ?? r.left + r.width) + (viewer.scrollLeft || 0);
        if (l < minX) minX = l;
        if (right > maxX) maxX = right;
      }
    }
    return minX === Infinity ? { minX: 0, maxX: 0 } : { minX, maxX };
  }

  private collectContentFragments(): Array<{ left: number; right: number }> {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (!viewer || !doc) return [];
    const fragments: Array<{ left: number; right: number }> = [];
    const scrollLeft = viewer.scrollLeft || 0;
    const viewerRect = viewer.getBoundingClientRect();
    let paddingLeft = 0;
    try {
      const cs = doc.defaultView?.getComputedStyle(viewer);
      paddingLeft = parseFloat(cs?.paddingLeft ?? "") || 0;
    } catch {
      paddingLeft = 0;
    }
    const originClientX = viewerRect.left + (viewer.clientLeft || 0) + paddingLeft;

    const clipBounds = new Map<Element, DOMRect>();
    for (const fix of this.inlineClipFixes) {
      const bounds = fix.el.getBoundingClientRect();
      clipBounds.set(fix.el, bounds);
      for (const child of Array.from(fix.el.querySelectorAll("*"))) {
        clipBounds.set(child, bounds);
      }
    }

    if (this.textIndex) {
      for (const range of this.textIndex.collectTextRanges(doc)) {
        try {
          const parent = range.startContainer.parentElement;
          if (parent?.closest?.('[data-reader="tail-spacer"]')) continue;
          const rects = range.getClientRects();
          const clip = parent ? clipBounds.get(parent) : undefined;
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (r.width <= 0 && r.height <= 0) continue;
            const rLeft = Math.max(r.left, clip?.left ?? -Infinity);
            const rRight = Math.min(r.right, clip?.right ?? Infinity);
            if (rRight <= rLeft) continue;
            fragments.push({
              left: clientXToColumnX(rLeft, originClientX, scrollLeft),
              right: clientXToColumnX(rRight, originClientX, scrollLeft),
            });
          }
        } catch {
          // ignore
        }
      }
    }

    for (const el of this.collectMediaElements()) {
      try {
        if (el.closest?.('[data-reader="tail-spacer"]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) continue;
        const clip = clipBounds.get(el);
        const rLeft = Math.max(r.left, clip?.left ?? -Infinity);
        const rRight = Math.min(r.right, clip?.right ?? Infinity);
        if (rRight <= rLeft) continue;
        fragments.push({
          left: clientXToColumnX(rLeft, originClientX, scrollLeft),
          right: clientXToColumnX(rRight, originClientX, scrollLeft),
        });
      } catch {
        // ignore
      }
    }

    if (fragments.length === 0) {
      for (const el of Array.from(viewer.querySelectorAll("*"))) {
        if (el.getAttribute("data-reader") === "tail-spacer") continue;
        if (el.classList.contains("reader-chapter-end")) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        fragments.push({
          left: clientXToColumnX(r.left, originClientX, scrollLeft),
          right: clientXToColumnX(r.right, originClientX, scrollLeft),
        });
      }
    }

    return fragments;
  }

  private ensureTailSpacer(requiredScrollWidth: number): void {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (!viewer || !doc || this.scrollMode) {
      this.removeTailSpacer();
      return;
    }
    let spacer = this.tailSpacer;
    if (!spacer || spacer.ownerDocument !== doc || !viewer.contains(spacer)) {
      spacer = viewer.querySelector<HTMLElement>(':scope > [data-reader="tail-spacer"]');
      if (!spacer) {
        spacer = doc.createElement("div");
        spacer.setAttribute("data-reader", "tail-spacer");
        spacer.setAttribute("aria-hidden", "true");
        spacer.style.position = "absolute";
        spacer.style.top = "0";
        spacer.style.width = "1px";
        spacer.style.height = "1px";
        spacer.style.pointerEvents = "none";
        spacer.style.opacity = "0";
        spacer.style.margin = "0";
        spacer.style.padding = "0";
        spacer.style.border = "none";
        viewer.appendChild(spacer);
      }
      this.tailSpacer = spacer;
    }
    // requiredScrollWidth 是 viewer 内容盒口径；绝对尾垫定位在 padding box，
    // 水平 padding 需补一次物理宽度（border 不参与 scrollable overflow）。
    let horizontalPadding = 0;
    try {
      const cs = doc.defaultView?.getComputedStyle(viewer);
      horizontalPadding =
        (parseFloat(cs?.paddingLeft ?? "") || 0) +
        (parseFloat(cs?.paddingRight ?? "") || 0);
    } catch {
      horizontalPadding = 0;
    }
    const physicalScrollWidth = requiredScrollWidth + horizontalPadding;
    if (physicalScrollWidth > viewer.clientWidth) {
      spacer.style.left = `${Math.ceil(physicalScrollWidth - 1)}px`;
      spacer.style.display = "block";
    } else {
      spacer.style.display = "none";
    }
  }

  private removeTailSpacer(): void {
    if (this.tailSpacer) {
      try {
        this.tailSpacer.remove();
      } catch {
        // ignore
      }
      this.tailSpacer = null;
    }
    const existing = this.viewer?.querySelector(':scope > [data-reader="tail-spacer"]');
    existing?.remove();
  }

  private get viewportPort(): PagedViewportPort {
    return {
      ensureScrollWidth: (width: number) => {
        this.ensureTailSpacer(width);
      },
      readScrollWidth: () => this.viewer?.scrollWidth ?? 0,
      readClientWidth: () => this.viewer?.clientWidth ?? 0,
      readScrollLeft: () => this.viewer?.scrollLeft ?? 0,
      writeScrollLeft: (value: number) => {
        if (this.viewer) {
          this.viewer.scrollLeft = value;
        }
      },
    };
  }

  private rebuildTextIndexForCurrentDoc(): void {
    if (!this.contentDoc || !this.viewer || this.disposed) {
      this.textIndex = null;
      return;
    }
    this.textIndex = buildVisibleTextIndex(this.contentDoc, this.viewer);
    // F4：设置重载后重建笔记/搜索高亮；重建不是一次新的用户跳转。
    this.applyNoteHighlights();
    this.reapplySearchHighlight();
    this.noteHighlightsApplied = true;
  }

  private handleContextMenu(e: MouseEvent): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || !viewer.contains(e.target as Node | null)) return;
    e.preventDefault();
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;
    const payload = captureTextSelection(doc, viewer, index);
    this.selectionContextMenuOpen = Boolean(payload);
    this.selectionContextMenuHandler?.(payload ? { ...payload, chapterPath: this._currentPath } : null);
  }

  private handleSelectionChange(): void {
    if (!this.selectionContextMenuOpen) return;
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer) return;
    const selection = doc.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.selectionContextMenuOpen = false;
      this.selectionContextMenuHandler?.(null);
      return;
    }
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;
    const payload = captureTextSelection(doc, viewer, index, selection);
    if (!payload) {
      this.selectionContextMenuOpen = false;
      this.selectionContextMenuHandler?.(null);
      return;
    }
    this.selectionContextMenuHandler?.({ ...payload, chapterPath: this._currentPath });
  }

  private requestAnchorFrame(callback: () => void): number {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === "function" && typeof globalThis.cancelAnimationFrame === "function") {
      this.pendingAnchorFrameKind = "raf";
      return raf(() => callback());
    }
    this.pendingAnchorFrameKind = "timer";
    return globalThis.setTimeout(callback, 0) as unknown as number;
  }

  private cancelAnchorFrame(frame: number): void {
    if (this.pendingAnchorFrameKind === "raf") globalThis.cancelAnimationFrame(frame);
    else globalThis.clearTimeout(frame as unknown as ReturnType<typeof setTimeout>);
  }

  /** 普通翻页只登记一次下一帧采样；连续翻页合并为最后一页。 */
  private scheduleAnchorSample(): void {
    const loadSeq = this.loadSeq;
    const page = this.metrics.currentPage;
    if (this.pendingAnchorFrame != null) {
      this.pendingAnchorLoadSeq = loadSeq;
      this.pendingAnchorPage = page;
      return;
    }
    const currentEpoch = this.anchorSampleEpoch ?? 0;
    this.pendingAnchorEpoch = currentEpoch;
    this.pendingAnchorLoadSeq = loadSeq;
    this.pendingAnchorPage = page;
    this.pendingAnchorFrame = this.requestAnchorFrame(() => {
      this.pendingAnchorFrame = null;
      const pendingEpoch = this.pendingAnchorEpoch;
      const pendingLoad = this.pendingAnchorLoadSeq;
      const pendingPage = this.pendingAnchorPage;
      this.pendingAnchorEpoch = -1;
      this.pendingAnchorLoadSeq = -1;
      this.pendingAnchorPage = -1;
      if (
        pendingEpoch === (this.anchorSampleEpoch ?? 0) &&
        pendingLoad === this.loadSeq &&
        pendingPage === this.metrics.currentPage &&
        !this.disposed
      ) {
        this.captureAnchor();
      }
    });
  }

  /** 丢弃未执行的下一帧采样，不写锚点；换章/销毁/显式提交用。 */
  private cancelPendingAnchorSample(): void {
    this.anchorSampleEpoch = (this.anchorSampleEpoch ?? 0) + 1;
    if (this.pendingAnchorFrame != null) {
      this.cancelAnchorFrame(this.pendingAnchorFrame);
      this.pendingAnchorFrame = null;
    }
    this.pendingAnchorEpoch = -1;
    this.pendingAnchorLoadSeq = -1;
    this.pendingAnchorPage = -1;
  }

  /** 同步补齐最新一页的采样；书签/进度/历史/关书前调用。返回是否实际采样。 */
  private flushReadingAnchor(): boolean {
    if (this.pendingAnchorFrame == null) return false;
    const frame = this.pendingAnchorFrame;
    this.pendingAnchorFrame = null;
    this.cancelAnchorFrame(frame);
    const previousEpoch = this.anchorSampleEpoch ?? 0;
    this.anchorSampleEpoch = previousEpoch + 1;
    const pendingEpoch = this.pendingAnchorEpoch;
    const pendingLoad = this.pendingAnchorLoadSeq;
    const pendingPage = this.pendingAnchorPage;
    this.pendingAnchorEpoch = -1;
    this.pendingAnchorLoadSeq = -1;
    this.pendingAnchorPage = -1;
    if (
      pendingEpoch === previousEpoch &&
      pendingLoad === this.loadSeq &&
      pendingPage === this.metrics.currentPage &&
      !this.disposed
    ) {
      this.captureAnchor();
      return true;
    }
    return false;
  }

  /**
   * Observe the current visible position only. This method never inserts spacers or
   * changes styles: pagination has already happened and remains natural from the
   * chapter's first page. Paginated mode samples the first visible column (not the
   * screen centre, which can be the inter-column gap); scroll mode samples the top
   * of the visible area.
   */
  private captureAnchor(): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || viewer.clientWidth <= 0) return;
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;
    const anchor = captureVisibleAnchor({
      viewer,
      doc,
      index,
      mode: this.scrollMode ? "scroll" : "paginated",
      visibleRatio: this.scrollMode ? 0.12 : 0.5,
      geometry: this.scrollMode
        ? undefined
        : {
            columnWidth: this.effectiveColumnWidth,
            columnStep: this.effectiveColumnStep,
            viewStep: this.effectiveViewStep,
            leadingColumns: this.leadingColumns,
          },
    });
    if (!anchor) return;
    this.anchor = anchor;
    this.anchorPath = this._currentPath;
  }

  /** 内容坐标：先减 viewer 实际内容左原点（viewerRect.left + border + padding），再加 scrollLeft。 */
  private contentX(clientLeft: number): number {
    const viewer = this.viewer;
    if (!viewer) return clientLeft;
    let paddingLeft = 0;
    try {
      const computed = this.contentDoc?.defaultView?.getComputedStyle(viewer);
      paddingLeft = parseFloat(computed?.paddingLeft ?? "") || 0;
    } catch {
      paddingLeft = 0;
    }
    const viewerRect =
      typeof viewer.getBoundingClientRect === "function"
        ? viewer.getBoundingClientRect()
        : { left: 0, top: 0, width: (viewer as HTMLElement).clientWidth || 0, height: (viewer as HTMLElement).clientHeight || 0 };
    const originClientX = viewerRect.left + (viewer.clientLeft || 0) + paddingLeft;
    return clientXToColumnX(clientLeft, originClientX, viewer.scrollLeft || 0);
  }

  private resolveTextAnchorCol(index: VisibleTextIndex, textOffset: number): number | null {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || this.step <= 0) return null;
    const start = index.positionForOffset(textOffset);
    const end = index.positionForOffset(Math.min(index.totalChars, textOffset + 1));
    if (!start || !end) return null;
    try {
      const range = doc.createRange();
      range.setStart(start.node, start.rawOffset);
      range.setEnd(end.node, end.rawOffset);
      const rect = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 || candidate.height > 0);
      if (!rect) return null;
      if (this.spreadLayout) {
        const colX = this.contentX(rect.left);
        const physical = columnForContentPoint(colX, this.spreadLayout.geometry);
        return spreadForColumn(this.spreadLayout, physical);
      }
      // 分栏时同一屏内第二栏命中留在包含它的那一屏：物理列 → 屏号。
      const physical = Math.max(0, Math.floor(this.contentX(rect.left) / this.step));
      return Math.max(0, columnToView(physical, this.leadingColumns, this.effectiveColumns));
    } catch {
      return null;
    }
  }

  private resolveAnchorCol(): ResolvedAnchorColumn | null {
    const viewer = this.viewer;
    if (!viewer || !this.anchor || this.step <= 0 || this.anchorPath !== this._currentPath) return null;
    const index = this.textIndex;
    if (this.anchor.textOffset !== null) {
      if (index) {
        const offset = resolveTextAnchorOffset(index, this.anchor);
        if (offset !== null) {
          const col = this.resolveTextAnchorCol(index, offset);
          if (col !== null) {
            this.anchor.textOffset = offset;
            this.anchor.textSnippet = index.snippetAt(offset);
            this.anchor.charsRead = offset;
            this.anchor.totalChars = index.totalChars;
            this.anchor.mediaUnits = index.mediaUnits;
            return { col, source: "text" };
          }
        }
      }
      // A stale/ambiguous text anchor must not remain sticky after legacy
      // fallback succeeds. It would otherwise keep preventing the upgrade.
      this.anchor.textOffset = null;
      this.anchor.textSnippet = null;
      this.anchor.charsRead = 0;
    }
    const all = Array.from(viewer.querySelectorAll("*"));
    if (!Number.isSafeInteger(this.anchor.index) || this.anchor.index < 0 || this.anchor.index >= all.length) return null;
    const el = all[this.anchor.index] as HTMLElement;
    const rect = el.getBoundingClientRect();
    if (this.spreadLayout) {
      const absX = this.contentX(rect.left) + this.anchor.ratio * rect.width;
      const physical = columnForContentPoint(absX, this.spreadLayout.geometry);
      return {
        col: spreadForColumn(this.spreadLayout, physical),
        source: "legacy",
      };
    }
    const absX = this.contentX(rect.left) + this.anchor.ratio * rect.width;
    const physical = Math.max(0, Math.floor(absX / this.step));
    return {
      col: Math.max(0, columnToView(physical, this.leadingColumns, this.effectiveColumns)),
      source: "legacy",
    };
  }

  /** 提交一个已解析位置：分页对齐到屏边界，滚动由调用方先写入 scrollTop。 */
  private applyResolvedPosition(
    page: number,
    candidate: ReadingAnchor | null,
    options?: { preserveCandidate?: boolean },
  ): void {
    const viewer = this.viewer;
    if (!viewer) return;
    // R5：任何显式位置提交都必须撤销此前 setPage 留下的下一帧普通采样，
    // 否则旧 RAF 会用页内采样值覆盖精确搜索/笔记候选。
    this.cancelPendingAnchorSample?.();
    if (!this.scrollMode && this.spreadLayout) {
      const commitRes = commitSpreadPosition(this.viewportPort, this.spreadLayout, page);
      if (commitRes.ok) {
        page = commitRes.page;
      }
    } else if (!this.scrollMode) {
      viewer.scrollLeft = page * this.viewStepPx;
    }
    if (candidate) {
      this.anchor = candidate;
      this.anchorPath = this._currentPath;
    } else {
      this.anchor = null;
      this.anchorPath = undefined;
    }
    const preserveCandidate = options?.preserveCandidate === true && candidate !== null;
    if (!preserveCandidate) {
      // Normal page turns and user scrolling refresh the reading-line sample.
      const preserved = candidate ? { ...candidate } : null;
      if (this.scrollMode) this.captureScrollAnchor();
      else this.captureAnchor();
      if (preserved && (!this.anchor || this.anchor.textOffset === null)) {
        this.anchor = preserved;
        this.anchorPath = this._currentPath;
      }
    }
    if (this.scrollMode) this.syncScrollMetrics(false);
    else this.emit(this.readyState(false));
  }

  /** 分页一次翻屏的像素步长（双栏 = 两列 + 中缝）。 */
  private get viewStepPx(): number {
    const columns = (this.geometry?.columns ?? this.effectiveColumns) as 1 | 2;
    return columns * (this.step || 0);
  }

  /** Commit a page without treating the center sample as a layout input. */
  private commitWithinChapterPage(
    page: number,
    candidate: ReadingAnchor | null,
    options?: { preserveCandidate?: boolean },
  ): void {
    const viewer = this.viewer;
    if (!viewer) return;
    this.closeFootnoteForNavigation();
    this.clearSearchHighlightForDocument();
    if (this.scrollMode) {
      // 滚动下命令语义是视口移动；真实边界由 UI 的上一章/下一章按钮负责。
      const direction: 1 | -1 = page > this.metrics.currentPage ? 1 : -1;
      const moved = scrollByViewportCommand(direction, this.scrollMetrics(), viewer.scrollTop);
      this.metrics.currentPage = page;
      viewer.scrollTop = moved.scrollTop;
      this.applyResolvedPosition(page, candidate, options);
      return;
    }
    this.metrics.currentPage = page;
    this.applyResolvedPosition(page, candidate, options);
  }

  private restoreBackdropCompatibility(): void {
    this.backdropCompatibilityRestore?.();
    this.backdropCompatibilityRestore = null;
  }

  /** Any real navigation/structure change closes the transient footnote. */
  private closeFootnoteForNavigation(): void {
    this.resetFootnote({ notify: true });
  }

  private resetFootnote(options: { notify: boolean; forceNotify?: boolean }): void {
    const wasOpen = this.footnotePinned || this.footnoteHoverGate.isVisible();
    if (this.footnoteHoverGate) {
      this.footnotePinned = false;
      this.lastFootnoteEl = null;
      this.footnoteHoverGate.reset();
    }
    if (options.notify && (wasOpen || options.forceNotify)) this.onFootnoteClose?.();
  }

  private clearNoteHighlights(): void {
    const css = this.contentDoc?.defaultView?.CSS as
      | (typeof CSS & { highlights?: { delete(name: string): boolean } })
      | undefined;
    const highlights = css?.highlights;
    if (!highlights) {
      return;
    }
    highlights.delete("reader-notes");
  }

  private applyNoteHighlights(): "applied" | "unsupported" | "deferred" {
    const doc = this.contentDoc;
    const index = this.textIndex;
    if (!doc || !this.viewer || !index) return "deferred";
    const css = doc.defaultView?.CSS as
      | (typeof CSS & {
          highlights?: { set(name: string, value: Highlight): unknown; delete(name: string): boolean };
        })
      | undefined;
    const highlights = css?.highlights;
    const HighlightCtor = (doc.defaultView as (Window & { Highlight?: typeof Highlight }) | null)?.Highlight;
    if (!highlights || !HighlightCtor) {
      return "unsupported";
    }
    this.clearNoteHighlights();
    const ranges: Range[] = [];
    for (const note of this.notes) {
      const resolved = resolveTextRangeOffsets(index, note, note.selectedText);
      if (!resolved) continue;
      const range = index.rangeForOffsets(doc, resolved.start, resolved.end);
      if (range) ranges.push(range);
    }
    if (ranges.length > 0) {
      highlights.set("reader-notes", new HighlightCtor(...ranges));
    }
    return "applied";
  }

  /** Remove only the search highlight owned by this paginator. */
  clearSearchHighlight(): void {
    this.searchHighlightTarget = null;
    clearSearchHighlight(this.contentDoc);
  }

  private clearSearchHighlightForDocument(): void {
    this.searchHighlightTarget = null;
    clearSearchHighlight(this.contentDoc);
  }

  private resolveTextRangeCol(index: VisibleTextIndex, start: number, end: number): number | null {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer || this.step <= 0) return null;
    const range = index.rangeForOffsets(doc, start, end);
    if (!range) return null;
    try {
      const rects = Array.from(range.getClientRects())
        .filter((candidate) => candidate.width > 0 || candidate.height > 0);
      const rect = rects[0];
      if (!rect) return null;
      if (this.spreadLayout) {
        const colX = this.contentX(rect.left);
        const physical = columnForContentPoint(colX, this.spreadLayout.geometry);
        return spreadForColumn(this.spreadLayout, physical);
      }
      const physical = Math.max(0, Math.floor(this.contentX(rect.left) / this.step));
      const col = columnToView(physical, this.leadingColumns, this.effectiveColumns);
      return Number.isFinite(col) ? Math.max(0, col) : null;
    } catch {
      return null;
    }
  }

  private reportPreciseStatus(
    request: PreciseNavigationRequest,
    status: PreciseNavigationStatus,
    exact: boolean
  ): void {
    this.onPreciseNavigationStatus?.({ requestId: request.requestId, status, exact });
  }

  /** Rebuild the same target ranges after a real reflow; never reuse old Ranges. */
  private reapplySearchHighlight(): void {
    const doc = this.contentDoc;
    const index = this.textIndex;
    if (!this.searchHighlightTarget) return;
    if (!doc || !index) {
      clearSearchHighlight(doc);
      this.searchHighlightTarget = null;
      return;
    }
    const resolved = this.resolveRequestedTextRanges(index, this.searchHighlightTarget);
    if (!resolved) {
      clearSearchHighlight(doc);
      this.searchHighlightTarget = null;
      return;
    }
    const ranges = this.dedupeHighlightRanges(resolved)
      .map((range) => index.rangeForOffsets(doc, range.start, range.end))
      .filter((range): range is Range => range !== null);
    if (ranges.length === 0) {
      clearSearchHighlight(doc);
      this.searchHighlightTarget = null;
      return;
    }
    const result = applySearchHighlight(doc, ranges);
    if (result === "unsupported") {
      clearSearchHighlight(doc);
      this.searchHighlightTarget = null;
    }
  }

  private dedupeHighlightRanges(ranges: readonly RawTextRange[]): RawTextRange[] {
    const seen = new Set<string>();
    const result: RawTextRange[] = [];
    for (const range of ranges) {
      if (range.end <= range.start) continue;
      const key = `${range.start}:${range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(range);
    }
    return result;
  }

  private buildHighlightRanges(
    doc: Document,
    index: VisibleTextIndex,
    resolved: readonly RawTextRange[]
  ): Range[] | null {
    const ranges: Range[] = [];
    for (const range of this.dedupeHighlightRanges(resolved)) {
      const domRange = index.rangeForOffsets(doc, range.start, range.end);
      if (!domRange) return null;
      ranges.push(domRange);
    }
    return ranges.length > 0 ? ranges : null;
  }

  /** Resolve an immutable request anchor without borrowing the live page sample. */
  private resolveReferenceAnchor(anchor: ReadingAnchor | null): ResolvedAnchorColumn | null {
    if (!anchor || !this.contentDoc || !this.viewer || this.step <= 0) return null;
    const previousAnchor = this.anchor;
    const previousPath = this.anchorPath;
    try {
      this.anchor = { ...anchor };
      this.anchorPath = this._currentPath;
      const resolved = this.resolveAnchorCol();
      if (!resolved || resolved.col < 0 || resolved.col >= this.metrics.pageCount) return null;
      return resolved;
    } catch {
      return null;
    } finally {
      this.anchor = previousAnchor;
      this.anchorPath = previousPath;
    }
  }

  /**
   * Resolve the requested hit group once, using the new-search occurrence
   * identity when present and the legacy exact range resolver only when this
   * request did not come from a new search.
   */
  private resolveRequestedTextRanges(
    index: VisibleTextIndex,
    request: Pick<PreciseNavigationRequest, "textHits" | "occurrence">,
  ): RawTextRange[] | null {
    if (request.occurrence) {
      return resolveSearchOccurrence(index.codePoints, request.occurrence);
    }
    if (request.textHits && request.textHits.length > 0) {
      return resolveExactTextHits(index.codePoints, request.textHits);
    }
    return null;
  }

  private candidateForRange(index: VisibleTextIndex, range: RawTextRange): ReadingAnchor {
    return {
      index: -1,
      ratio: 0,
      charsRead: range.start,
      totalChars: index.totalChars,
      mediaUnits: index.mediaUnits,
      textOffset: range.start,
      textSnippet: index.snippetAt(range.start),
    };
  }

  /**
   * Resolve and commit a same-chapter exact search target.  Ranges are built
   * before any page/hash commit, so a partial Range failure cannot fake a
   * successful navigation.
   */
  navigateToSearchTarget(request: PreciseNavigationRequest): PreciseNavigationStatus {
    const viewer = this.viewer;
    const index = this.textIndex;
    const doc = this.contentDoc;
    if (
      this.disposed ||
      !viewer ||
      !doc ||
      !index ||
      !this._currentPath ||
      (!this.scrollMode && this.step <= 0) ||
      this.metrics.pageCount <= 0 ||
      this.lastState.status !== "ready"
    ) {
      return "unresolved";
    }
    if ((!request.textHits || request.textHits.length === 0) && !request.occurrence) return "unresolved";
    const resolved = this.resolveRequestedTextRanges(index, request);
    if (!resolved) return "unresolved";
    const first = resolved[0];
    const ranges = this.buildHighlightRanges(doc, index, resolved);
    if (!ranges) return "unresolved";
    if (this.scrollMode) {
      // 滚动模式没有屏号：命中位置直接由 Range 换算 scrollTop（与入口锚点同一口径）。
      const target = index.rangeForOffsets(doc, first.start, first.end);
      const inset = Math.round(Math.min(24, Math.max(0, viewer.clientHeight * 0.04)));
      const resolvedTop = target ? this.resolveScrollTopForRange(target, inset) : null;
      if (resolvedTop === null) return "unresolved";
      this.cancelPendingAnchorSample?.();
      this.closeFootnoteForNavigation();
      this.clearSearchHighlightForDocument();
      syncFragmentHash(this.iframe.contentWindow, "");
      viewer.scrollTop = resolvedTop;
      this.syncScrollMetrics(true);
      const appliedInScroll = applySearchHighlight(doc, ranges);
      if (appliedInScroll === "unsupported") {
        this.clearSearchHighlightForDocument();
        return "unsupported-highlight";
      }
      this.searchHighlightTarget = {
        requestId: request.requestId,
        textHits: request.textHits?.map((hit) => ({ ...hit })) ?? [],
        occurrence: cloneSearchOccurrence(request.occurrence),
      };
      return "located";
    }
    const page = this.resolveTextRangeCol(index, first.start, first.end);
    if (page === null || !Number.isSafeInteger(page) || page < 0 || page >= this.metrics.pageCount) {
      return "unresolved";
    }
    const candidate = this.candidateForRange(index, first);
    syncFragmentHash(this.iframe.contentWindow, "");
    this.commitWithinChapterPage(page, candidate, { preserveCandidate: true });
    const applied = applySearchHighlight(doc, ranges);
    if (applied === "unsupported") {
      this.clearSearchHighlightForDocument();
      return "unsupported-highlight";
    }
    this.searchHighlightTarget = {
      requestId: request.requestId,
      textHits: request.textHits?.map((hit) => ({ ...hit })) ?? [],
      occurrence: cloneSearchOccurrence(request.occurrence),
    };
    return "located";
  }

  /** Resolve a cross-chapter exact target after measure/index, before reveal. */
  private applyPendingPreciseNavigation(): PreciseNavigationStatus | null {
    const pending = this.pendingPrecise;
    if (!pending) return null;
    this.pendingPrecise = null;
    const { request, anchor } = pending;
    const doc = this.contentDoc;
    const index = this.textIndex;
    if (!doc || !index || !this.viewer || (!this.scrollMode && this.step <= 0)) {
      this.reportPreciseStatus(request, "unresolved", false);
      return "unresolved";
    }

    const resolved = this.resolveRequestedTextRanges(index, request);
    // Resolve the original request anchor in a temporary slot.  The live
    // this.anchor may already have been replaced by captureAnchor after a
    // failed restore; that page-center sample must never prove success.
    const reference = this.resolveReferenceAnchor(anchor);
    const hasReference = reference !== null;

    if (!resolved) {
      if (request.kind === "note") {
        const status: PreciseNavigationStatus = hasReference ? "located" : "unresolved";
        this.reportPreciseStatus(request, status, false);
        return status;
      }
      const status: PreciseNavigationStatus = hasReference ? "located-reference" : "unresolved";
      this.reportPreciseStatus(request, status, false);
      return status;
    }

    const first = resolved[0];
    const ranges = this.buildHighlightRanges(doc, index, resolved);
    if (this.scrollMode) {
      const target = ranges ? index.rangeForOffsets(doc, first.start, first.end) : null;
      const viewer = this.viewer;
      const inset = viewer ? Math.round(Math.min(24, Math.max(0, viewer.clientHeight * 0.04))) : 0;
      const resolvedTop = target && viewer ? this.resolveScrollTopForRange(target, inset) : null;
      if (!ranges || resolvedTop === null || !viewer) {
        const status: PreciseNavigationStatus = hasReference ? "located-reference" : "unresolved";
        this.reportPreciseStatus(request, status, false);
        return status;
      }
      this.closeFootnoteForNavigation();
      this.clearSearchHighlightForDocument();
      syncFragmentHash(this.iframe.contentWindow, "");
      viewer.scrollTop = resolvedTop;
      this.syncScrollMetrics(true);
      const appliedInScroll = applySearchHighlight(doc, ranges);
      if (appliedInScroll === "unsupported") {
        this.clearSearchHighlightForDocument();
        this.reportPreciseStatus(request, "unsupported-highlight", true);
        return "unsupported-highlight";
      }
      this.searchHighlightTarget = {
        requestId: request.requestId,
        textHits: request.textHits?.map((hit) => ({ ...hit })) ?? [],
        occurrence: cloneSearchOccurrence(request.occurrence),
      };
      this.reportPreciseStatus(request, "located", true);
      return "located";
    }
    const page = ranges ? this.resolveTextRangeCol(index, first.start, first.end) : null;
    if (!ranges || page === null || !Number.isSafeInteger(page) || page < 0 || page >= this.metrics.pageCount) {
      const status: PreciseNavigationStatus = hasReference ? "located-reference" : "unresolved";
      this.reportPreciseStatus(request, status, false);
      return status;
    }

    const candidate = this.candidateForRange(index, first);
    syncFragmentHash(this.iframe.contentWindow, "");
    this.commitWithinChapterPage(page, candidate, { preserveCandidate: request.kind === "search" });
    const applied = applySearchHighlight(doc, ranges);
    if (applied === "unsupported") {
      this.clearSearchHighlightForDocument();
      this.reportPreciseStatus(request, "unsupported-highlight", true);
      return "unsupported-highlight";
    }
    this.searchHighlightTarget = {
      requestId: request.requestId,
      textHits: request.textHits?.map((hit) => ({ ...hit })) ?? [],
      occurrence: cloneSearchOccurrence(request.occurrence),
    };
    this.reportPreciseStatus(request, "located", true);
    return "located";
  }

  private getWithinChapterFragmentPage(fragmentValue: string): { hash: string; page: number } | null {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (!viewer || !doc || this.lastState.status !== "ready") return null;
    if (!this.scrollMode && this.step <= 0) return null;
    const encoded = fragmentValue.startsWith("#") ? fragmentValue.slice(1) : fragmentValue;
    if (encoded.length === 0) return { hash: "", page: 0 };
    const fragment = getFragmentNavigation(`#${encoded}`);
    if (!fragment) return null;
    const target = doc.getElementById(fragment.anchor);
    if (!target) return null;
    if (this.scrollMode) {
      // 滚动模式不产生屏号；命中存在即视为可导航，实际位置在提交时计算。
      return { hash: fragment.hash, page: this.metrics.currentPage };
    }
    const rect = (target as HTMLElement).getBoundingClientRect();
    let page: number;
    if (this.spreadLayout) {
      const colX = this.contentX(rect.left);
      const physical = columnForContentPoint(colX, this.spreadLayout.geometry);
      page = spreadForColumn(this.spreadLayout, physical);
    } else {
      const physical = Math.max(0, Math.floor(this.contentX(rect.left) / this.step));
      page = columnToView(physical, this.leadingColumns, this.effectiveColumns);
    }
    if (!Number.isFinite(page) || page < 0 || page >= this.metrics.pageCount) return null;
    return { hash: fragment.hash, page };
  }

  /**
   * Navigate inside the currently laid-out chapter. This is intentionally a
   * synchronous, no-measure path: failed candidates are evaluated on a local
   * anchor copy and leave the current page/anchor/hash untouched.
   */
  navigateWithinCurrentChapter(options: WithinChapterNavigationOptions = {}): boolean {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (
      this.disposed ||
      !this._currentPath ||
      !doc ||
      !viewer ||
      (!this.scrollMode && this.step <= 0) ||
      this.metrics.pageCount <= 0 ||
      this.lastState.status !== "ready"
    ) {
      return false;
    }

    // 分页模式才走列换算；滚动模式稍后统一按内容 y 定位。
    if (!this.scrollMode && options.fragment !== undefined) {
      const resolved = this.getWithinChapterFragmentPage(options.fragment);
      if (!resolved) return false;
      syncFragmentHash(this.iframe.contentWindow, resolved.hash);
      this.commitWithinChapterPage(resolved.page, null);
      return true;
    }

    if (!this.scrollMode && options.toStart) {
      syncFragmentHash(this.iframe.contentWindow, "");
      this.commitWithinChapterPage(0, null);
      return true;
    }

    if (this.scrollMode) {
      // 滚动模式：目录 fragment 与阅读锚点都走纵向 y，不经过列步长换算。
      const inset = Math.round(Math.min(24, Math.max(0, viewer.clientHeight * 0.04)));
      if (options.fragment !== undefined) {
        const raw = String(options.fragment);
        const encoded = raw.startsWith("#") ? raw.slice(1) : raw;
        if (encoded.length === 0) {
          syncFragmentHash(this.iframe.contentWindow, "");
          viewer.scrollTop = 0;
          this.syncScrollMetrics(false);
          return true;
        }
        const fragment = getFragmentNavigation(`#${encoded}`);
        const target = fragment ? doc.getElementById(fragment.anchor) : null;
        if (!fragment || !target) return false;
        this.cancelPendingAnchorSample?.();
        syncFragmentHash(this.iframe.contentWindow, fragment.hash);
        this.closeFootnoteForNavigation();
        this.clearSearchHighlightForDocument();
        this.scrollToElement(target, inset);
        this.syncScrollMetrics(false);
        return true;
      }
      if (options.toStart) {
        this.cancelPendingAnchorSample?.();
        syncFragmentHash(this.iframe.contentWindow, "");
        this.closeFootnoteForNavigation();
        this.clearSearchHighlightForDocument();
        viewer.scrollTop = 0;
        this.syncScrollMetrics(false);
        return true;
      }
      const adapted = options.readingAnchor ? adaptNavigationAnchor(options.readingAnchor) : null;
      if (!adapted) return false;
      const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
      this.textIndex = index;
      const offset = resolveTextAnchorOffset(index, adapted);
      if (offset === null) return false;
      const position = index.positionForOffset(offset);
      if (!position) return false;
      const range = doc.createRange();
      try {
        range.setStart(position.node, position.rawOffset);
        range.setEnd(position.node, position.rawOffset);
      } catch {
        return false;
      }
      const scrollTop = this.resolveScrollTopForRange(range, inset);
      if (scrollTop === null) return false;
      this.cancelPendingAnchorSample?.();
      syncFragmentHash(this.iframe.contentWindow, "");
      this.closeFootnoteForNavigation();
      this.clearSearchHighlightForDocument();
      viewer.scrollTop = scrollTop;
      this.anchor = {
        ...adapted,
        textOffset: offset,
        textSnippet: index.snippetAt(offset),
        charsRead: offset,
        totalChars: index.totalChars,
        mediaUnits: index.mediaUnits,
      };
      this.anchorPath = this._currentPath;
      this.syncScrollMetrics(false);
      return true;
    }

    let fallback: number | null = null;
    if (options.fallbackPage !== undefined && options.fallbackPage !== null) {
      if (!Number.isSafeInteger(options.fallbackPage) || options.fallbackPage < 0) return false;
      fallback = Math.min(options.fallbackPage, this.metrics.pageCount - 1);
    }

    // R4：请求若提供了文本或媒体身份，解析失败就不能用旧页码冒充成功。
    // 只有确实没有任何语义身份（例如旧的纯 page 记录）才允许走 fallbackPage。
    const hasSemanticTextAnchor = Boolean(
      options.readingAnchor &&
        (options.readingAnchor.anchorTextOffset !== null ||
          options.readingAnchor.anchorTextSnippet !== null),
    );
    const semanticTarget = hasSemanticTextAnchor || Boolean(options.mediaAnchor);
    const adapted = options.readingAnchor ? adaptNavigationAnchor(options.readingAnchor) : null;
    if (adapted) {
      const candidate: ReadingAnchor = { ...adapted };
      // Resolve on a temporary candidate. resolveAnchorCol may clear a stale
      // text anchor while attempting legacy fallback; the live anchor is not
      // touched until the result is known to be usable.
      const previousAnchor = this.anchor;
      const previousPath = this.anchorPath;
      let resolved: ResolvedAnchorColumn | null = null;
      let resolvedCandidate: ReadingAnchor | null = null;
      let resolveFailed = false;
      try {
        this.anchor = candidate;
        this.anchorPath = this._currentPath;
        resolved = this.resolveAnchorCol();
        resolvedCandidate = this.anchor ? { ...this.anchor } : null;
      } catch {
        resolveFailed = true;
      } finally {
        this.anchor = previousAnchor;
        this.anchorPath = previousPath;
      }
      if (resolveFailed) return false;
      if (resolved && resolvedCandidate && resolved.col >= 0 && resolved.col < this.metrics.pageCount) {
        syncFragmentHash(this.iframe.contentWindow, "");
        this.commitWithinChapterPage(resolved.col, resolvedCandidate);
        return true;
      }
    }
    if (semanticTarget) return false;
    if (fallback === null) return false;
    syncFragmentHash(this.iframe.contentWindow, "");
    this.commitWithinChapterPage(fallback, null);
    return true;
  }

  /**
   * 滚动模式下的视口命令：向上/下移动约 0.9 个可用屏高。
   * 返回是否发生真实移动（未移动说明已在章内边界）。
   */
  scrollByViewport(direction: 1 | -1): boolean {
    if (!this.scrollMode || !this.viewer) return false;
    this.cancelScrollAnimation();
    const moved = scrollByViewportCommand(direction, this.scrollMetrics(), this.viewer.scrollTop);
    if (moved.scrollTop === this.viewer.scrollTop) return false;
    this.closeFootnoteForNavigation();
    this.clearSearchHighlightForDocument();
    this.viewer.scrollTop = moved.scrollTop;
    this.syncScrollMetrics(true);
    return true;
  }

  /** 滚动到本章顶部；UI 的“上一章（从底部进入）”入口用它准备位置。 */
  scrollToStart(): void {
    if (!this.scrollMode || !this.viewer) return;
    this.cancelScrollAnimation();
    this.closeFootnoteForNavigation();
    this.clearSearchHighlightForDocument();
    this.viewer.scrollTop = 0;
    this.syncScrollMetrics(true);
  }

  /** 滚动到本章末尾；UI 的“下一章（从顶部进入）”入口用它准备位置。 */
  scrollToEnd(): void {
    if (!this.scrollMode || !this.viewer) return;
    this.cancelScrollAnimation();
    this.closeFootnoteForNavigation();
    this.clearSearchHighlightForDocument();
    this.viewer.scrollTop = scrollMaxTop(this.scrollMetrics());
    this.syncScrollMetrics(true);
  }

  /** 滚动模式：按像素位移平滑滚动正文（模拟标准浏览器原生滚轮阻尼动量）。 */
  scrollByDelta(deltaY: number): void {
    if (!this.scrollMode || !this.viewer || deltaY === 0) return;
    const metrics = this.scrollMetrics();
    const maxTop = scrollMaxTop(metrics);
    const target = nextWheelTarget(this.viewer.scrollTop, this.pendingWheelTarget, deltaY, maxTop);
    if (target === this.viewer.scrollTop && this.pendingWheelTarget === null) return;

    const win = this.contentDoc?.defaultView;
    const raf = win?.requestAnimationFrame?.bind(win);
    if (!raf) {
      this.cancelScrollAnimation();
      this.viewer.scrollTop = target;
      this.syncScrollMetrics(true);
      return;
    }

    this.pendingWheelTarget = target;
    if (typeof this.scrollAnimFrame === "number") return;

    let lastTime: number | null = null;
    const step = (now: number): void => {
      if (!this.viewer || this.pendingWheelTarget === null) {
        this.scrollAnimFrame = null;
        this.pendingWheelTarget = null;
        return;
      }
      const dt = lastTime === null ? 16.7 : Math.min(32, Math.max(1, now - lastTime));
      lastTime = now;
      const current = this.viewer.scrollTop;
      const diff = this.pendingWheelTarget - current;
      if (Math.abs(diff) < 1) {
        this.viewer.scrollTop = this.pendingWheelTarget;
        this.scrollAnimFrame = null;
        this.pendingWheelTarget = null;
        this.syncScrollMetrics(true);
        return;
      }

      // 快速衰减常数（~25ms）：
      // 在 60Hz（dt ≈ 16.7ms）下单帧完成 48.7% 步长，零启动迟滞（无慢速启动）；
      // 4~6 帧（80~100ms）内位移覆盖超 96%，残余 <1.5px 时直接吸附停定（无慢速漂移）。
      // 完美贴合普通桌面网页滚轮的干脆与顺滑手感。
      const decay = 1 - Math.exp(-dt / 25);
      const stepDelta = diff * decay;
      const minStep = 1.2;
      const applied = Math.abs(stepDelta) < minStep ? Math.sign(diff) * minStep : stepDelta;

      if (Math.abs(applied) >= Math.abs(diff)) {
        this.viewer.scrollTop = this.pendingWheelTarget;
        this.scrollAnimFrame = null;
        this.pendingWheelTarget = null;
      } else {
        this.viewer.scrollTop = current + applied;
        this.scrollAnimFrame = raf(step);
      }
      this.syncScrollMetrics(true);
    };

    this.scrollAnimFrame = raf(step);
  }

  /** 当前位置是否已在章内真实边界（不是虚拟屏号边界）。 */
  atScrollBoundary(direction: 1 | -1): boolean {
    if (!this.scrollMode || !this.viewer) return false;
    return scrollByViewportCommand(direction, this.scrollMetrics(), this.viewer.scrollTop).atBoundary;
  }

  /**
   * 连续滚动投影：直接设置 viewer.scrollTop 为 innerTop。
   * 取消旧微动画，不平滑二次位移，不反向触发宿主滚动。
   */
  projectContinuousScroll(innerTop: number): void {
    if (!this.viewer) return;
    this.cancelScrollAnimation();
    this.isProjectingScroll = true;
    this.viewer.scrollTop = innerTop;
    this.lastScrollTop = innerTop;
    this.isProjectingScroll = false;
  }

  /**
   * 测量真实连续内容高度。
   * 排除 clientHeight 强制下限：基于真实文本、图片、SVG、浮动和正外边距测量。
   * 短章返回真实内容高，纯图片保留尺寸，空章返回 0，长章结合 scrollHeight。
   *
   * B-151/B-154：
   * - 只有绘制盒（rect 宽或高 > 0）才算真实内容；不能用非空 textContent
   *   把 display:none 的隐藏 nav 判成正文；
   * - reader 自己的“全书完”提示不进入 contentHeight；
   * - 有内容时把 viewer 上下 padding 计入 H，尤其不能漏掉末尾 padding；
   * - 没有真实内容时返回 0，padding 不制造空章高度。
   */
  getContinuousContentHeight(): number {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (!viewer || !doc) return 0;
    const viewerRect = viewer.getBoundingClientRect();
    if (viewerRect.height <= 0 && viewer.clientHeight <= 0) return 0;

    const win = doc.defaultView;
    // 极简测试替身/异常 DOM 没有 querySelector/children 时按真实滚动范围兜底；
    // 正式 iframe 文档始终走下面的绘制盒测量。
    if (typeof viewer.querySelector !== "function" || !viewer.children) {
      return Math.max(0, viewer.scrollHeight);
    }
    let maxBottom = 0;
    let hasValidContent = false;
    const endEl = viewer.querySelector('[data-reader="chapter-end"]');

    for (const rawChild of Array.from(viewer.children)) {
      if (rawChild === endEl) continue;
      const child = rawChild as Element;
      const rect = child.getBoundingClientRect();
      const hasPaintedBox = rect.height > 0 || rect.width > 0;
      if (!hasPaintedBox) continue;
      hasValidContent = true;
      const style = win?.getComputedStyle(child);
      const mb = style ? parseFloat(style.marginBottom) || 0 : 0;
      const bottom = (rect.bottom - viewerRect.top) + viewer.scrollTop + Math.max(0, mb);
      if (bottom > maxBottom) maxBottom = bottom;
    }

    // 没有元素子节点但存在直接可见文本/替换内容时，Range 的绘制矩形才是
    // 可见性证据；有 chapter-end 时不再用 Range 兜底，避免把“全书完”算成正文。
    if (!hasValidContent && !endEl && (viewer.textContent ?? "").trim().length > 0) {
      try {
        const range = doc.createRange();
        range.selectNodeContents(viewer);
        const rangeRect = range.getBoundingClientRect();
        if (rangeRect.height > 0 || rangeRect.width > 0) {
          hasValidContent = true;
          maxBottom = Math.max(maxBottom, (rangeRect.bottom - viewerRect.top) + viewer.scrollTop);
        }
      } catch {
        // ignore
      }
    }

    if (!hasValidContent) return 0;

    const viewerStyle = win?.getComputedStyle(viewer);
    const paddingBottom = viewerStyle ? Math.max(0, parseFloat(viewerStyle.paddingBottom) || 0) : 0;
    const scrollH = viewer.scrollHeight;
    const clientH = viewer.clientHeight;

    if (scrollH > clientH + 1) {
      const endH = endEl ? (endEl as HTMLElement).offsetHeight : 0;
      return Math.max(maxBottom, scrollH - endH);
    }

    return Math.ceil(maxBottom + paddingBottom);
  }

  /**
   * 给定 iframe 局部阅读线（视口坐标 viewportY），采样可持久化文本锚点及真实内容 y。
   */
  getReadingAnchorAt(viewportY: number): ReadingAnchorAndContentY | null {
    if (!this.viewer || !this.contentDoc) return null;
    const doc = this.contentDoc;
    const viewer = this.viewer;
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;
    const viewerRect = viewer.getBoundingClientRect();
    const x = viewerRect.left + Math.round(viewer.clientWidth * 0.5);
    const y = viewerRect.top + viewportY;
    const anchor = captureAnchorAtPoint({ viewer, doc, index, mode: "scroll", visibleRatio: 0.12 }, { x, y });
    if (!anchor) {
      const fallback = captureVisibleAnchor({ viewer, doc, index, mode: "scroll", visibleRatio: 0.12 });
      if (!fallback) return null;
      return {
        anchor: fallback,
        contentY: viewer.scrollTop + viewportY,
      };
    }
    return {
      anchor,
      contentY: viewer.scrollTop + viewportY,
    };
  }

  /**
   * 重排补偿：把已保存的文本锚点解析回同一文本处的内容纵坐标。
   * 只读当前存活文档，不写任何持久化状态；解析失败返回 null，由调用方回退
   * 到像素锚点。纯图片页没有文字锚点时同样返回 null。
   */
  resolveAnchorContentY(anchor: ReadingAnchor): number | null {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer) return null;
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;
    const offset = resolveTextAnchorOffset(index, anchor);
    if (offset === null) return null;
    const pos = index.positionForOffset(offset);
    if (!pos) return null;
    const length = pos.node.nodeType === 3 ? (pos.node as Text).data.length : pos.node.childNodes.length;
    const raw = Math.max(0, Math.min(pos.rawOffset, length));
    try {
      const range = doc.createRange();
      range.setStart(pos.node, raw);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      if (rect.height === 0 && rect.width === 0 && rect.top === 0) return null;
      const viewerRect = viewer.getBoundingClientRect();
      return rect.top - viewerRect.top + viewer.scrollTop;
    } catch {
      return null;
    }
  }

  /**
   * B-155：只读解析 persisted 文本锚点到当前文档的内容纵坐标。
   * 不写 this.anchor、不滚 viewer、不切换 hash，供连续宿主自行提交外层 S。
   */
  resolvePersistedAnchorContentY(anchor: PersistedNavigationAnchor): number | null {
    const adapted = adaptNavigationAnchor(anchor);
    return adapted ? this.resolveAnchorContentY(adapted) : null;
  }

  /**
   * B-155：把当前章 fragment 解析为未裁剪的内容纵坐标
   * （元素顶边 - viewer 内容顶边 + viewer.scrollTop）。绝不遍历其他槽位。
   */
  resolveFragmentContentY(fragment: string): number | null {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer) return null;
    const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
    if (raw.length === 0) return 0;
    const parsed = getFragmentNavigation(`#${raw}`);
    if (!parsed) return null;
    const target = doc.getElementById(parsed.anchor);
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    if (!Number.isFinite(rect.top)) return null;
    return rect.top - viewer.getBoundingClientRect().top + viewer.scrollTop;
  }

  /**
   * B-155：只读解析精确搜索命中的内容纵坐标，供连续宿主统一提交外层 S。
   * 高亮应用仍由 navigateToSearchTarget 在提交时完成，本方法不改变位置/状态。
   */
  resolveSearchTargetContentY(request: PreciseNavigationRequest): number | null {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    const index = this.textIndex;
    if (this.disposed || !viewer || !doc || !index) return null;
    const resolved = this.resolveRequestedTextRanges(index, request);
    if (!resolved) return null;
    const first = resolved[0];
    const target = index.rangeForOffsets(doc, first.start, first.end);
    if (!target) return null;
    let rect: { top: number } | null = null;
    try {
      const rects = Array.from(target.getClientRects()).filter(
        (candidate) => candidate.width > 0 || candidate.height > 0,
      );
      rect = rects[0] ?? target.getBoundingClientRect();
    } catch {
      return null;
    }
    if (!rect || !Number.isFinite(rect.top)) return null;
    return rect.top - viewer.getBoundingClientRect().top + viewer.scrollTop;
  }

  /**
   * B-155/R2：只读解析并应用搜索高亮，不写 scrollTop、不重新采样、不切 hash、
   * 不发送 paginator 内部定位状态。连续宿主据此在统一几何提交中使用同一份 ranges。
   */
  applySearchTargetHighlight(request: PreciseNavigationRequest): PreciseNavigationStatus {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    const index = this.textIndex;
    if (this.disposed || !viewer || !doc || !index || !this._currentPath) return "unresolved";
    if ((!request.textHits || request.textHits.length === 0) && !request.occurrence) return "unresolved";
    const resolved = this.resolveRequestedTextRanges(index, request);
    if (!resolved) return "unresolved";
    const ranges = this.buildHighlightRanges(doc, index, resolved);
    if (!ranges) return "unresolved";
    this.cancelPendingAnchorSample?.();
    this.clearSearchHighlightForDocument();
    const applied = applySearchHighlight(doc, ranges);
    if (applied === "unsupported") {
      this.clearSearchHighlightForDocument();
      return "unsupported-highlight";
    }
    this.searchHighlightTarget = {
      requestId: request.requestId,
      textHits: request.textHits?.map((hit) => ({ ...hit })) ?? [],
      occurrence: cloneSearchOccurrence(request.occurrence),
    };
    return "located";
  }

  /** 本文档中参与纵向定位的媒体元素；顺序即身份，重排后不改变。媒体为 svg 时不二次计嵌套 image。 */
  private collectMediaElements(): Element[] {
    const viewer = this.viewer;
    if (!viewer) return [];
    const elements = Array.from(viewer.querySelectorAll("img, svg, video"));
    return elements.filter((el) => !elements.some((parent) => parent !== el && parent.contains(el)));
  }

  private mediaSignature(el: Element): string {
    const rawSrc =
      el.getAttribute("src") ?? el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
    // ResourceServer 会话每次重启都会生成新的 blob URL；blob 地址不是可持久化
    // 媒体身份，必须排除，否则同一图片在书架重开后无法恢复。
    const src = /^blob:/i.test(rawSrc) ? "" : rawSrc;
    return [
      el.tagName.toLowerCase(),
      el.getAttribute("id") ?? "",
      el.getAttribute("class") ?? "",
      el.getAttribute("viewBox") ?? "",
      src.slice(-96),
    ].join("|");
  }

  private mediaContentTop(viewer: HTMLElement, rect: DOMRect): number {
    const viewerRect = viewer.getBoundingClientRect();
    return rect.top - viewerRect.top + viewer.scrollTop;
  }

  /**
   * 纯图片页的图内锚点：给定 iframe 局部阅读线，返回包含它的媒体身份与
   * 图内纵向比例。阅读线不落在任何媒体内（图文混排、媒体尚未就绪）返回 null，
   * 由调用方回退到文本锚点或像素锚点。
   */
  getMediaAnchorAt(viewportY: number): MediaAnchorAndContentY | null {
    const viewer = this.viewer;
    if (!viewer) return null;
    const contentY = viewer.scrollTop + viewportY;
    const media = this.collectMediaElements();
    for (let index = 0; index < media.length; index += 1) {
      const el = media[index];
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const top = this.mediaContentTop(viewer, rect);
      if (contentY < top || contentY > top + rect.height) continue;
      return {
        anchor: {
          index,
          tag: el.tagName.toLowerCase(),
          signature: this.mediaSignature(el),
          ratio: Math.max(0, Math.min(1, (contentY - top) / rect.height)),
        },
        contentY,
      };
    }
    return null;
  }

  /**
   * 重排补偿：把已保存的媒体锚点解析回同一图内比例的内容纵坐标。
   * 顺序身份与签名都失效（换文档、换图）时返回 null，不猜替代媒体。
   */
  resolveMediaAnchorContentY(anchor: MediaReadingAnchor): number | null {
    const viewer = this.viewer;
    if (!viewer) return null;
    const media = this.collectMediaElements();
    let el: Element | undefined = media[anchor.index];
    if (!el || el.tagName.toLowerCase() !== anchor.tag || this.mediaSignature(el) !== anchor.signature) {
      el = media.find((candidate) => this.mediaSignature(candidate) === anchor.signature);
    }
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return null;
    return this.mediaContentTop(viewer, rect) + anchor.ratio * rect.height;
  }

  /**
   * B 树统一内容轴：只读解析章内内容比例 (0..1) 对应的纵向 contentY 与持久化锚点。
   * 不改变任何 DOM、不写内部 scrollTop/采样、不先调用 setPage。
   */
  resolveContentFraction(fraction: number): ResolvedContentFraction | null {
    const viewer = this.viewer;
    const doc = this.contentDoc;
    if (this.disposed || !viewer || !doc) return null;
    const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    const index = this.textIndex ?? buildVisibleTextIndex(doc, viewer);
    this.textIndex = index;

    // 1. 有文字（文字章或混排章）：以文字索引为主要内容进度
    if (index && index.totalChars > 0) {
      const N = index.totalChars;
      let offset: number;
      if (f <= 0) {
        offset = 0;
      } else if (f >= 1) {
        offset = N - 1;
      } else {
        offset = Math.min(N - 1, Math.floor(f * N));
      }
      const pos = index.positionForOffset(offset);
      if (!pos) return null;
      const length = pos.node.nodeType === 3 ? (pos.node as Text).data.length : pos.node.childNodes.length;
      const raw = Math.max(0, Math.min(pos.rawOffset, length));
      let contentY: number | null = null;
      try {
        const range = doc.createRange();
        range.setStart(pos.node, raw);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        if (Number.isFinite(rect.top)) {
          contentY = rect.top - viewer.getBoundingClientRect().top + viewer.scrollTop;
        }
      } catch {
        contentY = null;
      }
      if (contentY === null) {
        const el = pos.node.parentElement;
        if (el) {
          const rect = el.getBoundingClientRect();
          if (Number.isFinite(rect.top)) {
            contentY = rect.top - viewer.getBoundingClientRect().top + viewer.scrollTop;
          }
        }
      }
      if (contentY === null) return null;
      const snippet = index.snippetAt(offset);
      const elementIdx = pos.node.parentElement ? index.elementIndex(pos.node.parentElement, viewer) : -1;
      return {
        contentY,
        anchor: {
          index: elementIdx >= 0 ? elementIdx : -1,
          ratio: 0,
          anchorTextOffset: offset,
          anchorTextSnippet: snippet,
        },
        mediaAnchor: null,
        fraction: N > 0 ? offset / N : 0,
      };
    }

    // 2. 纯媒体章节：按可见媒体列表划分区间
    const media = this.collectMediaElements();
    const M = media.length;
    if (M === 0) return null;

    const mediaIdx = Math.min(M - 1, Math.floor(f * M));
    const mediaRatio = Math.max(0, Math.min(1, f * M - mediaIdx));
    const el = media[mediaIdx];
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const top = this.mediaContentTop(viewer, rect);
    const contentY = top + mediaRatio * rect.height;
    const elementIdx = Array.from(viewer.querySelectorAll("*")).indexOf(el as HTMLElement);
    const mediaAnchor: MediaReadingAnchor = {
      index: mediaIdx,
      tag: el.tagName.toLowerCase(),
      signature: this.mediaSignature(el),
      ratio: mediaRatio,
    };
    return {
      contentY,
      anchor: {
        index: elementIdx >= 0 ? elementIdx : -1,
        ratio: mediaRatio,
        anchorTextOffset: null,
        anchorTextSnippet: null,
      },
      mediaAnchor,
      fraction: (mediaIdx + mediaRatio) / M,
    };
  }

  /** 翻到第 i 页（分页）；滚动模式的命令语义由 scrollByViewport 提供。 */
  setPage(i: number): void {
    if (!this.viewer) return;
    const { pageCount } = this.metrics;
    const target = Math.max(0, Math.min(pageCount - 1, Math.floor(i)));
    if (this.scrollMode) {
      this.scrollByViewport(target > this.metrics.currentPage ? 1 : -1);
      return;
    }
    if (this.spreadLayout) {
      this.closeFootnoteForNavigation();
      this.clearSearchHighlightForDocument();
      const res = commitSpreadPosition(this.viewportPort, this.spreadLayout, target);
      if (!res.ok) return;
      this.metrics.currentPage = res.page;
      this.emit(this.readyState(false));
      this.scheduleAnchorSample();
      return;
    }
    const targetScrollLeft = target * this.viewStepPx;
    const actuallyMoved =
      target !== this.metrics.currentPage ||
      Math.abs(this.viewer.scrollLeft - targetScrollLeft) > 0.5;
    if (!actuallyMoved) return;
    this.closeFootnoteForNavigation();
    this.clearSearchHighlightForDocument();
    this.viewer.scrollLeft = targetScrollLeft;
    this.metrics.currentPage = target;
    // 空章判定只由 recompute 负责（此处标记 false，避免误触发自动跳章）
    this.emit(this.readyState(false));
    // B-153：普通翻页热路径只登记一次下一帧采样；连续翻页合并为最后一页。
    this.scheduleAnchorSample();
  }

  /**
   * 翻页动画的视口端点：当前页与同章相邻页的 scrollLeft。只读几何，不提交
   * 页码；滚动模式、无相邻页或尚未布局时返回 null（调用方回退到跨章过渡）。
   */
  pagedSlideFrame(direction: 1 | -1): { from: number; to: number } | null {
    if (!this.viewer || this.scrollMode) return null;
    const current = this.metrics.currentPage;
    const target = current + direction;
    if (target < 0 || target >= this.metrics.pageCount) return null;
    if (this.spreadLayout) {
      this.viewportPort.ensureScrollWidth(this.spreadLayout.requiredScrollWidth);
      return { from: spreadStart(this.spreadLayout, current), to: spreadStart(this.spreadLayout, target) };
    }
    const step = this.viewStepPx;
    if (step <= 0) return null;
    return { from: current * step, to: target * step };
  }

  /**
   * 拖动/动画中间帧：只写视觉 scrollLeft。不改页码、不关弹注、不采样锚点；
   * 结束时由调用方 setPage(目标) 提交，或写回 from 取消。
   */
  previewPagedScroll(scrollLeft: number): void {
    if (!this.viewer || this.scrollMode) return;
    // JS 动画接手时吸附必须关闭，否则中间帧会被就近吸到整页。
    this.disarmNativeSnap();
    this.viewer.scrollLeft = scrollLeft;
  }

  /** 跳到页内锚点（分页：元素所在屏；滚动：元素顶边）。 */
  jumpToAnchor(anchor: string): void {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    if (!doc || !viewer) return;
    const el = doc.getElementById(anchor);
    if (!el) return;
    if (this.scrollMode) {
      this.cancelPendingAnchorSample?.();
      this.closeFootnoteForNavigation();
      this.clearSearchHighlightForDocument();
      this.scrollToElement(el, Math.round(Math.min(24, Math.max(0, viewer.clientHeight * 0.04))));
      this.syncScrollMetrics(false);
      return;
    }
    if (this.step <= 0) return;
    this.closeFootnoteForNavigation();
    this.clearSearchHighlightForDocument();
    const rect = el.getBoundingClientRect();
    if (this.spreadLayout) {
      const colX = this.contentX(rect.left);
      const physical = columnForContentPoint(colX, this.spreadLayout.geometry);
      this.setPage(spreadForColumn(this.spreadLayout, physical));
      return;
    }
    const physical = Math.max(0, Math.floor(this.contentX(rect.left) / this.step));
    this.setPage(columnToView(physical, this.leadingColumns, this.effectiveColumns));
  }

  /**
   * 解析书签属于当前布局的哪一屏；缓存解析结果，布局变化时清空。
   * 支持文本 Range、媒体元素与旧页码兜底。
   */
  resolveBookmarkPage(bookmark: {
    id?: string;
    anchorTextOffset?: number | null;
    anchorTextSnippet?: string | null;
    mediaAnchor?: MediaReadingAnchor | null;
    page?: number;
  }): number | null {
    if (!this.spreadLayout) {
      return bookmark.page ?? null;
    }
    const cacheKey = bookmark.id ?? `${bookmark.anchorTextOffset}:${bookmark.mediaAnchor?.index}:${bookmark.page}`;
    if (this.bookmarkSpreadCache.has(cacheKey)) {
      return this.bookmarkSpreadCache.get(cacheKey)!;
    }
    let targetPage: number | null = null;
    if (this.textIndex && bookmark.anchorTextOffset !== undefined && bookmark.anchorTextOffset !== null) {
      const offset = resolveTextAnchorOffset(this.textIndex, {
        textOffset: bookmark.anchorTextOffset,
        textSnippet: bookmark.anchorTextSnippet ?? null,
      });
      if (offset !== null) {
        targetPage = this.resolveTextAnchorCol(this.textIndex, offset);
      }
    }
    if (targetPage === null && bookmark.mediaAnchor) {
      const media = this.collectMediaElements();
      const el = media[bookmark.mediaAnchor.index];
      if (el) {
        const r = el.getBoundingClientRect();
        const colX = this.contentX(r.left);
        const physical = columnForContentPoint(colX, this.spreadLayout.geometry);
        targetPage = spreadForColumn(this.spreadLayout, physical);
      }
    }
    if (targetPage === null && typeof bookmark.page === "number") {
      targetPage = Math.max(0, Math.min(this.spreadLayout.pageCount - 1, bookmark.page));
    }
    if (targetPage !== null) {
      this.bookmarkSpreadCache.set(cacheKey, targetPage);
    }
    return targetPage;
  }

  /** 当前阅读锚点（供阅读记录持久化与内容进度推算）。 */
  getReadingAnchor(): {
    path: string;
    index: number;
    ratio: number;
    charsRead: number;
    totalChars: number;
    mediaUnits: number;
    textOffset: number | null;
    textSnippet: string | null;
  } | null {
    // 进度写入、书签、历史快照和关书前必须补齐最新一页采样，不能保存旧页。
    this.flushReadingAnchor();
    if (!this.anchor || !this.anchorPath) return null;
    return {
      path: this.anchorPath,
      index: this.anchor.index,
      ratio: this.anchor.ratio,
      charsRead: this.anchor.charsRead,
      totalChars: this.anchor.totalChars,
      mediaUnits: this.anchor.mediaUnits ?? 0,
      textOffset: this.anchor.textOffset,
      textSnippet: this.anchor.textSnippet,
    };
  }

  /** 当前锚点元素的行文本（书签列表展示用）。 */
  getAnchorText(): string | null {
    this.flushReadingAnchor();
    if (!this.contentDoc || !this.viewer || !this.anchor) return null;
    if (this.textIndex && this.anchor.textOffset !== null) {
      const pos = this.textIndex.positionForOffset(this.anchor.textOffset);
      const text = pos?.node.parentElement?.textContent?.replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 80);
    }
    const all = Array.from(this.viewer.querySelectorAll("*"));
    if (!Number.isSafeInteger(this.anchor.index) || this.anchor.index < 0 || this.anchor.index >= all.length) return null;
    const el = all[this.anchor.index] as HTMLElement | undefined;
    if (!el) return null;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 80) : null;
  }

  /** 恢复阅读锚点（打开书时定位到上次阅读处）。 */
  setReadingAnchor(
    path: string,
    a: PersistedNavigationAnchor | ReadingAnchor | null | undefined
  ): ReadingAnchor | null {
    const persisted: PersistedNavigationAnchor | null = a
      ? "anchorTextOffset" in a
        ? a
        : {
            index: a.index,
            ratio: a.ratio,
            anchorTextOffset: a.textOffset,
            anchorTextSnippet: a.textSnippet,
          }
      : null;
    const adapted = adaptNavigationAnchor(persisted);
    if (!adapted) {
      this.anchor = null;
      this.anchorPath = undefined;
      return null;
    }
    this.cancelPendingAnchorSample?.();
    this.anchor = {
      ...adapted,
      totalChars:
        a && "totalChars" in a && typeof a.totalChars === "number" && Number.isSafeInteger(a.totalChars) && a.totalChars >= 0
          ? a.totalChars
          : adapted.totalChars,
    };
    this.anchorPath = path;
    return { ...this.anchor };
  }

  get pageCount(): number {
    return this.metrics.pageCount;
  }

  get currentPage(): number {
    return this.metrics.currentPage;
  }

  get totalChars(): number {
    return this.textIndex?.totalChars ?? this.anchor?.totalChars ?? 0;
  }

  get mediaUnits(): number {
    return this.collectMediaElements().length;
  }

  /** 预渲染调度器只读快照；不得据此绕过 display-ready 准备边界。 */
  getStateSnapshot(): ChapterState {
    return { ...this.lastState };
  }

  /** 当前已提交章节路径，用于槽位命中校验。 */
  getCurrentPath(): string {
    return this._currentPath;
  }

  /** 设置变更（字号/主题/阅读方式）后整体重载（保留阅读位置）。 */
  async reloadWithSettings(settings: ReaderSettings, anchor?: string): Promise<void> {
    const path = this.currentPath;
    if (!path) {
      this.settings = settings;
      return;
    }
    // 切换阅读方式前必须按旧模式采样：分页采样列中心，滚动采样可见区域
    // 上方固定点。先更新 settings 会让采样读到新模式坐标。
    if (this.scrollMode) this.captureScrollAnchor();
    else if (!this.flushReadingAnchor()) this.captureAnchor();
    const readingAnchor = this.anchor && this.anchorPath === path ? { ...this.anchor } : null;
    const fallbackPage = this.metrics.currentPage;
    this.settings = settings;
    // Preserve the committed search-hit identity across the same-chapter
    // settings rebuild.  Only values are copied; old DOM Ranges are never kept.
    const preserveSearchHighlight = this.searchHighlightTarget
      ? {
          requestId: this.searchHighlightTarget.requestId,
          textHits: this.searchHighlightTarget.textHits.map((hit) => ({ ...hit })),
          occurrence: cloneSearchOccurrence(this.searchHighlightTarget.occurrence),
        }
      : null;
    await this.load(path, { anchor, readingAnchor, fallbackPage, preserveSearchHighlight });
  }

  private get currentPath(): string {
    return this._currentPath;
  }

  private _currentPath = "";

  private scheduleReflow(): void {
    if (this.reflowTimer !== undefined) window.clearTimeout(this.reflowTimer);
    const seq = this.loadSeq;
    this.reflowTimer = window.setTimeout(() => {
      this.reflowTimer = undefined;
      if (!this.disposed && seq === this.loadSeq) void this.recompute(false, seq);
    }, 200);
  }

  /** 外部触发重排（窗口尺寸变化等）。
   *  不捕获锚点：直接使用上一次稳定状态存下的锚点（缩放前的位置）。 */
  reflow(): void {
    if (this.disposed) return;
    // ResizeObserver 在组件挂载和章节切换时也可能回调，即使 iframe 尺寸
    // 完全没变。重复 measure 会先恢复二阶段补偿，造成已稳定盒子短暂跳位。
    if (
      this.iframe.clientWidth === this.measuredViewport.width &&
      this.iframe.clientHeight === this.measuredViewport.height
    ) {
      return;
    }
    // A real resize can move the marker to another column/page.  Pinned
    // footnotes are position-scoped; same-size ResizeObserver no-ops above
    // must not close anything.
    this.closeFootnoteForNavigation();
    const seq = ++this.reflowSeq;
    const loadSeq = this.loadSeq;
    void this.measure(loadSeq).then((measured) => {
      // 过期测量（更早发起、更晚完成/切章后）直接丢弃，防布局/位置被覆写
      if (measured && !this.disposed && seq === this.reflowSeq && loadSeq === this.loadSeq) {
        this.rebuildTextIndexForCurrentDoc();
        void this.recompute(true, loadSeq);
      }
    });
  }

  /** 键盘翻页（书页内焦点）。 */
  private handleKey(e: KeyboardEvent): void {
    if (isSelectAllShortcut(e)) {
      e.preventDefault();
      clearDocumentSelection(this.contentDoc);
      return;
    }
    if (this.externalScroll) {
      const k = e.key;
      if (k === "PageDown" || k === " ") {
        e.preventDefault();
        this.externalScroll.onViewportStep(1);
      } else if (k === "PageUp") {
        e.preventDefault();
        this.externalScroll.onViewportStep(-1);
      } else if (k === "ArrowDown") {
        e.preventDefault();
        this.externalScroll.onWheelPixels(40);
      } else if (k === "ArrowUp") {
        e.preventDefault();
        this.externalScroll.onWheelPixels(-40);
      }
      return;
    }
    if (this.scrollMode) {
      // 滚动模式：PageUp/PageDown/Space 走视口命令，方向键保留原生滚动。
      const k = e.key;
      if (k === "PageDown" || k === " ") {
        e.preventDefault();
        this.onKeyNavigate?.(1);
      } else if (k === "PageUp") {
        e.preventDefault();
        this.onKeyNavigate?.(-1);
      }
      return;
    }
    const k = e.key;
    if (k === "ArrowRight" || k === "PageDown" || k === " ") {
      e.preventDefault();
      this.onKeyNavigate?.(1);
    } else if (k === "ArrowLeft" || k === "PageUp") {
      e.preventDefault();
      this.onKeyNavigate?.(-1);
    }
  }

  /** 滚轮翻页：分页模式累积翻页；滚动模式到章首/章末边界时累积切换上一章/下一章。 */
  private handleWheel(e: WheelEvent): void {
    if (this.externalScroll) {
      if (!this.viewer || e.deltaY === 0) return;
      const deltaY = continuousWheelPixels(
        e.deltaY,
        e.deltaMode,
        28,
        Math.max(1, (this.viewer?.clientHeight ?? 600) - 2 * this.continuousBleedPx)
      );
      e.preventDefault();
      this.externalScroll.onWheelPixels(deltaY);
      return;
    }
    if (this.scrollMode) {
      if (!this.viewer || e.deltaY === 0) return;
      if (this.lastState.status === "loading" || this.lastState.status === "measuring") return;

      const metrics = this.scrollMetrics();
      const maxTop = scrollMaxTop(metrics);
      const currentTop = this.viewer.scrollTop;
      const deltaY = e.deltaMode === 1
        ? e.deltaY * 28
        : e.deltaMode === 2
          ? e.deltaY * Math.max(1, this.viewer.clientHeight - 2 * this.continuousBleedPx)
          : e.deltaY;

      if (deltaY > 0) {
        // 向下滚动：若尚未到底部（容差 2px），主动滚动正文并阻止默认行为。
        // （必须由分页器主动滚动，避免跨章重建文档时 Chromium compositor 在途手势失效导致连续滚动停滞）
        if (currentTop < maxTop - 2) {
          this.scrollWheelAcc = 0;
          this.scrollByDelta(deltaY);
          e.preventDefault();
          return;
        }
        this.cancelScrollAnimation();
        if (!this.hasNextChapter) {
          this.scrollWheelAcc = 0;
          return;
        }
        // 已经在章末底部：检查是否处于反向保护期（刚从下一章回退到上一章时，向下回弹锁 800ms）
        if (this.lockedReverseDir === 1 && Date.now() < this.reverseLockUntil) {
          this.scrollWheelAcc = 0;
          return;
        }
        // 同向连续换章微防抖（150ms）
        if (Date.now() < this.sameDirThrottleUntil) {
          this.scrollWheelAcc = 0;
          return;
        }
        // 已经在章末底部：累积滚轮越界位移（阈值 160px 吸收连续手势与误触）
        this.armScrollWheelReset();
        this.scrollWheelAcc += deltaY;
        if (this.scrollWheelAcc >= 160) {
          this.scrollWheelAcc = 0;
          this.lockedReverseDir = -1; // 进入下一章后，向上反向回弹锁 250ms
          this.reverseLockUntil = Date.now() + 250;
          this.sameDirThrottleUntil = Date.now() + 150;
          if (this.scrollWheelResetTimer !== undefined) {
            globalThis.clearTimeout(this.scrollWheelResetTimer);
            this.scrollWheelResetTimer = undefined;
          }
          e.preventDefault();
          this.onWheelNavigate?.(1);
        }
      } else {
        // 向上滚动：若尚未到顶部（容差 2px），主动滚动正文并阻止默认行为。
        if (currentTop > 2) {
          this.scrollWheelAcc = 0;
          this.scrollByDelta(deltaY);
          e.preventDefault();
          return;
        }
        this.cancelScrollAnimation();
        if (!this.hasPrevChapter) {
          this.scrollWheelAcc = 0;
          return;
        }
        // 已经在章首顶部：检查是否处于反向保护期（刚从上一章前进到下一章时，向上回弹锁 250ms）
        if (this.lockedReverseDir === -1 && Date.now() < this.reverseLockUntil) {
          this.scrollWheelAcc = 0;
          return;
        }
        // 同向连续换章微防抖（150ms）
        if (Date.now() < this.sameDirThrottleUntil) {
          this.scrollWheelAcc = 0;
          return;
        }
        // 已经在章首顶部：累积滚轮越界位移（阈值 -160px 吸收连续手势与误触）
        this.armScrollWheelReset();
        this.scrollWheelAcc += deltaY;
        if (this.scrollWheelAcc <= -160) {
          this.scrollWheelAcc = 0;
          this.lockedReverseDir = 1; // 进入上一章后，向下反向回弹锁 250ms
          this.reverseLockUntil = Date.now() + 250;
          this.sameDirThrottleUntil = Date.now() + 150;
          if (this.scrollWheelResetTimer !== undefined) {
            globalThis.clearTimeout(this.scrollWheelResetTimer);
            this.scrollWheelResetTimer = undefined;
          }
          e.preventDefault();
          this.onWheelNavigate?.(-1);
        }
      }
      return;
    }

    if (e.deltaY === 0) return;
    if (this.lastState.status === "loading" || this.lastState.status === "measuring") {
      this.wheelAcc = 0;
      return;
    }
    this.wheelAcc += e.deltaY;
    const threshold = 80;
    if (this.wheelAcc >= threshold) {
      this.wheelAcc = 0;
      e.preventDefault();
      this.onWheelNavigate?.(1);
    } else if (this.wheelAcc <= -threshold) {
      this.wheelAcc = 0;
      e.preventDefault();
      this.onWheelNavigate?.(-1);
    }
  }

  private armScrollWheelReset(): void {
    if (this.scrollWheelResetTimer !== undefined) {
      globalThis.clearTimeout(this.scrollWheelResetTimer);
    }
    this.scrollWheelResetTimer = globalThis.setTimeout(() => {
      this.scrollWheelAcc = 0;
      this.scrollWheelResetTimer = undefined;
    }, 500) as unknown as number;
  }

  /** 书内链接点击处理：阻止 iframe 导航，路由到阅读器跳转。 */
  private handleLinkClick(e: Event): void {
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const a = target.closest<HTMLAnchorElement>("a");
    if (!a) return;
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href) return;
    // 一律拦截：书内链接走阅读器，外部链接不跳转（防 iframe 被导航走）
    e.preventDefault();
    e.stopPropagation();
    if (isExternalUrl(href) || href.startsWith("//")) {
      const url = href.startsWith("//") ? `https:${href}` : href;
      // 只放行可由系统默认应用安全打开的协议；data:/blob:/file: 等保持忽略
      if (/^(https?|mailto|tel):/i.test(url)) this.onExternalLink?.(url);
      return;
    }
    // 脚注标记：多看/掌阅式 + script.js 的 <note><sup><a href="#asideId"> 通用模式
    if (isFootnoteLink(a) && this.contentDoc) {
      const info = resolveFootnote(this.contentDoc, a);
      if (info) {
        // 点击 = 固定弹窗；再次点击同一标记 = 取消固定并关闭
        if (this.footnotePinned && this.lastFootnoteEl === a) {
          this.resetFootnote({ notify: true });
          return;
        }
        this.showFootnote(a, info, true);
        return;
      }
    }
    // 带链接的普通正文图片：用实际点击目标打开图片浮层；“打开链接”沿用
    // 原书链接路由。不要用 a.querySelector('img')，否则图下文字链接会被误判。
    if (this.activateImage(target)) return;
    if (isFragmentOnly(href)) {
      // 脚注已在上方提前返回；这里只处理普通同章锚点。先通过原生 hash
      // 激活 :target，再由分页器将目标元素定位到对应分页列。
      const fragment = getFragmentNavigation(href);
      if (fragment) {
        // 缺失目标只同步 hash，不制造一条“已跳转”的假历史；step/viewer
        // 检查保证通知发生在实际可执行 jumpToAnchor 之前。
        const target = this.contentDoc?.getElementById(fragment.anchor);
        if (!target || !this.viewer || this.step <= 0) {
          syncFragmentHash(this.iframe.contentWindow, fragment.hash);
          return;
        }
        this.onBeforeInternalNavigate?.(href);
        syncFragmentHash(this.iframe.contentWindow, fragment.hash);
        this.jumpToAnchor(fragment.anchor);
        this.onInternalNavigationSettled?.();
      } else if (href === "#" && this.lastState.status === "ready") {
        // An empty fragment is an explicit return to the natural chapter
        // start; clear the old :target state without creating a fake target.
        if (this.navigateWithinCurrentChapter({ fragment: "" })) {
          this.onInternalNavigationSettled?.();
        }
      }
      return;
    }
    const { path, anchor } = splitHref(href);
    const resolved = resolvePath(this._currentPath, path);
    const destination = anchor ? `${resolved}#${anchor}` : resolved;
    if (resolved === this._currentPath) {
      // Same-chapter links never leave the iframe. Preflight before notifying
      // App so an invalid fragment cannot pollute navigation history.
      const fragmentPage = anchor ? this.getWithinChapterFragmentPage(anchor) : null;
      if (anchor ? !fragmentPage : this.lastState.status !== "ready") return;
      this.onBeforeInternalNavigate?.(destination);
      const navigated = this.navigateWithinCurrentChapter(
        anchor ? { fragment: anchor } : { toStart: true }
      );
      if (navigated) this.onInternalNavigationSettled?.();
      return;
    }
    this.onBeforeInternalNavigate?.(destination);
    this.onNavigate?.(destination);
  }

  /** 显示脚注弹层：记录标记（供重排重定位）并通知阅读器。 */
  private showFootnote(a: HTMLAnchorElement, info: FootnoteInfo, pinned: boolean): void {
    this.lastFootnoteEl = a;
    this.footnotePinned = pinned;
    this.footnoteHoverGate.show(pinned);
    const r = a.getBoundingClientRect();
    this.onFootnote?.({
      text: info.text,
      html: info.html,
      pinned,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    });
  }

  /** 桌面 hover 弹注（script.js 的 mouseover 行为）；已固定时不切换。 */
  private handleFootnoteHoverIn(e: Event): void {
    if (this.footnotePinned) return;
    const doc = this.contentDoc;
    const a = getFootnoteHoverAnchor(e.target, doc);
    if (!a || !doc) return;
    this.footnoteHoverGate.markerEnter();
    if (this.lastFootnoteEl === a && this.footnoteHoverGate.isVisible()) return;
    const info = resolveFootnote(doc, a);
    if (info) this.showFootnote(a, info, false);
  }

  /** hover 移出标记时关闭弹层；在标记内部移动不关闭；固定状态不关闭。 */
  private handleFootnoteHoverOut(e: MouseEvent): void {
    if (this.footnotePinned) return;
    const a = (e.target as Element | null)?.closest<HTMLAnchorElement>("a");
    if (!a || !isFootnoteLink(a)) return;
    const rel = e.relatedTarget as Node | null;
    if (rel && a.contains(rel)) return;
    this.footnoteHoverGate.markerLeave();
  }

  /** 固定脚注后点击正文空白处关闭；无链接正文图片在这里激活浮层。 */
  private handleDocClick = (e: Event): void => {
    const target = e.target as Element | null;
    const a = target?.closest<HTMLAnchorElement>("a");
    if (a && isFootnoteLink(a)) return; // 标记点击由 linkHandler 处理并 stopPropagation
    // 带普通链接的图片已由 linkHandler 消费；这里只处理无链接的正文图片。
    if (!a && this.activateImage(target)) return;
    if (!this.footnotePinned) return;
    this.resetFootnote({ notify: true });
  };

  /**
   * 正文图片激活：脚注语义优先（调用前已返回），带普通链接的图片也可放大。
   * 识别交给 AI-A 的 imageActivation；这里只做活动章节路由与链接原值转发。
   */
  private activateImage(target: Element | null): boolean {
    if (!this.contentDoc || !this.onImageActivation || this.disposed || !target) return false;
    // 点击点可能落在包裹图片的链接/容器上；识别仍交给 A 的 img/image 判定。
    const candidate = this.imageCandidate(target);
    if (!candidate) return false;
    const request = imageRequestFromTarget(candidate, this._currentPath);
    if (!request) return false;
    const linkHref = request.linkHref ?? "";
    this.onImageActivation({
      src: request.src,
      alt: request.alt,
      naturalWidth: request.naturalWidth,
      naturalHeight: request.naturalHeight,
      chapterPath: this._currentPath,
      linkHref: linkHref || undefined,
    });
    return true;
  }

  /** 找到点击目标内可被 A 识别的图片节点，不向下遍历无关子树以免空白/段落误触发。 */
  private imageCandidate(target: Element): Element | null {
    const tag = (target.tagName ?? "").toLowerCase();
    if (tag === "img" || tag === "image") return target;
    if (tag === "svg") {
      const imageChild = target.querySelector(":scope > image");
      if (imageChild) return imageChild;
    }
    const innerImg = target.closest?.("img, image");
    if (innerImg) return innerImg;
    return null;
  }

  /** UI 层主动关闭固定脚注后，同步分页器状态（避免 hover 被锁住）。 */
  dismissFootnote(): void {
    this.resetFootnote({ notify: false });
  }

  /** 宿主导航/预载提升前关闭旧活动槽弹注；与用户主动关闭区分。 */
  closeForNavigation(): void {
    this.closeFootnoteForNavigation();
  }

  /** 重置滚轮累积量，用于切章或视图激活时清空残留的惯性 delta */
  resetWheelAccumulator(): void {
    this.wheelAcc = 0;
    this.scrollWheelAcc = 0;
    if (this.scrollWheelResetTimer !== undefined) {
      globalThis.clearTimeout(this.scrollWheelResetTimer);
      this.scrollWheelResetTimer = undefined;
    }
  }

  /** 宿主脚注卡片 hover 进入/离开时，同步 iframe 内 marker 的关闭 gate。 */
  setFootnoteOverlayHover(over: boolean): void {
    if (over) this.footnoteHoverGate.overlayEnter();
    else this.footnoteHoverGate.overlayLeave();
  }

  /** 当前脚注标记在 iframe 内的视口矩形（弹层随重排重定位用）；无则 null。 */
  getFootnoteMarkerRect(): { left: number; top: number; right: number; bottom: number } | null {
    if (!(this.footnotePinned || this.footnoteHoverGate.isVisible())) return null;
    if (!this.lastFootnoteEl || !this.contentDoc?.contains(this.lastFootnoteEl)) return null;
    const r = this.lastFootnoteEl.getBoundingClientRect();
    if (![r.left, r.top, r.right, r.bottom].every(Number.isFinite)) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  /** 渲染诊断：输出当前章节的分页/布局关键数据（浏览器内调试用）。 */
  diagnose(): string {
    const doc = this.contentDoc;
    const viewer = this.viewer;
    const lines: string[] = [];
    lines.push(`state=${JSON.stringify(this.lastState)}`);
    lines.push(
      `step=${this.step} pageWidth=${this.pageWidth} metrics=${JSON.stringify(this.metrics)}`
    );
    lines.push(
      `iframe=${this.iframe.clientWidth}x${this.iframe.clientHeight} src=${String(this.iframe.src).slice(0, 36)}`
    );
    if (doc && viewer) {
      const cs = doc.defaultView ? doc.defaultView.getComputedStyle(viewer) : null;
      lines.push(
        `viewer=${viewer.clientWidth}x${viewer.clientHeight} sw=${viewer.scrollWidth} sh=${viewer.scrollHeight} scrollLeft=${viewer.scrollLeft}`
      );
      if (cs) {
        lines.push(
          `colW=${cs.columnWidth} colCount=${cs.columnCount} colFill=${cs.columnFill} overflow=${cs.overflow}`
        );
      }
      lines.push(`children=${viewer.children.length} textLen=${(viewer.textContent ?? "").trim().length}`);
      const imgs = Array.from(viewer.querySelectorAll("img"))
        .slice(0, 6)
        .map((im) => {
          const r = (im as HTMLElement).getBoundingClientRect();
          return `${im.getAttribute("alt") || "-"}:${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`;
        })
        .join(" ");
      lines.push(`imgs=${imgs || "none"}`);
      // 布局排障辅助：fit-content 在多栏里常异常；宽出栏宽的元素也需要列出来
      const fitContentEls = Array.from(viewer.querySelectorAll("*"))
        .filter((el) => {
          const mw = doc.defaultView?.getComputedStyle(el as Element).maxWidth ?? "";
          return mw.includes("fit-content");
        })
        .slice(0, 5)
        .map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return `${(el as Element).tagName.toLowerCase()}.${(el as Element).getAttribute("class") ?? ""}:${Math.round(r.width)}px`;
        })
        .join(" ");
      lines.push(`fitContentEls=${fitContentEls || "none"}`);
      const wideEls = Array.from(viewer.querySelectorAll("*"))
        .filter((el) => {
          // 多栏里 getBoundingClientRect 会把跨列碎片并成一个超宽矩形，
          // 用 computed width 判断“真实盒宽”是否超栏，避免碎片误报。
          const w = parseFloat(doc.defaultView?.getComputedStyle(el as Element).width ?? "");
          return Number.isFinite(w) && w > this.step + 1;
        })
        .slice(0, 5)
        .map((el) => {
          const w = parseFloat(doc.defaultView?.getComputedStyle(el as Element).width ?? "");
          return `${(el as Element).tagName.toLowerCase()}.${(el as Element).getAttribute("class") ?? ""}:${Math.round(w)}px`;
        })
        .join(" ");
      lines.push(`wideEls=${wideEls || "none"}`);
      lines.push(`sheets=${doc.styleSheets.length}`);
      const fonts = (doc as unknown as { fonts?: { status?: string } }).fonts;
      lines.push(`fontsStatus=${fonts?.status ?? "n/a"}`);
      const anchorInfo = this.anchor
        ? `anchor idx=${this.anchor.index} ratio=${this.anchor.ratio.toFixed(3)} path=${this.anchorPath}`
        : "anchor=null";
      lines.push(anchorInfo);
      const body = doc.body;
      if (body) {
        lines.push(`bodyChildren=${body.children.length}`);
        lines.push(`bodyHtml=${body.outerHTML.replace(/\s+/g, " ").slice(0, 300)}`);
      }
      lines.push(`viewerHtml=${viewer.outerHTML.replace(/\s+/g, " ").slice(0, 200)}`);
      const links = Array.from(doc.getElementsByTagName("link"))
        .map((l) => (l as HTMLLinkElement).getAttribute("href"))
        .join(" , ");
      lines.push(`linkHrefs=${links}`);
    } else {
      lines.push("viewer=null（章节尚未加载）");
    }
    return lines.join("\n");
  }

  /**
   * 释放当前章节持有的资源。expected 用于异步 load 的过期路径：
   * 如果字段已被新 load 改写，则不再重复释放新持有者。
   */
  private releaseResourceHolder(expected?: number | null): void {
    if (this.resourceHolderId === null) return;
    if (expected !== undefined && expected !== null && this.resourceHolderId !== expected) return;
    this.server.releaseHolder?.(this.resourceHolderId);
    this.resourceHolderId = null;
  }

  private cleanupDoc(): void {
    this.abortMeasureWaits();
    this.restoreBackdropCompatibility();
    this.resetFootnote({ notify: true });
    this.wheelAcc = 0;
    this.scrollWheelAcc = 0;
    if (this.scrollWheelResetTimer !== undefined) {
      globalThis.clearTimeout(this.scrollWheelResetTimer);
      this.scrollWheelResetTimer = undefined;
    }
    this.selectionContextMenuOpen = false;
    this.selectionContextMenuHandler?.(null);
    this.restoreInlineBoxFixes();
    this.restoreFloatLayoutFixes();
    this.restoreContainedMediaFixes();
    this.restoreTrailingFloatFixes();
    this.restorePercentageSpacing();
    this.restorePercentageSpacing = () => {};
    this.contentDoc?.removeEventListener("load", this.imgHandler, true);
    this.contentDoc?.removeEventListener("click", this.linkHandler, true);
    this.contentDoc?.removeEventListener("click", this.handleDocClick, true);
    this.contentDoc?.removeEventListener("wheel", this.wheelHandler);
    this.contentDoc?.removeEventListener("keydown", this.keyHandler);
    this.contentDoc?.removeEventListener("mouseover", this.footnoteHoverInHandler, true);
    this.contentDoc?.removeEventListener("mouseout", this.footnoteHoverOutHandler, true);
    this.contentDoc?.removeEventListener("contextmenu", this.contextMenuHandler);
    this.contentDoc?.removeEventListener("selectionchange", this.selectionChangeHandler);
    this.contentDoc?.removeEventListener("scroll", this.scrollHandler, true);
    this.contentDoc?.removeEventListener("scrollend", this.scrollEndHandler, true);
    this.contentDoc?.removeEventListener("pointerdown", this.pointerDownHandler, true);
    this.cancelScrollFrame();
    this.cancelScrollAnimation();
    this.restoreScrollView();
    this.restoreExternalScrollOwnership();
    this.restoreCompositedPagedScroll();
    this.pagedSwipeCleanup?.();
    this.pagedSwipeCleanup = null;
    this.plainTapCleanup?.();
    this.plainTapCleanup = null;
    this.restoreSpreadReadingAreaStyles();
    this.clearNoteHighlights();
    this.clearSearchHighlightForDocument();
    this.pendingPrecise = null;
    this.pendingRestoreAnchor = null;
    this.removeTailSpacer();
    this.bookmarkSpreadCache.clear();
    this.spreadLayout = null;
    this.spreadGeometry = null;
    this.spreadArea = null;
    this.contentDoc = null;
    this.viewer = null;
    this.textIndex = null;
    this.pendingFallbackPage = null;
    this.leadingColumns = 0;
    this.effectiveColumns = 1;
    this.scrollPageCount = 1;
    this.lastScrollTop = 0;
    this.scrollWheelAcc = 0;
    if (this.scrollWheelResetTimer !== undefined) {
      globalThis.clearTimeout(this.scrollWheelResetTimer);
      this.scrollWheelResetTimer = undefined;
    }
    this.chapterCssUrls.revokeAll();
    for (const owned of this.pendingCssUrls) owned.revokeAll();
    this.pendingCssUrls.clear();
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPendingAnchorSample?.();
    if (this.pendingPrecise) {
      this.reportPreciseStatus(this.pendingPrecise.request, "cancelled", false);
      this.pendingPrecise = null;
    }
    this.loadSeq++;
    this.resolveDisplayReady?.(false);
    this.resolveDisplayReady = null;
    this.abortMeasureWaits();
    window.clearTimeout(this.reflowTimer);
    this.displayGate.dispose();
    this.iframe.removeEventListener("load", this.onIframeLoad);
    this.cleanupDoc();
    this.footnoteHoverGate.dispose();
    this.iframe.src = "about:blank";
    this.releaseResourceHolder();
    this.server = null as any;
  }

  private abortMeasureWaits(): void {
    for (const controller of this.measureControllers) controller.abort();
    this.measureControllers.clear();
  }

  private emit(s: ChapterState): void {
    this.lastState = s;
    if (!this.disposed) this.onState(s);
  }
}
