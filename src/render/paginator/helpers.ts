// Pure top-level helpers and public types for ChapterPaginator.
// Moved losslessly from paginator.ts (ER-0196). Exported internal helpers are
// module-private to the paginator folder unless re-exported by paginator.ts.

import type { PageProgression } from "../pagedDirection";
import { restoreInlineStyleProperty, snapshotInlineStyleProperty } from "../inlineStyleSnapshot";
import type { InlineStyleValue } from "../inlineStyleSnapshot";
import { isFragmentOnly } from "../../core/paths";
import type { ResourceServer } from "../resources";
import { TEXT_MEASURE } from "../settings";
import type { ReaderSettings } from "../settings";
import { hasAuthoredCssProperty } from "../cssRewrite";
import type { ExactTextHit, RawTextRange } from "../../core/exactTextHits";
import type { SearchOccurrence } from "../../core/searchOccurrence";
import type { DisplaySearchTarget } from "../../core/search";
import type { PersistedNavigationAnchor } from "../navigationAnchor";
import type { TextAnchorData, TextRangeAnchorData, TextSelectionPayload, VisibleTextIndex } from "../textAnchor";
import type { ReadingMode } from "../scrollLayout";
import type { AppliedTextInsets } from "../pageLayout";
import type { PagedSwipeHandlers } from "../pagedSwipe";
import type { PlainTapInfo } from "../plainTap";
import type { ImageViewGallery } from "../imageActivation";
import type { MediaPlaybackText } from "../mediaPlayback";



/** 滚动模式全书末尾提示的文案；由界面层按当前界面语言注入，分页核心不依赖语言模块。 */


export interface ReaderEndText {
  title: string;
  hint: string;
}

export const DEFAULT_READER_END_TEXT: ReaderEndText = { title: "全书完", hint: "已读完全部章节" };

/** 常规布局应远早于此完成；极端字体/引擎停滞时只解除隐藏，不伪造 ready。 */
export const INITIAL_RENDER_GATE_TIMEOUT_MS = 20_000;

/** 舒适双页写入 viewer 的 reader-owned 根内联属性；restore 只碰这些。 */
/** 无滚动抬手后等待续上的吸附/甩动动画的时长；期间出现滚动则改等 scrollend。 */
export const NATIVE_SNAP_SETTLE_MS = 160;

export const SPREAD_AREA_ROOT_STYLE_PROPERTIES = [
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
      /** Resting layout, captured before a page-motion window changes margins. */
      textInsets?: AppliedTextInsets;
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
  /** ER-0106 look; both missing = legacy theme underline. */
  style?: string;
  color?: string;
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
  /** 同章可查看图片列表与当前序号（看图器内前后翻看）。 */
  gallery?: ImageViewGallery;
}

export interface LoadOptions {
  /** Runtime-only, frozen at entry by the host's exact layout index. Omit to keep legacy layout. */
  chapterFill?: { readonly leadingBlankColumns: 0 | 1 };
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
  /**
   * Report this load's first restore outcome once through the restore-result
   * handler: located only when a semantic (text/element/media) target really
   * resolved. A failed target may still show the chapter start, but reports
   * unresolved so the host does not save that start over the original.
   */
  reportRestore?: boolean;
  /** Immutable restore-request identity carried through this load. */
  restoreTicket?: RestoreReportTicket | null;
  /** Exact search/note target for cross-chapter jumps; resolved before reveal. */
  preciseNavigation?: PreciseNavigationRequest | null;
  /**
   * Internal settings-reload carry-over.  It preserves the already committed
   * search hit identity across a same-chapter document rebuild without
   * treating it as a new navigation.
   */
  preserveSearchHighlight?: SearchHighlightTarget | null;
}

/** Immutable identity of one host restore request. */
export interface RestoreReportTicket {
  readonly session: number;
  readonly request: number;
  readonly chapterPath: string;
}

/** One-shot first-restore report produced by the paginator. */
export interface RestoreReportResult {
  readonly located: boolean;
  readonly ticket: RestoreReportTicket | null;
  /** Load generation that produced the report; stale loads must not settle a newer request. */
  readonly loadSeq: number;
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
    mediaAnchor?: MediaReadingAnchor | null;
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
  /** Exact canonical body ranges; omitted for note anchors that use persisted text only. */
  textHits?: ExactTextHit[];
  /** Canonical identity context; absent for notes and legacy search requests. */
  occurrence?: SearchOccurrence;
  /**
   * Display-only identity for the same search result. Canonical fields above
   * remain the persisted/identity source; this target drives exact visible DOM
   * geometry and highlight when present.
   */
  displayTarget?: DisplaySearchTarget;
}

export interface SearchHighlightTarget {
  requestId: number;
  textHits: ExactTextHit[];
  /** Canonical identity context; absent for notes and legacy search requests. */
  occurrence?: SearchOccurrence;
  /** Display-only target preserved across same-chapter reflow/rebuild. */
  displayTarget?: DisplaySearchTarget;
}

export function cloneSearchOccurrence(occurrence: SearchOccurrence | undefined): SearchOccurrence | undefined {
  return occurrence
    ? {
        before: occurrence.before,
        after: occurrence.after,
        hits: occurrence.hits.map((hit) => ({ ...hit })),
      }
    : undefined;
}

export function cloneExactTextHits(hits: readonly ExactTextHit[] | undefined): ExactTextHit[] {
  return hits?.map((hit) => ({ ...hit })) ?? [];
}

export function cloneDisplayTarget(target: DisplaySearchTarget | undefined): DisplaySearchTarget | undefined {
  return target
    ? {
        projectionVersion: target.projectionVersion,
        textHits: target.textHits.map((hit) => ({ ...hit })),
        occurrence: cloneSearchOccurrence(target.occurrence)!,
      }
    : undefined;
}

export interface PendingPreciseNavigation {
  request: PreciseNavigationRequest;
  /** Immutable copy of the original request anchor; never a page-center sample. */
  anchor: ReadingAnchor | null;
}

export interface ResolvedSearchTarget {
  canonicalHits: RawTextRange[];
  paintIndex: VisibleTextIndex;
  paintHits: RawTextRange[];
}

export type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** 采样点：x/y 均为 viewer 内容框内的像素（不含 viewer 的 border/padding）。 */
export interface VisibleSamplePoint {
  x: number;
  y: number;
}

export interface AnchorSampleOptions {
  viewer: HTMLElement;
  doc: Document;
  index: VisibleTextIndex;
  /** paginated 用可见列中心；scroll 用可用屏高比例 */
  mode: ReadingMode;
  /** scroll：可见区域高度比例；paginated：可见列宽度比例 */
  visibleRatio: number;
  /** paginated 分栏换算；scroll 忽略 */
  geometry?: { progression?: PageProgression; columnWidth: number; columnStep: number; viewStep: number; leadingColumns: number; vertical?: boolean };
  /** B-237 paginated only: visible media in the sampled column when the point has no text. */
  mediaAt?: (point: VisibleSamplePoint) => VisibleMediaSample | null;
}

export interface VisibleMediaSample {
  element: Element;
  anchor: MediaReadingAnchor;
}

/** scroll：可见屏内固定高度；paginated：第一可见列（不是含 gap 的整屏中心）。 */
export function visibleSamplePoints(options: AnchorSampleOptions): VisibleSamplePoint[] {
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
  const x = geometry.progression === "rtl"
    ? viewer.getBoundingClientRect().right - viewerPaddingRight(viewer) - colInset
    : left + colInset;
  return clampedYs.map((y) => ({ x, y }));
}

export function viewerPaddingRight(viewer: HTMLElement): number {
  const computed = viewer.ownerDocument.defaultView?.getComputedStyle(viewer);
  return (parseFloat(computed?.paddingRight ?? "") || 0) + (parseFloat(computed?.borderRightWidth ?? "") || 0);
}

/** viewer 内容左原点所需的 padding-left（取不到时为 0）。 */
export function viewerPaddingLeft(viewer: HTMLElement): number {
  try {
    const computed = viewer.ownerDocument.defaultView?.getComputedStyle(viewer);
    return parseFloat(computed?.paddingLeft ?? "") || 0;
  } catch {
    return 0;
  }
}

export function visibleElementAt(
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
export function captureAnchorAtPoint(
  options: AnchorSampleOptions,
  point: VisibleSamplePoint
): ReadingAnchor | null {
  const { viewer, doc, index } = options;
  const caretDoc = doc as CaretDocument;
  let textNode: Text | null = null;
  let rawOffset = 0;
  // ER-0146: right of a `<br>`-broken line (verse, lyrics) or on its blank
  // line the caret is an element boundary such as (p, index of <br>), not a
  // text node. It still names a text position; dropping it left the page with
  // no text offset and progress fell back to a page-ratio estimate.
  let boundary: { node: Element; offset: number } | null = null;
  const modern = caretDoc.caretPositionFromPoint?.(point.x, point.y);
  if (modern && modern.offsetNode.nodeType === 3) {
    textNode = modern.offsetNode as Text;
    rawOffset = modern.offset;
  } else {
    if (modern && modern.offsetNode.nodeType === 1) boundary = { node: modern.offsetNode as Element, offset: modern.offset };
    const range = caretDoc.caretRangeFromPoint?.(point.x, point.y);
    if (range && range.startContainer.nodeType === 3) {
      textNode = range.startContainer as Text;
      rawOffset = range.startOffset;
    } else if (!boundary && range && range.startContainer.nodeType === 1) {
      boundary = { node: range.startContainer as Element, offset: range.startOffset };
    }
  }
  // Only a boundary inside one content block: never the viewer, body or document.
  if (boundary && (boundary.node === viewer || typeof viewer.contains !== "function" || !viewer.contains(boundary.node))) boundary = null;
  const textOffset = textNode
    ? index.offsetForNode(textNode, rawOffset)
    : boundary ? index.offsetForElementBoundary(boundary.node, boundary.offset) : null;
  // Text first; with no text under the point (an image page) the column's
  // media gives a stable identity instead of only its element index.
  const media = textOffset === null ? options.mediaAt?.(point) ?? null : null;
  const el = textNode?.parentElement ?? (textOffset !== null ? boundary?.node : null) ?? media?.element ?? visibleElementAt(doc, viewer, point);
  const idx = el ? index.elementIndex(el, viewer) : -1;
  const rect = el ? (el as HTMLElement).getBoundingClientRect() : null;
  if (textOffset === null && idx < 0 && !media) return null;
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
    ...(media ? { mediaAnchor: media.anchor } : {}),
  };
}

/** Try a nearby column when a vertical page centre is an authored empty
 * paragraph. Keep the legacy fallback only after text/media candidates fail. */
export function verticalAnchorPoints(x: number, ys: readonly number[], columnWidth: number, viewportWidth: number): VisibleSamplePoint[] {
  return [x, x - columnWidth / 4, x + columnWidth / 4]
    .filter(point => point >= 2 && point <= viewportWidth - 2)
    .flatMap(point => ys.map(y => ({ x: point, y })));
}

export function captureFirstAnchor(options: AnchorSampleOptions, points: VisibleSamplePoint[], preferIdentity: boolean): ReadingAnchor | null {
  let legacy: ReadingAnchor | null = null;
  for (const point of points) {
    const anchor = captureAnchorAtPoint(options, point);
    if (!anchor) continue;
    if (!preferIdentity || anchor.textOffset !== null || anchor.mediaAnchor) return anchor;
    legacy ??= anchor;
  }
  return legacy;
}

/** 依次尝试采样点；caret API 缺失时回退到可见元素，避免整章进度归零。 */
export function captureVisibleAnchor(options: AnchorSampleOptions): ReadingAnchor | null {
  let points = visibleSamplePoints(options);
  if (options.geometry?.vertical && points.length) {
    points = verticalAnchorPoints(points[0].x, points.map(p => p.y), options.geometry.columnWidth,
      options.doc.documentElement.clientWidth || options.viewer.clientWidth);
  }
  const anchor = captureFirstAnchor(options, points, Boolean(options.geometry?.vertical));
  if (anchor) return anchor;
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

/** Read the original request before resolution can clear a failed text identity. */
export function hasModernReadingAnchor(anchor: PersistedNavigationAnchor | ReadingAnchor | null | undefined): boolean {
  if (!anchor) return false;
  const offset = "textOffset" in anchor ? anchor.textOffset : anchor.anchorTextOffset;
  const snippet = "textSnippet" in anchor ? anchor.textSnippet : anchor.anchorTextSnippet;
  return offset != null || snippet != null || Boolean(anchor.mediaAnchor);
}

/** A restore target that names content (text, element or media), not just a page. */
export function hasSemanticRestoreTarget(anchor: ReadingAnchor | null): boolean {
  if (!anchor) return false;
  return anchor.textOffset !== null
    || anchor.textSnippet !== null
    || (Number.isSafeInteger(anchor.index) && anchor.index >= 0)
    || Boolean(anchor.mediaAnchor);
}

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

export type ResolvedAnchorColumn = { col: number; source: "text" | "legacy" | "media" };

/** 书签解析只用这些字段；书签数据格式不变。 */
export interface BookmarkPlacementInput {
  id?: string;
  anchorTextOffset?: number | null;
  anchorTextSnippet?: string | null;
  mediaAnchor?: MediaReadingAnchor | null;
  page?: number;
}

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
/** ER-0145: fragment → text offset, valid for one chapter document's text index. */
export const fragmentOffsetCache = new WeakMap<VisibleTextIndex, Map<string, number | null>>();

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

export type BoxWidthStyle = Pick<
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

export type MarginStyle = Pick<CSSStyleDeclaration, "margin" | "marginLeft" | "marginRight">;

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

export function styleHasPercentageHorizontalMargin(style: CSSStyleDeclaration): boolean {
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

export const HORIZONTAL_MARGIN_PROPERTIES = [
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
export function hasAuthoredInlineHorizontalMargin(el: HTMLElement): boolean {
  const styleText = el.getAttribute("style") ?? "";
  return HORIZONTAL_MARGIN_PROPERTIES.some((property) =>
    hasAuthoredCssProperty(styleText, property)
  );
}

export type AuthoredHorizontalMarginResult = boolean | undefined;

export function ruleHasHorizontalMargin(style: CSSStyleDeclaration): boolean {
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

export const HORIZONTAL_SIZING_PROPERTIES = ["width", "min-width", "max-width"] as const;
export type AuthoredSizingIntentResult = boolean | undefined;

export function ruleHasHorizontalSizing(style: CSSStyleDeclaration): boolean {
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

export type TypedStyleMapHost = {
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

export function resolveBlockContainingContentWidth(
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

export type PercentageWidthValue = number | null | undefined;

export function parsePercentageWidthValue(value: string): number | null {
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))%$/u);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export type TypedWidthStyleMapHost = {
  computedStyleMap?: () => {
    get(property: string): { toString(): string } | undefined;
  };
};

export type WidthCascadeCandidate = {
  value: string;
  important: boolean;
  specificity: number;
  order: number;
};

export function selectorSpecificity(selector: string, el: Element): number | undefined {
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

export function getActiveCssCondition(
  rule: CSSRule,
  win: Window | null | undefined
): boolean | undefined {
  // This reader-owned sheet only supplies the default font. Its @layer must
  // not make layout-property probes treat the author's sizing as unknown.
  // Author layers and the overrides sheet (which can contain user CSS) retain
  // the normal conservative handling below.
  const owner = rule.parentStyleSheet?.ownerNode as Element | null | undefined;
  if (owner?.getAttribute?.("data-reader") === "font-fallback") return false;
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
 * C-04：把书的不对称 margin 解释为“相对居中版心列的缩进”：
 * 正文列左缘 = (parent - width)/2；书 margin-left:2em 意味着
 * 元素左缘再缩进 2em，与正文首行 text-indent 对齐。
 * 包含块已窄于默认版心时（双栏/手机），auto 宽度盒被作者 margin 压窄后
 * 恰好填满包含块，正文列就是包含块本身：保留作者原位，不再按压窄后的
 * 宽度居中再叠加一次 margin（B-229 目录标题多偏半个 margin）。
 */
export function planColumnIndentMargins({
  parentWidth,
  width,
  marginLeft,
  marginRight,
}: {
  parentWidth: number;
  width: number;
  marginLeft: number;
  marginRight: number;
}): { left: number; right: number } {
  const fillsParent = marginLeft + width + marginRight >= parentWidth - 0.5;
  const base = fillsParent ? 0 : (parentWidth - width) / 2;
  if (marginLeft > 0) {
    const left = base + marginLeft;
    return { left, right: parentWidth - left - width };
  }
  const right = base + marginRight;
  return { left: parentWidth - right - width, right };
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
export function isMediaBreakoutValue(
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

export type FullWidthRuleResult = boolean | undefined;

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

export function hasAuthorFullWidthIntent(doc: Document, el: HTMLElement): boolean {
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

export function hasAuthorMediaBreakoutIntent(doc: Document, el: HTMLElement): boolean {
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

/** 内容适配要写的 reader-owned 属性（数值按 px，字符串为 CSS 关键字）；写前快照原 inline 值与优先级。 */
export interface ContentFitWrite {
  el: HTMLElement;
  properties: Array<[property: string, value: number | string]>;
}

export interface ContentFitFix {
  el: HTMLElement;
  styles: Array<{ property: string; original: InlineStyleValue }>;
}

export function isInsideAny(el: Element, ancestors: ReadonlySet<Element>): boolean {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (ancestors.has(node)) return true;
  }
  return false;
}

export function horizontalPaddingBorder(cs: CSSStyleDeclaration): number {
  return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) +
    (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
}

/** 批量写入（读数已全部完成）；同一元素重复出现时只快照第一次的原值。 */
export function writeContentFitStyles(writes: readonly ContentFitWrite[]): ContentFitFix[] {
  const fixes = new Map<HTMLElement, ContentFitFix>();
  for (const write of writes) {
    let fix = fixes.get(write.el);
    if (!fix) {
      fix = { el: write.el, styles: [] };
      fixes.set(write.el, fix);
    }
    for (const [property, value] of write.properties) {
      if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) continue;
      if (!fix.styles.some((style) => style.property === property)) {
        fix.styles.push({ property, original: snapshotInlineStyleProperty(write.el.style, property) });
      }
      write.el.style.setProperty(property, typeof value === "number" ? `${value}px` : value, "important");
    }
  }
  return Array.from(fixes.values());
}

export function restoreContentFitStyles(fixes: readonly ContentFitFix[]): void {
  for (const fix of fixes) {
    for (const { property, original } of fix.styles) {
      restoreInlineStyleProperty(fix.el.style, property, original);
    }
  }
}

/** 书籍常用全角空格/NBSP 把行内色块补到指定视觉列，不应继续参与行尾悬挂空白。 */
export function hasTrailingManualPaddingWhitespace(text: string): boolean {
  // 允许全角/NBSP 后再跟少量普通空格（EPUB 编辑器常混用），但必须
  // 至少出现一个不可折叠宽空白，避免把普通英文行尾空格误判为视觉补齐。
  return /[\u3000\u00a0 ]*[\u3000\u00a0][\u3000\u00a0 ]*$/u.test(text);
}

export type InlineBoxVisualStyle = Pick<
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

export interface CenteredTitleCandidate {
  heading: HTMLElement;
  reflowableHorizontal: boolean;
  bodyDisplay: string;
  bodyFlexDirection: string;
  bodyFlexWrap: string;
  bodyJustifyContent: string;
  bodyAlignItems: string;
}

export interface CenteredTitleFix {
  wrapper: HTMLElement;
  heading: HTMLElement;
}

export interface ChapterPaginatorOptions {
  iframe: HTMLIFrameElement;
  server: ResourceServer;
  settings: ReaderSettings;
  strictXml: boolean;
  mediaText?: () => MediaPlaybackText;
  onState: (s: ChapterState) => void;
  onIssues?: (issues: string[], unresolvedResources: readonly string[]) => void;
  /** 固定版式书：不做行宽自适应，整页显示 */
  fixedLayout?: boolean;
  /** OPF page progression; logical page/locator identities stay unchanged. */
  pageProgression?: PageProgression;
  /** 书内链接点击回调（已解析为书内路径，含可选锚点），供阅读器跳转 */
  onNavigate?: (href: string) => void;
  /** 有效书内链接真正改变位置前通知 UI 记录一次可撤销快照。 */
  onBeforeInternalNavigate?: (href: string) => void;
  /** 不需要重载章节的同章锚点跳转已同步完成。 */
  onInternalNavigationSettled?: () => void;
  /** 滚轮翻页回调（累积阈值后触发，1=下一页 -1=上一页） */
  onWheelNavigate?: (dir: 1 | -1) => void;
  /** 键盘翻页回调（焦点在书页内时也有效）；key 让宿主按翻页方向对调左右方向键 */
  onKeyNavigate?: (dir: 1 | -1, key?: string) => void;
  /** 脚注弹层回调（含文本/HTML/固定状态），由阅读器 UI 显示 */
  onFootnote?: (payload: FootnotePayload) => void;
  /** 桌面端 hover 离开脚注标记时关闭弹层（移动端无 hover，弹层由点击/✕ 关闭） */
  onFootnoteClose?: () => void;
  /** 外部链接（http/https/mailto/tel）点击回调，由 App 层调系统默认浏览器打开 */
  onExternalLink?: (url: string) => void;
  /** 首次测量、分页与最终入口定位全部完成，iframe 已可安全交互。 */
  onDisplayReady?: () => void;
  /** 有效正文选区的现代右键菜单数据；通过 setter 可保持最新 UI 回调。 */
  onSelectionContextMenu?: (payload: SelectionContextPayload | null) => void;
  /** 精确搜索/笔记目标定位结果；未定位不伪装成功。 */
  onPreciseNavigationStatus?: (status: {
      requestId: number;
      status: PreciseNavigationStatus;
      exact: boolean;
    }) => void;
  /** 正文图片激活（活动章节专用；由 UI 打开独立浮层）。 */
  onImageActivation?: (image: ImageActivationPayload) => void;
  /** 连续滚动模式外部适配器；提供时滚轮与按键转交宿主，不再触发章末保护链。 */
  externalScroll?: ExternalScrollAdapter;
  /** 翻页模式单指横滑；连续模式/缓存非活动章由调用方忽略。 */
  pagedSwipe?: PagedSwipeHandlers;
  /** 正文普通轻点/单击；只表达非交互正文短触及其位置，不阻止默认行为。 */
  onPlainTap?: (tap: PlainTapInfo) => void;
  /** 普通轻点是否当前应忽略；由调用方检查活动章/输入暂停/ready 状态。 */
  shouldIgnorePlainTap?: () => boolean;
}
