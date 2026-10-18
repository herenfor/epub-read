import { pageAxisSign } from "../render/pagedDirection";
import { surfaceBackground } from "./readerSurfaceBackground";
import { createRef, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Book } from "../core/types";
import { nextLinearIndex, spineItemPath } from "../core/book";
import {
  ChapterPaginator,
  type ChapterState,
  type FootnotePayload,
  type ImageActivationPayload,
  type MediaReadingAnchor,
  type ReaderNoteForPaginator,
  type SelectionContextPayload,
  type WithinChapterNavigationOptions,
  type PreciseNavigationRequest,
  type PreciseNavigationStatus,
  type ReadingAnchor,
  type ReaderPositionSnapshot,
  type RestoreReportTicket,
} from "../render/paginator";
import type { ResourceServer } from "../render/resources";
import { arrowKeyDirection, effectivePageProgression, normalizeTurnAnimation, type ReaderSettings, type TurnAnimation } from "../render/settings";
import { textProjectionVersion, type CompiledTextProjection } from "../render/textProjection/compile";
import {
  DEFAULT_TEXT_PROJECTION_PREFERENCES,
  type TextProjectionPreferences,
} from "../render/textProjection/types";
import {
  DEFAULT_VISUAL_PREFERENCES,
  type ReaderVisualPreferences,
} from "../render/visual/readerVisualPreferences";
import { attachReaderPaint } from "../render/visual/readerVisualPaint";
import type { ReaderPaintHandle } from "../render/visual/readerVisualPreferences";
import {
  classifySettingsChange,
  sameLayoutSettings,
  sameRenderingSettings,
  samePageMargins,
} from "../render/readerTheme";
import { PagedLayoutTransactionCoordinator } from "./pagedLayoutTransaction";
import { createSettingsReloadDebouncer } from "./settingsReload";
import { TurnIntentBuffer, WheelTurnAccumulator } from "./turnIntent";
import { ReadingWarmupPlan, backgroundPreparation, type WarmupTicket } from "./readerWarmup";
import { ContinuousReaderView } from "./ContinuousReaderView";
import { SingleLeafSpreads, type SingleLeafSpread } from "./singleLeafSpreads";
import { createLeafChapterClassifier } from "./leafChapterCandidates";
import { ImageSpreadReaderView } from "./ImageSpreadReaderView";
import { EdgeTurnZone } from "./EdgeTurnZone";
import { EdgeTurnFeedbackContext, useEdgeTurnFeedbackOwner } from "./edgeTurnFeedback";
import type { PlainTapInfo, PlainTapPoint } from "../render/plainTap";
import {
  createReaderTapGeometry,
  edgeFeedbackKeyOf,
  edgeTurnZoneSpecs,
  ReaderTapRoutingContext,
  ReaderTurnOwnerContext,
  routeHostBlankTurn,
  routeReaderTap,
  useReaderTapRouting,
  type ReaderTapRegionSettings,
  type ReaderTapRouting,
} from "./readerTapRouting";
import { createSpreadGeometry } from "../render/pagedSpread";
import type { ScrubToken } from "./readerProgressAxis";
import { installPagedSwipe, PAGED_SWIPE_THRESHOLD_PX } from "../render/pagedSwipe";
import { ChapterSeam, type ExternalSeam } from "./chapterSeam";
import { ChapterFillIndex, chapterFillEntries } from "../render/chapterFill";
import { canJoinChapters, chapterFillLayoutKey, joinLaneClip, type JoinLeaves } from "./chapterJoin";
import { PAGED_LAYER, planPresentationLayers, standbyReaderProps, type PresentationPlan } from "./presentationStack";
import {
  animateValue,
  dragScrollLeft,
  prefersReducedMotion,
  slideDurationMs,
  releaseSlidePlan,
  releaseVelocity,
  type SlideFrame,
  type ValueAnimation,
} from "./pagedSlide";
import { uiText } from "./localization/UiLanguageProvider";
import { BookmarkRibbonLayer } from "./BookmarkRibbonLayer";
import { pageRibbonLeft, type RibbonBookmark, type RibbonCue, type RibbonMark, type ScreenBookmarks } from "./bookmarkRibbons";

export interface ReaderHandle {
  nextPage(): void;
  prevPage(): void;
  setPage(i: number): void;
  /** 按比例 (0..1) 滚动或跳转 */
  scrollToRatio?(ratio: number): void;
  /** 统一内容轴章内比例跳转与会话票据 */
  seekContentFraction?(
    target: { key: string; spineIndex: number; fraction: number },
    token: ScrubToken,
  ): void;
  /** 渲染诊断文本（浏览器内调试） */
  diagnose(): string;
  /** 当前阅读锚点（进度持久化与内容进度） */
  getReadingAnchor(): {
    path: string;
    index: number;
    ratio: number;
    charsRead: number;
    totalChars: number;
    mediaUnits: number;
    textOffset: number | null;
    textSnippet: string | null;
    /** B-155：纯图片页跨模式复用图内身份/比例；旧调用方可忽略。 */
    mediaAnchor?: MediaReadingAnchor | null;
  } | null;
  /** 解析书签在当前章布局下的屏号（0基屏号）；无法解析时返回 null */
  resolveBookmarkPage?(bookmark: {
    id?: string;
    anchorTextOffset?: number | null;
    anchorTextSnippet?: string | null;
    mediaAnchor?: MediaReadingAnchor | null;
    page?: number;
  }): number | null;
  /** A15：当前屏上各页和挂在上面的书签（滚动模式为屏上能看到丝带的书签）。 */
  screenBookmarks?(bookmarks: readonly RibbonBookmark[]): ScreenBookmarks | null;
  /** A15：在当前屏第 lane 页取书签位置（双页补右页用）；该页没有正文时为 null。 */
  captureBookmarkAnchor?(lane: 0 | 1): {
    spineIndex: number;
    page: number;
    anchor: ReadingAnchor;
    text: string | null;
  } | null;
  /**
   * A13：本章已提交的双页几何（一页章并排时第二章按自己的栏步长挪到另一格）。
   * pending = 当前视口还没排完（窗口刚变，等 onLayoutSettled）；null = 已排完但不是双页。
   */
  spreadLeafLayout?(): { columnStep: number } | "pending" | null;
  /** Q5：没有进行中的翻页运动（拖动、松手漂移、按键动画）；后台准备工作据此让路。 */
  pageMotionIdle?(): boolean;
  /** A16 第二阶段：本视图已排好、静止在 edge 那一屏，可以作为章边联动的相邻一侧。 */
  seamReady?(edge: "start" | "end"): boolean;
  /** 当前锚点元素的一行文本（书签列表展示用） */
  getAnchorText(): string | null;
  /**
   * 页号与锚点的同一次读数（原生滑动途中取视觉屏）。进度/书签/历史用它，不再
   * 分别取 chapterState 与 getReadingAnchor。null：宿主回退到已发布状态 + 锚点。
   */
  readPositionSnapshot(options?: { withText?: boolean }): ReaderPositionSnapshot | null;
  /** 跳到页内锚点（注释返回链接等） */
  jumpToAnchor(anchor: string): void;
  /** 在已完成布局的当前章节内同步导航；失败不改变位置。 */
  navigateWithinCurrentChapter(options: WithinChapterNavigationOptions): boolean;
  /** 同章精确搜索命中；B-155 可选携带 canonical chapterPath 防止串章。 */
  navigateToSearchTarget(
    request: PreciseNavigationRequest & { chapterPath?: string },
  ): PreciseNavigationStatus;
  /** 脚注标记当前矩形（阅读区坐标系），弹层随重排重定位用。 */
  getFootnoteMarkerRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null;
  /** UI 层关闭固定脚注后同步分页器状态 */
  dismissFootnote(): void;
  /** 宿主点按弹注卡片：固定当前预览弹注。 */
  pinFootnote(): void;
  /** 宿主脚注卡片 hover 进入/离开时同步 iframe 内 hover gate。 */
  setFootnoteOverlayHover(over: boolean): void;
  /** 清除正文 iframe 内的原生文本选区。 */
  clearTextSelection(): void;
  /** 滚动模式：正文滚动到本章顶部。 */
  scrollToStart(): void;
  /** 滚动模式：正文滚动到本章末尾。 */
  scrollToEnd(): void;
  /** 滚动模式：章内真实边界判断（虚拟屏号不参与）。 */
  atScrollBoundary(direction: 1 | -1): boolean;
  /** 滚动模式：上下移动约 0.9 屏；返回是否真实移动。 */
  scrollByViewport(direction: 1 | -1): boolean;
  /** 滚动模式：按像素位移滚动正文。 */
  scrollByDelta(deltaY: number): void;
  /**
   * 同步原位提交主题：返回前所有在用正文宿主（分页槽位、连续章节、图组两页、
   * 辅助章）已换色。主题过渡在 ViewTransition 更新回调内调用；同主题不重做。
   */
  applyTheme(theme: ReaderSettings["theme"]): void;
}

export interface ReaderViewProps {
  book: Book;
  server: ResourceServer;
  spineIndex: number;
  /** 目录跳转的页内锚点（随章节切换一起更新） */
  anchor?: string;
  /** 锚点变更序号：仅用于跨章或同章 direct 失败后的兼容重载 */
  anchorNonce: number;
  settings: ReaderSettings;
  /** T-1 text projection snapshot for this chapter window. */
  textProjectionPreferences?: TextProjectionPreferences;
  textProjection?: CompiledTextProjection | null;
  /** FX-1/FX-2 paint preferences; never enters ReaderSettings. */
  visualPreferences?: ReaderVisualPreferences;
  compareOriginal?: boolean;
  /** 用户上传字体的会话内资源（family + blob URL） */
  userFonts: Array<{ family: string; url: string }>;
  /** A13：一页章并排时，另一章（非当前章）的笔记；返回值需稳定。 */
  notesForChapter?(spineIndex: number): ReaderNoteForPaginator[];
  /** 当前章节笔记；更新仅重建 CSS Highlight，不触发章节重载。 */
  notes: ReaderNoteForPaginator[];
  onPageState(s: ChapterState): void;
  /** Paginator display gate released after final anchor/page positioning. */
  onDisplayReady(ticket: RestoreReportTicket | null): void;
  /** A13 并排叶：本章首次显示之后，每次分页重排（窗口/字号变化）提交完成时回调；不重复 display-ready。 */
  onLayoutSettled?(): void;
  /** 请求切换到相邻章节（next/prev 或空章自动前进） */
  onRequestChapter(index: number, opts?: { atEnd?: boolean }): void;
  /** Turn target for a page-turn input; an image-spread leaf answers for its
   * whole pair so a boundary leaf never starts a chapter exit with no target. */
  chapterNeighbor?(index: number, dir: 1 | -1): number;
  /** 章节切换请求（nonce 单调递增；atEnd=true 表示加载完成后翻到最后一页） */
  startAtEnd: { nonce: number; atEnd: boolean };
  /** unresolvedResources: book paths with no usable URL in this chapter, for session-level aggregation. */
  onIssues(issues: string[], unresolvedResources?: readonly string[]): void;
  /** 书内链接跳转（已解析为书内路径，含可选 #anchor） */
  onInternalLink(href: string): void;
  /** 普通书内链接改变位置前通知 UI 记录一次撤销快照。 */
  onBeforeInternalNavigate(href: string): void;
  /** 同章 fragment 已同步完成定位，可再次捕获下一次跳转。 */
  onInternalNavigationSettled(): void;
  /** 连续模式语义锚点失败时结束 loading，但不冒充定位成功。 */
  onNavigationUnresolved?(reported: boolean): void;
  /** 连续宿主发生真实用户位移；程序化定位/重排不触发。 */
  onUserReadingPositionChange?(ticket: RestoreReportTicket | null): void;
  /**
   * 首次恢复结果（活动槽、本次加载一次）：located=false 表示保存的正文目标
   * 未能解析，页面可能停在章首，宿主不能把它当作新位置保存。
   */
  onRestoreResult?(result: {
    chapterPath: string;
    located: boolean;
    ticket: RestoreReportTicket | null;
  }): void;
  /** Immutable identity of this opening restore; forwarded into the paginator load. */
  restoreTicket?: RestoreReportTicket | null;
  /** 外部链接（http/https/mailto/tel）交给系统默认浏览器/应用打开 */
  onExternalLink(url: string): void;
  /** 脚注弹层（文本/HTML/固定状态 + 标记在阅读区坐标系的矩形） */
  onFootnote(payload: FootnotePayload): void;
  /** 桌面端 hover 移出脚注标记时关闭弹层 */
  onFootnoteClose(): void;
  /** iframe 正文有效选区的自定义右键菜单数据（rect 已换算为宿主 viewport）。 */
  onSelectionContextMenu?(payload: SelectionContextPayload | null): void;
  /** 跨章精确搜索/笔记目标；仅当前章节命中时交给 paginator，在显示门内解析。 */
  preciseTarget?: (PreciseNavigationRequest & { chapterPath: string }) | null;
  /** 正文图片激活（仅活动章节转发）；由 App 打开独立浮层。 */
  onImageActivation?(image: ImageActivationPayload): void;
  /** 图片浮层打开时暂停正文按键/滚轮/触摸翻页输入。 */
  inputPaused?: boolean;
  /** 手机触摸普通轻点：用于显隐阅读工具；由 App 根协调者决定动作。分页模式下只收到中间区域的轻点。 */
  onPlainTap?: () => void;
  /** 分页模式点击翻页区域：当前设备类别与本机偏好；未提供时保持原默认边缘区。 */
  tapRegions?: ReaderTapRegionSettings;
  /** paginator 对跨章精确目标的最终定位状态。 */
  onPreciseNavigationStatus?(status: {
    requestId: number;
    status: PreciseNavigationStatus;
    exact: boolean;
  }): void;
  /** 打开书时恢复的阅读锚点（可选，页码之外的精确定位） */
  initialAnchor?: {
    index: number;
    ratio: number;
    anchorTextOffset: number | null;
    anchorTextSnippet: string | null;
    /** B-155：纯图片页可选的媒体身份/比例；文本锚点优先。 */
    mediaAnchor?: MediaReadingAnchor | null;
  } | null;
  /** Legacy page fallback; paginator consumes it only after both anchors fail. */
  initialPage?: number | null;
  /** 连续模式恢复初始对齐：reading-line 对齐到 20% 阅读线（书签恢复专用），context 对齐到顶部微小 inset（默认） */
  initialAlignment?: "reading-line" | "context";
  /** 连续滚动模式：视口上方约 20% 阅读线观察到的可见章节变化 */
  onVisibleChapterChange?(index: number, anchor: ReadingAnchor | null): void;
  onContentFractionSettled?(
    token: ScrubToken,
    location: { key: string; spineIndex: number; fraction: number; atEnd: boolean },
  ): void;
  onContentFractionCancelled?(token: ScrubToken): void;
  onContentFractionFailed?(token: ScrubToken): void;
  onUserProgressSample?(location: {
    key: string;
    spineIndex: number;
    fraction: number;
    atEnd: boolean;
  }): void;
  /** A15：本书书签；视图自己筛出本章、按已有解析挂丝带。 */
  bookmarks?: readonly RibbonBookmark[];
  /** A15：放入 / 收回 / 跳转提示动画。 */
  bookmarkCue?: (RibbonCue & { at: number }) | null;
  /**
   * A13 一页章并排的叶子：这一章只露出第一页，显示在 side 那一格，整体挪动了 shift 像素；
   * 丝带挂在那一格的外缘。
   */
  leafSlot?: { side: "left" | "right"; shift: number };
  /** 触摸顶部角落（物理左右）；返回 false 表示这里不是书签区，按普通点击处理。 */
  onBookmarkCornerTap?(side: "left" | "right"): boolean;
  /** 本章排好后的实际翻页方向（竖排按书写方向）；外层的点击翻页区据此映射左右。 */
  onFlowProgression?(progression: "ltr" | "rtl"): void;
  /** A16：相邻章能否用章边联动进入（会显示为 A13 并排组的章节不能，由外层判断）。 */
  seamTargetEligible?(spineIndex: number): boolean;
  /**
   * A16 第二阶段：外层已在本视图排好并显示着这一章时发来的换章请求。值与当前
   * spineIndex/anchorNonce/startAtEnd.nonce 全部一致时只接管显示，不重新导航。
   */
  adoptedNavigation?: { spineIndex: number; anchorNonce: number; startNonce: number } | null;
  /** A16 第二阶段：与相邻显示层（A13 并排组/常驻普通视图）之间的章边联动，由外层创建与收尾。 */
  externalSeam?(direction: 1 | -1): ExternalSeam | null;
  /**
   * A13-2：这一章在双页里按普通正文显示（可参与章边拼接），还是独立显示（A13 并排组）；
   * undefined = 尚未分类。resolve 版本供后台测量前补分类（只读 XHTML）。
   */
  chapterFillKind?(spineIndex: number): "ordinary" | "isolated" | undefined;
  resolveChapterFillKind?(spineIndex: number, signal: AbortSignal): Promise<"ordinary" | "isolated">;
}

type ReaderFrame = "primary" | "secondary" | "tertiary" | "quaternary" | "quinary" | "warmup";
type LiveReaderFrame = Exclude<ReaderFrame, "warmup">;

const LIVE_READER_FRAMES: readonly LiveReaderFrame[] = [
  "primary",
  "secondary",
  "tertiary",
  "quaternary",
  "quinary",
];

/** 按阅读顺序列出 linear spine 下标；高性能预备队列只调度正文章。 */
function linearSpineIndices(book: Book): number[] {
  const indices: number[] = [];
  for (let i = 0; i < book.spine.length; i += 1) {
    if (book.spine[i].linear) indices.push(i);
  }
  return indices;
}

interface JoinAttachment {
  slot: PaginatorSlot;
  side: 1 | -1;
  joinPage: number;
  neighborPage: number;
}

interface PaginatorSlot {
  frame: ReaderFrame;
  iframe: HTMLIFrameElement;
  paginator: ChapterPaginator | null;
  path: string | null;
  spineIndex: number | null;
  state: ChapterState;
  ready: boolean;
  generation: number;
  renderSettings: ReaderSettings;
  /** One-shot restore identity for this load; null for normal navigation/preload. */
  restoreTicket: RestoreReportTicket | null;
  /** A13-2：这次加载要求的读者空栏（未带选项时为 undefined）。 */
  fillAsked?: 0 | 1;
}

/** 触屏用松手漂移曲线，鼠标/触控板用桌面缓出（与章内运动同一判断）。 */
function prefersCoarsePointer(): boolean {
  try {
    return window.matchMedia?.("(pointer: coarse)").matches === true;
  } catch {
    return false;
  }
}

function parseViewport(vp: string | undefined): { w: number; h: number } | null {
  if (!vp) return null;
  const m = /^(\d+)\s*[xX,]\s*(\d+)$/.exec(vp.trim());
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

/** Paper color behind a transparent body iframe, applied only while filters are active. */
export function readerSurfaceBackground(surface: HTMLElement): string | null {
  return surfaceBackground(surface, ".reader");
}

/** 固定版式页面保持原始版式；强制横排只作用于可重排正文。 */
export function effectiveReaderSettings(settings: ReaderSettings, fixedLayout: boolean): ReaderSettings {
  if (!fixedLayout && settings.gapPx !== 0) return settings;
  return {
    ...settings,
    gapPx: 0,
    forceHorizontal: fixedLayout ? false : settings.forceHorizontal === true,
  };
}

/** 预加载开关只影响调度，不属于活动 paginator 的布局身份。 */
export {
  sameRenderingSettings,
  sameLayoutSettings,
  samePageMargins,
  classifySettingsChange,
  PagedLayoutTransactionCoordinator,
};

const PagedReaderView = forwardRef<ReaderHandle, ReaderViewProps>(function PagedReaderView(
  props,
  ref
) {
  const { book, server, spineIndex, settings } = props;
  const chapterNeighborRef = useRef(props.chapterNeighbor);
  chapterNeighborRef.current = props.chapterNeighbor;
  const neighbor = (index: number, dir: 1 | -1): number =>
    chapterNeighborRef.current?.(index, dir) ?? nextLinearIndex(book, index, dir);
  const primaryIframeRef = useRef<HTMLIFrameElement>(null);
  const secondaryIframeRef = useRef<HTMLIFrameElement>(null);
  const tertiaryIframeRef = useRef<HTMLIFrameElement>(null);
  const quaternaryIframeRef = useRef<HTMLIFrameElement>(null);
  const quinaryIframeRef = useRef<HTMLIFrameElement>(null);
  const warmupIframeRef = useRef<HTMLIFrameElement>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);
  const swipeHintRef = useRef<HTMLDivElement>(null);
  const swipePreviewRef = useRef<{ frame: number; dx: number | null }>({ frame: 0, dx: null });
  const updateSwipePreviewRef = useRef<(dx: number | null) => void>(() => {});
  const activeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const visualOverlayRef = useRef<HTMLDivElement | null>(null);
  const paintHandleRef = useRef<ReaderPaintHandle | null>(null);
  const paginatorRef = useRef<ChapterPaginator | null>(null);
  const activeSlotRef = useRef<PaginatorSlot | null>(null);
  const layoutCoordinatorRef = useRef(new PagedLayoutTransactionCoordinator());
  // 高性能模式下活动章加最多四个邻章组成当前章 ±2 五章活缓存。
  // Spare slots are never allowed to emit UI callbacks; their state is only
  // used by the cache scheduler.
  const spareSlotsRef = useRef<PaginatorSlot[]>([]);
  const [activeFrame, setActiveFrame] = useState<ReaderFrame>("primary");
  const activeFrameRef = useRef<ReaderFrame>("primary");

  // ---- 翻页过渡：滑动（同章跟手 scrollLeft）、淡入（落位轻推）、跨章滑入 ----
  const [turnAnim, setTurnAnim] = useState<{ direction: 1 | -1 } | null>(null);
  // ---- A15 书签丝带：只读已提交布局，落定后按当前屏重挂 ----
  const [ribbonMarks, setRibbonMarks] = useState<RibbonMark[]>([]);
  const [ribbonMotion, setRibbonMotion] = useState(false);
  const ribbonMotionRef = useRef(false);
  const ribbonSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bookmarksRef = useRef(props.bookmarks);
  bookmarksRef.current = props.bookmarks;
  const leafSlotRef = useRef(props.leafSlot);
  leafSlotRef.current = props.leafSlot;
  const readScreenBookmarks = (bookmarks: readonly RibbonBookmark[]) => {
    const p = paginatorRef.current;
    const slot = activeSlotRef.current;
    if (!p || !slot || slot.state.status !== "ready" || slot.spineIndex === null) return null;
    const placed = p.bookmarkPageFrames?.(leafSlotRef.current);
    if (!placed) return null;
    const page = p.currentPage;
    const spineIndex = slot.spineIndex;
    const own = bookmarks.filter((bookmark) => bookmark.spineIndex === spineIndex);
    return {
      page,
      top: placed.top,
      columns: placed.columns,
      pages: placed.frames.map((frame) => ({
        lane: frame.lane,
        side: frame.side,
        outerX: frame.outerX,
        spineIndex,
        ids: own.filter((bookmark) => {
          const placement = p.resolveBookmarkPlacement?.(bookmark);
          return placement?.page === page && placement.lane === frame.lane;
        }).map((bookmark) => bookmark.id),
      })),
    };
  };
  const refreshRibbonsRef = useRef<() => void>(() => {});
  refreshRibbonsRef.current = () => {
    if (ribbonSettleTimerRef.current) clearTimeout(ribbonSettleTimerRef.current);
    ribbonSettleTimerRef.current = null;
    // 运动在途时画出来的是半路位置（会在新页某处闪一下）；保持隐藏，等落定的 ready 再画。
    if (paginatorRef.current?.pageMotionIdle === false || liveSeam() || joinMotionRef.current) {
      markRibbonMotion();
      return;
    }
    ribbonMotionRef.current = false;
    setRibbonMotion(false);
    const host = readerContainerRef.current?.getBoundingClientRect();
    const screen = host ? readScreenBookmarks(bookmarksRef.current ?? []) : null;
    if (!host || !screen) {
      setRibbonMarks((marks) => marks.length === 0 ? marks : []);
      return;
    }
    setRibbonMarks(screen.pages.filter((page) => page.ids.length > 0).map((page) => ({
      // 带页号：换页后是新的节点，不沿用上一页丝带的动画状态。
      key: `${page.spineIndex}:${screen.page}:${page.lane}`,
      ids: page.ids,
      x: pageRibbonLeft(page.side, page.outerX) - host.left,
      y: screen.top - host.top,
      kind: "page",
      side: page.side,
    })));
  };
  /** 翻页途中丝带先淡出；没有落到新页（回弹）时稍后按原页恢复。 */
  const markRibbonMotion = (settleMs = 0): void => {
    if (!ribbonMotionRef.current) {
      ribbonMotionRef.current = true;
      setRibbonMotion(true);
    }
    if (ribbonSettleTimerRef.current) clearTimeout(ribbonSettleTimerRef.current);
    ribbonSettleTimerRef.current = settleMs > 0 ? setTimeout(() => refreshRibbonsRef.current(), settleMs) : null;
  };
  useEffect(() => {
    refreshRibbonsRef.current();
  }, [props.bookmarks, props.leafSlot?.side, props.leafSlot?.shift]);
  useEffect(() => () => {
    if (ribbonSettleTimerRef.current) clearTimeout(ribbonSettleTimerRef.current);
  }, []);
  const turnAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 同章连续翻页先 finish；新章节导航取消旧动画，不能提交到复用后的文档。 */
  const slideAnimRef = useRef<ValueAnimation | null>(null);
  /** 同章拖动中的视觉位置；松手后由翻页接续或下一微任务回弹。frame.page 是拖动目标屏。 */
  const slideDragRef = useRef<{ dir: 1 | -1; frame: SlideFrame & { page: number }; scrollLeft: number; samples: Array<{ t: number; x: number }> } | null>(null);
  /** A new committed navigation invalidates waits, including reentry into the same chapter. */
  const chapterNavigationRef = useRef(0);
  /** Entry belongs to one target and one navigation, not to whichever chapter becomes ready first. */
  const chapterEnterRef = useRef<{
    direction: 1 | -1; spineIndex: number; book: Book; anchorNonce: number; navigation: number | null;
  } | null>(null);
  const chapterTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chapterTurnPhaseRef = useRef(0);

  useEffect(() => {
    return () => {
      if (turnAnimTimerRef.current) clearTimeout(turnAnimTimerRef.current);
      if (chapterTurnTimerRef.current) clearTimeout(chapterTurnTimerRef.current);
      slideAnimRef.current?.cancel();
      slideAnimRef.current = null;
    };
  }, []);

  const resolvedTurnAnimation = (): TurnAnimation => {
    const value = normalizeTurnAnimation(settings.turnAnimation);
    return value !== "none" && prefersReducedMotion() ? "none" : value;
  };
  /**
   * “滑动”翻页时同章触摸翻页交给分页器：可中断的合成层运动（不支持时退回原生
   * 滚动 + 吸附），见 ChapterPaginator.setNativeSnapPaging。
   */
  const nativeSnapWantedRef = useRef(false);
  /** 运动层接手的本次拖动；松手由翻页接续或下一微任务回到起点屏。 */
  const motionDragRef = useRef<{ ticket: number; samples: Array<{ t: number; x: number }> } | null>(null);
  /** 每个独立翻页操作一个单调 ID（同一操作派生的回调共用）。 */
  const motionInputIdRef = useRef(0);
  /**
   * A16 章边联动（仅高性能预读）：借用的相邻缓存槽、本次拖动，以及落定后到升格前
   * 收到的一次同向翻页（升格后在新章里执行）。landed 后等 spineIndex effect 升格接管。
   */
  const seamRef = useRef<{
    seam: ChapterSeam;
    /** 借用的缓存槽；外层显示层之间的联动为 null（external 负责显示与收尾）。 */
    slot: PaginatorSlot | null;
    external: ExternalSeam | null;
    targetIndex: number;
    landed: boolean;
    drag: { ticket: number; samples: Array<{ t: number; x: number }> } | null;
    pending: 1 | -1 | null;
  } | null>(null);
  /** 升格后补执行的那一次同向翻页；只属于升格时的槽与导航，定位/退出即作废。 */
  const seamReplayRef = useRef<{ timer: ReturnType<typeof setTimeout>; slot: PaginatorSlot; navigation: number } | null>(null);
  // ---- A13-2 章边拼接屏 ----
  const chapterFillKindRef = useRef(props.chapterFillKind);
  chapterFillKindRef.current = props.chapterFillKind;
  const resolveChapterFillKindRef = useRef(props.resolveChapterFillKind);
  resolveChapterFillKindRef.current = props.resolveChapterFillKind;
  /** 本书本版式的精确叶数索引；版式身份一变就换新（见 chapterFillLayoutKey）。 */
  const fillRef = useRef<{ book: Book; index: ChapterFillIndex } | null>(null);
  /** 本版式下测不出叶数的章（字体/图片未定型、加载失败），同一版式里不反复重测。 */
  const fillTriedRef = useRef(new Set<number>());
  /** 挂在拼接屏两侧的另一章；当前章停在 joinPage 时它恰好在原位（停在 neighborPage）。 */
  const joinAttachRef = useRef<JoinAttachment[]>([]);
  /** 穿过拼接屏的那一次滑动：另一章接过运动，当前章作为它的伴随元素一起移动。 */
  const joinMotionRef = useRef<{
    owner: PaginatorSlot;
    follower: PaginatorSlot;
    direction: 1 | -1;
    homePage: number;
    targetIndex: number;
    drag: { ticket: number; samples: Array<{ t: number; x: number }> } | null;
    landed: boolean;
  } | null>(null);
  /** 穿越落定在另一章：升格时保留它当前这一屏（不回到章首/章末）。 */
  const joinLandingRef = useRef<PaginatorSlot | null>(null);
  nativeSnapWantedRef.current = resolvedTurnAnimation() === "slide";

  /** 淡入模式的落位动画；滑动模式由 startSlideTurn / 跨章滑入自行绘制。 */
  const triggerTurnAnimation = (dir: 1 | -1) => {
    if (resolvedTurnAnimation() !== "fade") {
      setTurnAnim(null);
      return;
    }
    if (turnAnimTimerRef.current) clearTimeout(turnAnimTimerRef.current);
    setTurnAnim({ direction: (dir * pageAxisSign(progressionNow())) as 1 | -1 });
    turnAnimTimerRef.current = setTimeout(() => setTurnAnim(null), 180);
  };

  /**
   * 跨章滑出/滑入用 dataset 同步切换（不经 React 渲染），避免清除滑出态与
   * 加上滑入态之间漏出一帧已就位的新章。
   */
  const setChapterTurnPhase = (phase: "exit" | "enter" | null, dir: 1 | -1 = 1, durationMs = 0): void => {
    const phaseTicket = ++chapterTurnPhaseRef.current;
    if (chapterTurnTimerRef.current) clearTimeout(chapterTurnTimerRef.current);
    chapterTurnTimerRef.current = null;
    const main = readerContainerRef.current;
    if (!main) return;
    delete main.dataset.turnExit;
    delete main.dataset.turnEnter;
    if (phase === null) return;
    main.dataset[phase === "exit" ? "turnExit" : "turnEnter"] = dir * pageAxisSign(progressionNow()) === 1 ? "next" : "prev";
    chapterTurnTimerRef.current = setTimeout(() => {
      if (phaseTicket !== chapterTurnPhaseRef.current) return;
      // 滑出兜底：新章失败/取消时不能让正文停在滑出态。
      if (phase === "exit") chapterEnterRef.current = null;
      setChapterTurnPhase(null);
    }, durationMs);
  };

  /** 跨章翻页：滑动模式让旧章滑出并登记滑入方向；其他模式保持原落位动画。 */
  const beginChapterTurn = (dir: 1 | -1, targetIndex: number): void => {
    if (resolvedTurnAnimation() !== "slide") {
      triggerTurnAnimation(dir);
      return;
    }
    chapterEnterRef.current = { direction: dir, spineIndex: targetIndex, book, anchorNonce: props.anchorNonce, navigation: null };
    setChapterTurnPhase("exit", dir, 1500);
  };

  useLayoutEffect(() => {
    const navigation = ++chapterNavigationRef.current;
    // Stop the old fallback before a reused iframe can show the new document.
    slideAnimRef.current?.cancel();
    slideAnimRef.current = null;
    slideDragRef.current = null;
    motionDragRef.current = null;
    updateSwipePreviewRef.current(null);
    const enter = chapterEnterRef.current;
    if (enter && enter.navigation === null && enter.book === book &&
        enter.spineIndex === spineIndex && enter.anchorNonce === props.anchorNonce) {
      enter.navigation = navigation;
    } else {
      chapterEnterRef.current = null;
      setChapterTurnPhase(null);
    }
    return () => { ++chapterNavigationRef.current; };
    // Only a new navigation changes ownership, not rerenders or theme updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, server, spineIndex, props.anchorNonce, props.startAtEnd.nonce]);

  const redirectEmptyChapterEntry = (targetIndex: number): void => {
    const enter = chapterEnterRef.current;
    if (enter?.navigation === chapterNavigationRef.current) {
      chapterEnterRef.current = { ...enter, spineIndex: targetIndex, navigation: null };
    }
  };

  /**
   * 同章滑动翻页：按计划从真实视觉位置（拖动中则接续手指位置）动画到目标屏，
   * 结束时 setPage(计划目标) 提交。非滑动模式返回 false，调用方直接 setPage。
   */
  const startSlideTurn = (
    p: ChapterPaginator,
    plan: { page: number; from: number; to: number },
    drag: { frame: SlideFrame; scrollLeft: number; samples: Array<{ t: number; x: number }> } | null = null,
  ): boolean => {
    if (resolvedTurnAnimation() !== "slide") return false;
    markRibbonMotion(1200);
    const continuing = drag !== null;
    const frame = continuing ? drag.frame : { from: plan.from, to: plan.to };
    const start = continuing ? drag.scrollLeft : plan.from;
    const target = plan.page;
    const done = (): void => {
      slideAnimRef.current = null;
      if (paginatorRef.current === p) p.setPage(target, { userInitiated: true });
    };
    if (continuing) {
      // 松手续接：起始速度取手指离手速度，避免第一帧跳出一大截。
      const release = releaseSlidePlan(frame.to - start, Math.abs(frame.to - frame.from),
        releaseVelocity(drag.samples, performance.now()));
      slideAnimRef.current = animateValue(start, frame.to, release.durationMs,
        (value) => p.previewPagedScroll(value), done, undefined, release.ease);
      return true;
    }
    // 原生滑动途中接手时 from 是半途位置：时长仍按一整屏的比例计算。
    const span = Math.max(Math.abs(frame.to - frame.from), activeSlotRef.current?.iframe.clientWidth ?? 0);
    slideAnimRef.current = animateValue(
      start,
      frame.to,
      slideDurationMs(frame.to - start, span),
      (value) => p.previewPagedScroll(value),
      done,
    );
    return true;
  };

  /** 拖动未达到翻页条件：从手指位置回弹到当前页。 */
  const settleSlideDrag = (drag: { frame: SlideFrame; scrollLeft: number; samples: Array<{ t: number; x: number }> }): void => {
    const p = paginatorRef.current;
    if (!p) return;
    const plan = releaseSlidePlan(drag.frame.from - drag.scrollLeft, Math.abs(drag.frame.to - drag.frame.from),
      releaseVelocity(drag.samples, performance.now()));
    slideAnimRef.current = animateValue(
      drag.scrollLeft,
      drag.frame.from,
      plan.durationMs,
      (value) => p.previewPagedScroll(value),
      () => {
        slideAnimRef.current = null;
      },
      undefined,
      plan.ease,
    );
  };
  const preloadGenerationRef = useRef(0);
  // Keep the scheduler independent from the closure used when the active
  // paginator was created.  Toggling the experimental mode must neither
  // reload the active chapter nor let an old display-ready callback restart
  // a cancelled preload.
  const preloadAllowedRef = useRef(false);
  /** 后台时暂停非必要的全文/邻章预备；前台恢复仍沿用现有 scheduler。 */
  const backgroundPausedRef = useRef(typeof document !== "undefined" && document.visibilityState === "hidden");
  /** 显式目录/搜索/书签/历史跳转必须使用自身入口锚点，不得误命中相邻缓存。 */
  const handledAnchorNonceRef = useRef(props.anchorNonce);
  const spineIndexRef = useRef(spineIndex);
  const autoAdvanceRef = useRef(false);
  const outerScrollWheelRef = useRef(new WheelTurnAccumulator(160));
  const lockedReverseDirRef = useRef<1 | -1 | 0>(0);
  const reverseLockUntilRef = useRef(0);
  const sameDirThrottleUntilRef = useRef(0);
  const chapterTransitionLockedRef = useRef(false);
  const chapterTransitionCooldownUntilRef = useRef(0);
  const preloadDebounceTimerRef = useRef<number | null>(null);
  /** 当前正在完整排版的活缓存槽；输入到达时优先取消未发布的后台工作。 */
  const preloadInFlightSlotRef = useRef<PaginatorSlot | null>(null);
  /** 当前 book/布局代次下近邻完整排版失败的章，避免失败后立即重试同一章。 */
  const failedPreloadsRef = useRef(new Set<string>());
  /** B-153 串行全书预备：一个临时测量槽 + 纯调度 plan。 */
  const warmupPlanRef = useRef<ReadingWarmupPlan | null>(null);
  const warmupGenerationRef = useRef(0);
  const warmupTimerRef = useRef<number | null>(null);
  const warmupIdleRef = useRef<number | null>(null);
  const warmupIdleKindRef = useRef<"idle" | "timer" | null>(null);
  const warmupRunningRef = useRef(false);
  const warmupTicketRef = useRef<WarmupTicket | null>(null);
  const warmupSlotRef = useRef<PaginatorSlot | null>(null);

  const clearPreloadTimer = (): void => {
    if (preloadDebounceTimerRef.current !== null) {
      window.clearTimeout(preloadDebounceTimerRef.current);
      preloadDebounceTimerRef.current = null;
    }
  };

  /**
   * 换章滚轮手势保护：
   * 换章中丢弃残余滚轮脉冲；新章节显示就绪后给予 120ms 微冷却以避免惯性连跳，
   * 到期立即放行，不再采用无限后推的滑动静默窗口。
   */
  const isWheelGestureSuppressed = (): boolean => {
    if (!chapterTransitionLockedRef.current) return false;
    const now = Date.now();
    if (now < chapterTransitionCooldownUntilRef.current) {
      outerWheelRef.current.reset();
      outerScrollWheelRef.current.reset();
      paginatorRef.current?.resetWheelAccumulator?.();
      return true;
    }
    // 换章冷却已过，解除锁定并允许滚轮交互
    chapterTransitionLockedRef.current = false;
    outerWheelRef.current.reset();
    outerScrollWheelRef.current.reset();
    paginatorRef.current?.resetWheelAccumulator?.();
    return false;
  };

  const triggerChapterTransitionWheelLock = (): void => {
    const now = Date.now();
    chapterTransitionLockedRef.current = true;
    // 在新章节真正 display-ready 前锁定持续有效（兜底时间戳）
    chapterTransitionCooldownUntilRef.current = now + 300;
    outerWheelRef.current.reset();
    outerScrollWheelRef.current.reset();
    paginatorRef.current?.resetWheelAccumulator?.();
  };

  const armChapterTransitionDisplaySettled = (): void => {
    const now = Date.now();
    // 新章节已完成排版并正式呈现给用户，固定给予 120ms 的微冷却，杜绝无限滑动延期
    chapterTransitionCooldownUntilRef.current = now + 120;
    outerWheelRef.current.reset();
    outerScrollWheelRef.current.reset();
    paginatorRef.current?.resetWheelAccumulator?.();
  };
  const lastHandledStartAtEndNonceRef = useRef(props.startAtEnd.nonce);
  const lastStateRef = useRef<string>("loading");
  const lastReadyEmptyRef = useRef(false);
  const turnIntentRef = useRef(new TurnIntentBuffer());
  const outerWheelRef = useRef(new WheelTurnAccumulator());
  // ChapterPaginator 的生命周期只随 book/server 创建；这些 ref 保证它
  // 调用到每次 render 的最新回调，不捕获首次 loading 阶段的旧闭包。
  const onInternalLinkRef = useRef(props.onInternalLink);
  const onBeforeInternalNavigateRef = useRef(props.onBeforeInternalNavigate);
  const onInternalNavigationSettledRef = useRef(props.onInternalNavigationSettled);
  const onDisplayReadyRef = useRef(props.onDisplayReady);
  const onLayoutSettledRef = useRef(props.onLayoutSettled);
  const onSelectionContextMenuRef = useRef(props.onSelectionContextMenu);
  const onPageStateRef = useRef(props.onPageState);
  const onIssuesRef = useRef(props.onIssues);
  const onRequestChapterRef = useRef(props.onRequestChapter);
  const onFootnoteRef = useRef(props.onFootnote);
  const onFootnoteCloseRef = useRef(props.onFootnoteClose);
  const onExternalLinkRef = useRef(props.onExternalLink);
  const onPreciseNavigationStatusRef = useRef(props.onPreciseNavigationStatus);
  const onImageActivationRef = useRef(props.onImageActivation);
  const onRestoreResultRef = useRef(props.onRestoreResult);
  const onUserReadingPositionChangeRef = useRef(props.onUserReadingPositionChange);
  // 用户提交只由 ChapterPaginator 的真实落定命令回调驱动；这里不再用
  // touchstart + 时间窗推断，按下、预览、恢复或重排都不会解除失败保护。
  // 图片浮层打开时，分页器对按键/滚轮的回调被短路，触摸翻页也由下面的
  // overlay-active 样式屏蔽；关闭后不需要重新接线。
  const inputPausedRef = useRef(props.inputPaused === true);

  spineIndexRef.current = spineIndex;
  onInternalLinkRef.current = props.onInternalLink;
  onBeforeInternalNavigateRef.current = props.onBeforeInternalNavigate;
  onInternalNavigationSettledRef.current = props.onInternalNavigationSettled;
  onDisplayReadyRef.current = props.onDisplayReady;
  onLayoutSettledRef.current = props.onLayoutSettled;
  onSelectionContextMenuRef.current = props.onSelectionContextMenu;
  onPageStateRef.current = props.onPageState;
  onIssuesRef.current = props.onIssues;
  onRequestChapterRef.current = props.onRequestChapter;
  onFootnoteRef.current = props.onFootnote;
  onFootnoteCloseRef.current = props.onFootnoteClose;
  onExternalLinkRef.current = props.onExternalLink;
  onPreciseNavigationStatusRef.current = props.onPreciseNavigationStatus;
  onImageActivationRef.current = props.onImageActivation;
  // 书的元数据方向只作排好之前的兜底；竖排正文按书写方向翻页（vertical-rl 从右往左），
  // 元数据没写或写错时两边会相反，拖动就会逆着手指走。手势、按键、动画一律取分页器实际方向。
  const progressionRef = useRef<"ltr" | "rtl">("ltr");
  progressionRef.current = effectivePageProgression(props.book.pageProgression, props.settings, props.book.fixedLayout);
  const progressionNow = (): "ltr" | "rtl" => paginatorRef.current?.pageProgression ?? progressionRef.current;
  onRestoreResultRef.current = props.onRestoreResult;
  onUserReadingPositionChangeRef.current = props.onUserReadingPositionChange;
  inputPausedRef.current = props.inputPaused === true;
  preloadAllowedRef.current =
    settings.preloadNextChapter === true &&
    !book.fixedLayout &&
    settings.readingMode !== "scroll";

  const isActiveSlot = (slot: PaginatorSlot): boolean =>
    activeSlotRef.current === slot && paginatorRef.current === slot.paginator && slot.paginator !== null;

  const setActiveFrameVisual = (frame: LiveReaderFrame): void => {
    activeFrameRef.current = frame;
    // Demote cached chapters before revealing/preparing the new active owner.
    for (const slot of spareSlotsRef.current) slot.paginator?.setMotionWindowForeground?.(false);
    activeSlotRef.current?.paginator?.setMotionWindowForeground?.(document.visibilityState !== "hidden");
    const primary = primaryIframeRef.current;
    const secondary = secondaryIframeRef.current;
    const tertiary = tertiaryIframeRef.current;
    const quaternary = quaternaryIframeRef.current;
    const quinary = quinaryIframeRef.current;
    const warmup = warmupIframeRef.current;
    for (const [candidate, candidateFrame] of [
      [primary, "primary" as const],
      [secondary, "secondary" as const],
      [tertiary, "tertiary" as const],
      [quaternary, "quaternary" as const],
      [quinary, "quinary" as const],
      [warmup, "warmup" as const],
    ] as const) {
      if (!candidate) continue;
      if (candidateFrame === frame) {
        candidate.style.removeProperty("visibility");
        candidate.style.zIndex = "1";
      } else {
        candidate.style.setProperty("visibility", "hidden", "important");
        candidate.style.zIndex = "0";
      }
    }
    setActiveFrame(frame);
  };

  const publishActiveDisplayReady = (): void => {
    const slot = activeSlotRef.current;
    const paginator = paginatorRef.current;
    if (!slot || !paginator || !isActiveSlot(slot) || slot.spineIndex !== spineIndexRef.current) return;
    const state = paginator.getStateSnapshot();
    lastStateRef.current = state.status;
    if (state.status !== "ready") return;
    // B-151：空章是成功加载的一种终态。只有明确还有下一章且已经发起自动
    // 跳转时，旧空章不发布 active ready；末章空章必须解除 loading/turn intent。
    const hasNext = slot.spineIndex !== null && nextLinearIndex(book, slot.spineIndex, 1) >= 0;
    if (state.empty && (hasNext || autoAdvanceRef.current)) return;
    lastReadyEmptyRef.current = state.empty;
    armChapterTransitionDisplaySettled();
    const enter = chapterEnterRef.current;
    if (enter !== null && enter.navigation === chapterNavigationRef.current && enter.spineIndex === slot.spineIndex) {
      chapterEnterRef.current = null;
      setChapterTurnPhase("enter", enter.direction, 280);
    }
    onDisplayReadyRef.current(slot.restoreTicket ?? null);
    turnIntentRef.current.markReady();
    outerWheelRef.current.reset();
    outerScrollWheelRef.current.reset();
    paginator.resetWheelAccumulator?.();
    // 切章与定位就绪后，绝不立刻同步抢占主线程执行相邻章节重排，
    // 而是延后到用户稳定阅读的空闲期（500ms 后）再悄悄准备。
    scheduleAdjacentPreloadsDebounced(500);
  };

  const buildPaginator = (slot: PaginatorSlot): ChapterPaginator => {
    // Display-ready callbacks can outlive the render that created them.
    slot.renderSettings = latestRenderSettingsRef.current;
    const paginator = new ChapterPaginator({
      iframe: slot.iframe,
      server: server,
      settings: slot.renderSettings,
      strictXml: book.version === 2,
      pageProgression: book.pageProgression,
      onState: (state) => {
        slot.state = state;
        if (state.status !== "ready") slot.ready = false;
        // A13-2：接过穿越运动的那一章落定（它不是当前章，状态不对外发布）。
        if (joinMotionRef.current?.owner === slot && state.status === "ready" && !state.transient) {
          settleJoin(state.currentPage);
        }
        if (!isActiveSlot(slot) || slot.spineIndex !== spineIndexRef.current) return;
        lastStateRef.current = state.status;
        if (state.status === "loading" || state.status === "measuring") {
          turnIntentRef.current.markLoading();
          lastReadyEmptyRef.current = false;
        } else if (state.status === "error") {
          turnIntentRef.current.reset();
          lastReadyEmptyRef.current = false;
        } else {
          lastReadyEmptyRef.current = state.empty;
        }
        // 用户位置提交由 paginator 的 setUserCommitHandler 在真实落定后发出；
        // 这里只转发普通状态，绝不再按页号变化+时间窗推断用户输入。
        onPageStateRef.current(state);
        // transient 是运动途中的页码预览，不是落定：丝带继续隐藏。
        if (state.status === "ready" && !state.transient) {
          refreshRibbonsRef.current();
          syncJoin();
        } else markRibbonMotion();
        if (state.status === "ready") props.onFlowProgression?.(paginator.pageProgression);
        if (state.status !== "ready" || !state.empty || autoAdvanceRef.current) return;
        const next = nextLinearIndex(book, spineIndexRef.current, 1);
        if (next >= 0) {
          autoAdvanceRef.current = true;
          turnIntentRef.current.markLoading();
          redirectEmptyChapterEntry(next);
          onRequestChapterRef.current(next);
        }
      },
      onIssues: (issues, unresolvedResources) => {
        if (isActiveSlot(slot)) onIssuesRef.current(issues, unresolvedResources);
      },
      fixedLayout: book.fixedLayout,
      onNavigate: (href) => {
        if (isActiveSlot(slot)) onInternalLinkRef.current(href);
      },
      onBeforeInternalNavigate: (href) => {
        if (isActiveSlot(slot)) onBeforeInternalNavigateRef.current(href);
      },
      onInternalNavigationSettled: () => {
        if (isActiveSlot(slot)) onInternalNavigationSettledRef.current();
      },
      onWheelNavigate: (dir) => {
        if (!isActiveSlot(slot)) return;
        // 输入到达先于切换判断：即使处于换章静默期，也暂停未发布的后台测量。
        pauseBackgroundWarmupForInput();
        if (isWheelGestureSuppressed()) return;
        if (dir === lockedReverseDirRef.current && Date.now() < reverseLockUntilRef.current) return;
        turnPageRef.current(dir, "wheel");
      },
      onKeyNavigate: (dir, key) => {
        if (!isActiveSlot(slot) || inputPausedRef.current) return;
        turnPageRef.current(arrowKeyDirection(dir, key, progressionNow()), "key");
      },
      onFootnote: (payload) => {
        if (!isActiveSlot(slot)) return;
        const main = slot.iframe.parentElement;
        if (!main) {
          onFootnoteRef.current(payload);
          return;
        }
        const ir = slot.iframe.getBoundingClientRect();
        const mr = main.getBoundingClientRect();
        const dx = ir.left - mr.left;
        const dy = ir.top - mr.top;
        onFootnoteRef.current({
          ...payload,
          rect: {
            left: payload.rect.left + dx,
            top: payload.rect.top + dy,
            right: payload.rect.right + dx,
            bottom: payload.rect.bottom + dy,
          },
        });
      },
      onFootnoteClose: () => {
        if (isActiveSlot(slot)) onFootnoteCloseRef.current();
      },
      onExternalLink: (url) => {
        if (isActiveSlot(slot)) onExternalLinkRef.current(url);
      },
      onDisplayReady: () => {
        slot.ready = true;
        slot.state = paginator.getStateSnapshot();
        if (isActiveSlot(slot)) publishActiveDisplayReady();
      },
      onSelectionContextMenu: (payload) => {
        if (!isActiveSlot(slot)) return;
        if (!payload) {
          onSelectionContextMenuRef.current?.(null);
          return;
        }
        const rect = slot.iframe.getBoundingClientRect();
        onSelectionContextMenuRef.current?.({
          ...payload,
          rect: {
            left: payload.rect.left + rect.left,
            top: payload.rect.top + rect.top,
            right: payload.rect.right + rect.left,
            bottom: payload.rect.bottom + rect.top,
          },
        });
      },
      onPreciseNavigationStatus: (status) => {
        if (isActiveSlot(slot)) onPreciseNavigationStatusRef.current?.(status);
      },
      onImageActivation: (image) => {
        // 非活动槽（预加载）不得打开浮层；同时避免借用已撤销的 blob URL。
        if (isActiveSlot(slot)) onImageActivationRef.current?.(image);
      },
      externalScroll: undefined,
      pagedSwipe: {
        onNext: () => turnPageRef.current(pageAxisSign(progressionNow()), "ui"),
        onPrev: () => turnPageRef.current((-pageAxisSign(progressionNow())) as 1 | -1, "ui"),
        shouldIgnore: () =>
          !isActiveSlot(slot) ||
          inputPausedRef.current ||
          latestRenderSettingsRef.current.readingMode === "scroll" ||
          slot.state.status !== "ready",
        onPreview: (dx) => {
          if (isActiveSlot(slot)) updateSwipePreviewRef.current(dx);
        },
        // 原生滚动接手前先落定进行中的 JS 翻页动画，吸附点按已提交页计算。
        // 运动层模式下按下不改任何东西：横向意图成立才接手，轻点不撤回旧命令。
        onGestureStart: () => {
          if (!isActiveSlot(slot)) return;
          if (!slot.paginator?.pageMotionAvailable) slideAnimRef.current?.finish();
        },
      },
      onPlainTap: (tap) => {
        if (isActiveSlot(slot) && !inputPausedRef.current && slot.state.status === "ready") {
          const rect = slot.iframe.getBoundingClientRect();
          plainTapRef.current({ ...tap, clientX: tap.clientX + rect.left, clientY: tap.clientY + rect.top });
        }
      },
      shouldIgnorePlainTap: () => !isActiveSlot(slot) || inputPausedRef.current || slot.state.status !== "ready"
    });
    slot.paginator = paginator;
    paginator.setPlainTapRepeatClaim?.((point) => {
      const rect = slot.iframe.getBoundingClientRect();
      return claimsRepeatTapRef.current({ clientX: point.clientX + rect.left, clientY: point.clientY + rect.top });
    });
    paginator.setMotionWindowForeground?.(false);
    paginator.setTextProjectionPreferences?.(
      props.textProjectionPreferences ?? DEFAULT_TEXT_PROJECTION_PREFERENCES,
      props.textProjection ?? null,
    );
    paginator.setNativeSnapPaging?.(nativeSnapWantedRef.current);
    paginator.setLayoutSettledHandler?.(() => {
      // 预载/过期槽的重排不属于当前配对；首次显示仍只走 display-ready。
      if (slot.ready && isActiveSlot(slot) && slot.spineIndex === spineIndexRef.current) onLayoutSettledRef.current?.();
    });
    paginator.setPageMotionChapterHandler?.((direction) => {
      if (isActiveSlot(slot)) turnPageRef.current(direction, "ui");
    });
    paginator.setRestoreResultHandler?.((result) => {
      // 预加载槽不得向活动会话提交恢复结果。
      if (isActiveSlot(slot) && slot.path) {
        onRestoreResultRef.current?.({
          chapterPath: slot.path,
          located: result.located,
          ticket: result.ticket,
        });
      }
    });
    paginator.setUserCommitHandler?.(() => {
      // 只由真实翻页/滑动落定路径回调，恢复/重排/按下不会走到这里。
      if (isActiveSlot(slot)) onUserReadingPositionChangeRef.current?.(slot.restoreTicket ?? null);
    });
    return paginator;
  };

  const disposeSpareSlot = (slot: PaginatorSlot): void => {
    const index = spareSlotsRef.current.indexOf(slot);
    if (index < 0) return;
    if (seamRef.current?.slot === slot) abortSeam();
    if (preloadInFlightSlotRef.current === slot) preloadInFlightSlotRef.current = null;
    spareSlotsRef.current.splice(index, 1);
    const joinMotion = joinMotionRef.current;
    if (joinMotion && (joinMotion.owner === slot || joinMotion.follower === slot)) endJoinMotion();
    dropJoinSlot(slot);
    preloadGenerationRef.current++;
    slot.generation++;
    slot.paginator?.clearSearchHighlight();
    slot.paginator?.dispose();
    slot.paginator = null;
    slot.path = null;
    slot.spineIndex = null;
    slot.ready = false;
  };

  const disposeSpareSlots = (): void => {
    clearPreloadTimer();
    for (const slot of [...spareSlotsRef.current]) disposeSpareSlot(slot);
  };

  const iframeForFrame = (frame: ReaderFrame): HTMLIFrameElement | null => {
    if (frame === "primary") return primaryIframeRef.current;
    if (frame === "secondary") return secondaryIframeRef.current;
    if (frame === "tertiary") return tertiaryIframeRef.current;
    if (frame === "quaternary") return quaternaryIframeRef.current;
    if (frame === "quinary") return quinaryIframeRef.current;
    return warmupIframeRef.current;
  };

  const liveWindowIndices = (activeIndex: number): number[] => {
    const result: number[] = [activeIndex];
    // 资源预算已超且当前活缓存仍无法回收时，先把后台预读窗口收缩到当前章；
    // 当前可见章/单个超大资源可以暂时超预算，不能为了预算把正在显示的内容删掉。
    if (server.mediaCacheBudgetExceeded) return result;
    const add = (index: number): void => {
      if (index >= 0 && !result.includes(index)) result.push(index);
    };
    // 邻章优先级固定为 next、prev、next2、prev2；活缓存上限五章。
    const next1 = nextLinearIndex(book, activeIndex, 1);
    const prev1 = nextLinearIndex(book, activeIndex, -1);
    add(next1);
    add(prev1);
    if (next1 >= 0) add(nextLinearIndex(book, next1, 1));
    if (prev1 >= 0) add(nextLinearIndex(book, prev1, -1));
    return result;
  };

  const scheduleAdjacentPreloads = (): void => {
    if (backgroundPausedRef.current) return;
    // 滚动模式继续使用 ContinuousReaderView，不套五章固定缓存。
    if (latestRenderSettingsRef.current.readingMode === "scroll") {
      disposeSpareSlots();
      resetFullBookWarmup();
      return;
    }
    if (
      !preloadAllowedRef.current ||
      !secondaryIframeRef.current ||
      !tertiaryIframeRef.current ||
      !quaternaryIframeRef.current ||
      !quinaryIframeRef.current
    ) {
      disposeSpareSlots();
      resetFullBookWarmup();
      return;
    }
    const active = activeSlotRef.current;
    if (
      !active?.paginator ||
      active.spineIndex === null ||
      !active.ready ||
      active.state.status !== "ready" ||
      !sameRenderingSettings(active.renderSettings, latestRenderSettingsRef.current)
    ) {
      return;
    }

    const wantedIndices = liveWindowIndices(active.spineIndex);
    const wantedPaths = new Map<number, string>();
    for (const index of wantedIndices) {
      const path = spineItemPath(book, index);
      if (path) wantedPaths.set(index, path);
    }

    // 只保留当前章 ±2；远处旧槽立即淘汰，不把全文摘要当可显示缓存。
    // 显式跳到已缓存的相邻章会走普通加载，留下与当前章或彼此重复的槽：它们占着
    // 缓存位，真正缺的邻章就排不进来，也一并淘汰。
    const kept = new Set<number>([active.spineIndex]);
    for (const slot of [...spareSlotsRef.current]) {
      const duplicate = slot.spineIndex !== null && kept.has(slot.spineIndex);
      if (slot.spineIndex !== null && !duplicate) kept.add(slot.spineIndex);
      if (
        duplicate ||
        slot.spineIndex === null ||
        !wantedPaths.has(slot.spineIndex) ||
        slot.path !== wantedPaths.get(slot.spineIndex) ||
        !sameRenderingSettings(slot.renderSettings, latestRenderSettingsRef.current) ||
        fillStale(slot)
      ) {
        disposeSpareSlot(slot);
      }
    }

    const usedFrames = new Set<LiveReaderFrame>([
      active.frame as LiveReaderFrame,
      ...spareSlotsRef.current.map((slot) => slot.frame as LiveReaderFrame),
    ]);
    // 一次只启动一个后台完整排版任务；优先补齐近邻。
    for (const index of wantedIndices) {
      if (index === active.spineIndex) continue;
      const path = wantedPaths.get(index);
      if (!path) continue;
      if (failedPreloadsRef.current.has(`${index}:${path}`)) continue;
      const existing = spareSlotsRef.current.find((slot) => slot.spineIndex === index && slot.path === path);
      if (existing?.paginator) {
        // display-ready 才是可提升边界；同一签名下不因回调再次触发而重启。
        if (existing.ready && existing.paginator.isDisplayReady) continue;
        if (existing.state.status === "loading" || existing.state.status === "measuring") return;
        disposeSpareSlot(existing);
        usedFrames.delete(existing.frame as LiveReaderFrame);
      }

      if (spareSlotsRef.current.length >= LIVE_READER_FRAMES.length - 1) break;
      const frame = LIVE_READER_FRAMES.find((candidate) => !usedFrames.has(candidate));
      if (!frame) break;
      const iframe = iframeForFrame(frame);
      if (!iframe) break;
      const slot: PaginatorSlot = {
        frame,
        iframe,
        paginator: null,
        path,
        spineIndex: index,
        state: { status: "loading" },
        ready: false,
        generation: ++preloadGenerationRef.current,
        renderSettings: latestRenderSettingsRef.current,
        restoreTicket: null,
      };
      spareSlotsRef.current.push(slot);
      usedFrames.add(frame);
      preloadInFlightSlotRef.current = slot;
      const paginator = buildPaginator(slot);
      const generation = slot.generation;
      const chapterFill = fillOptionFor(index);
      slot.fillAsked = chapterFill?.leadingBlankColumns;
      void paginator
        .loadAndWaitForDisplay(path, { resetPage: true, chapterFill })
        .then((ready) => {
          if (preloadInFlightSlotRef.current === slot) preloadInFlightSlotRef.current = null;
          if (
            !spareSlotsRef.current.includes(slot) ||
            slot.generation !== generation ||
            slot.paginator !== paginator
          ) {
            return;
          }
          slot.state = paginator.getStateSnapshot();
          slot.ready = ready && paginator.isDisplayReady;
          if (!slot.ready) {
            failedPreloadsRef.current.add(`${index}:${path}`);
            disposeSpareSlot(slot);
          } else {
            const latest = latestRenderSettingsRef.current;
            if (slot.renderSettings.theme !== latest.theme && sameLayoutSettings(slot.renderSettings, latest)) {
              if (paginator.updateTheme(latest.theme)) {
                slot.renderSettings = { ...slot.renderSettings, theme: latest.theme };
              }
            }
            syncJoin();
          }
          scheduleAdjacentPreloadsDebounced(150);
        })
        .catch(() => {
          if (preloadInFlightSlotRef.current === slot) preloadInFlightSlotRef.current = null;
          if (!spareSlotsRef.current.includes(slot)) return;
          failedPreloadsRef.current.add(`${index}:${path}`);
          disposeSpareSlot(slot);
          scheduleAdjacentPreloadsDebounced(150);
        });
      return;
    }

    // 五章活缓存已齐；其余章节按空闲串行预备。
    scheduleFullBookWarmupDebounced(500);
  };

  function scheduleAdjacentPreloadsDebounced(delayMs = 500): void {
    clearPreloadTimer();
    if (backgroundPausedRef.current) return;
    if (!preloadAllowedRef.current || latestRenderSettingsRef.current.readingMode === "scroll") {
      disposeSpareSlots();
      return;
    }
    preloadDebounceTimerRef.current = window.setTimeout(() => {
      preloadDebounceTimerRef.current = null;
      scheduleAdjacentPreloads();
    }, delayMs);
  }

  const clearWarmupTimer = (): void => {
    if (warmupTimerRef.current !== null) {
      window.clearTimeout(warmupTimerRef.current);
      warmupTimerRef.current = null;
    }
  };

  const cancelWarmupIdle = (): void => {
    if (warmupIdleRef.current === null) return;
    if (warmupIdleKindRef.current === "idle") {
      (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(warmupIdleRef.current);
    } else {
      window.clearTimeout(warmupIdleRef.current);
    }
    warmupIdleRef.current = null;
    warmupIdleKindRef.current = null;
  };

  const requestWarmupIdle = (callback: () => void): void => {
    const win = window as Window & {
      requestIdleCallback?: (cb: IdleRequestCallback, opts?: { timeout: number }) => number;
    };
    if (typeof win.requestIdleCallback === "function") {
      warmupIdleKindRef.current = "idle";
      warmupIdleRef.current = win.requestIdleCallback(() => {
        warmupIdleRef.current = null;
        warmupIdleKindRef.current = null;
        callback();
      }, { timeout: 1000 });
      return;
    }
    // 不可用时退化为帧后 0ms 小任务，不用 500ms 假装空闲。
    warmupIdleKindRef.current = "timer";
    warmupIdleRef.current = window.setTimeout(() => {
      warmupIdleRef.current = null;
      warmupIdleKindRef.current = null;
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
      else callback();
    }, 0);
  };

  const disposeWarmupSlot = (): void => {
    const slot = warmupSlotRef.current;
    warmupSlotRef.current = null;
    if (!slot) return;
    slot.paginator?.dispose();
    slot.paginator = null;
    slot.path = null;
    slot.spineIndex = null;
    slot.ready = false;
  };

  const resetFullBookWarmup = (): void => {
    warmupGenerationRef.current += 1;
    failedPreloadsRef.current.clear();
    clearWarmupTimer();
    cancelWarmupIdle();
    warmupPlanRef.current?.interrupt();
    warmupTicketRef.current = null;
    warmupRunningRef.current = false;
    disposeWarmupSlot();
    if (preloadAllowedRef.current && latestRenderSettingsRef.current.readingMode !== "scroll") {
      const plan = new ReadingWarmupPlan();
      plan.reset(linearSpineIndices(book));
      warmupPlanRef.current = plan;
    } else {
      warmupPlanRef.current = null;
    }
  };

  const ensureWarmupPlan = (): ReadingWarmupPlan => {
    if (!warmupPlanRef.current) {
      const plan = new ReadingWarmupPlan();
      plan.reset(linearSpineIndices(book));
      warmupPlanRef.current = plan;
    }
    return warmupPlanRef.current;
  };

  const isForegroundPending = (): boolean => {
    const active = activeSlotRef.current;
    return (
      lastStateRef.current !== "ready" ||
      !active?.ready ||
      active.state.status !== "ready"
    );
  };

  // 滚轮换章静默锁可能因没有后续滚轮事件而长期为 true，不能当成“用户正在输入”；
  // 真正的输入到达会由 pauseBackgroundWarmupForInput 立即取消后台任务并重置空闲窗。
  const isUserBusy = (): boolean => inputPausedRef.current;

  const missingLiveWarmup = (): boolean => {
    const active = activeSlotRef.current;
    if (!active?.paginator || active.spineIndex === null) return false;
    for (const index of liveWindowIndices(active.spineIndex)) {
      if (index === active.spineIndex) continue;
      const path = spineItemPath(book, index);
      if (!path) continue;

      const slot = spareSlotsRef.current.find(
        (candidate) => candidate.spineIndex === index && candidate.path === path,
      );
      if (
        !slot?.ready ||
        !slot.paginator?.isDisplayReady ||
        slot.state.status !== "ready"
      ) {
        // 同一 layout 代次内已失败的章不再反复重试；由全书记录/跳过。
        return !failedPreloadsRef.current.has(`${index}:${path}`);
      }
    }
    return false;
  };

  const residentChapters = (): Set<number> => {
    const resident = new Set<number>();
    const add = (slot: PaginatorSlot | null): void => {
      if (
        slot &&
        slot.spineIndex !== null &&
        slot.ready &&
        slot.paginator?.isDisplayReady &&
        slot.state.status === "ready" &&
        sameRenderingSettings(slot.renderSettings, latestRenderSettingsRef.current)
      ) {
        resident.add(slot.spineIndex);
      }
    };
    add(activeSlotRef.current);
    for (const slot of spareSlotsRef.current) add(slot);
    return resident;
  };

  const resourceOnlyAdjacentChapters = (activeSpineIndex: number): Set<number> => {
    const set = new Set<number>();
    for (const index of liveWindowIndices(activeSpineIndex)) {
      if (index === activeSpineIndex) continue;
      const path = spineItemPath(book, index);
      if (!path) continue;
      if (backgroundPreparation(server.textFor(path)) === "resource-only") {
        set.add(index);
      }
    }
    return set;
  };

  const scheduleFullBookWarmupDebounced = (delayMs = 500): void => {
    clearWarmupTimer();
    if (backgroundPausedRef.current) return;
    if (!preloadAllowedRef.current || latestRenderSettingsRef.current.readingMode === "scroll") {
      resetFullBookWarmup();
      return;
    }
    warmupTimerRef.current = window.setTimeout(() => {
      warmupTimerRef.current = null;
      scheduleFullBookWarmupIdle();
    }, delayMs);
  };

  const scheduleFullBookWarmupIdle = (): void => {
    if (backgroundPausedRef.current) return;
    if (!preloadAllowedRef.current || latestRenderSettingsRef.current.readingMode === "scroll") {
      resetFullBookWarmup();
      return;
    }
    if (warmupRunningRef.current || warmupIdleRef.current !== null) return;
    requestWarmupIdle(() => runNextFullBookWarmup());
  };

  const runNextFullBookWarmup = (): void => {
    if (backgroundPausedRef.current) return;
    if (!preloadAllowedRef.current || latestRenderSettingsRef.current.readingMode === "scroll") {
      resetFullBookWarmup();
      return;
    }
    if (warmupRunningRef.current) return;
    const active = activeSlotRef.current;
    if (
      !active?.paginator ||
      active.spineIndex === null ||
      !active.ready ||
      active.state.status !== "ready" ||
      !sameRenderingSettings(active.renderSettings, latestRenderSettingsRef.current)
    ) {
      return;
    }
    // 五章近邻活缓存优先；没有齐之前不把临时测量 DOM 当远章准备。
    if (missingLiveWarmup()) {
      scheduleAdjacentPreloads();
      return;
    }
    if (runFillMeasurement()) return;
    const plan = ensureWarmupPlan();
    const userBusy = isUserBusy();
    const foregroundPending = isForegroundPending();
    const resourceOnly = resourceOnlyAdjacentChapters(active.spineIndex);
    const ticket = plan.take(
      active.spineIndex,
      residentChapters(),
      userBusy,
      foregroundPending,
      resourceOnly,
    );
    if (!ticket) {
      if (userBusy || foregroundPending) {
        // 输入/前台未稳定时让出空档；稳定后从这里继续，而不是永久停住。
        scheduleFullBookWarmupDebounced(500);
      } else {
        // 没有可派发任务（近邻都是活缓存或剩余章已处理/失败）时释放临时测量槽。
        disposeWarmupSlot();
      }
      return;
    }
    const path = spineItemPath(book, ticket.chapter);
    if (!path) {
      plan.finish(ticket, false);
      scheduleFullBookWarmupDebounced(150);
      return;
    }
    if (failedPreloadsRef.current.has(`${ticket.chapter}:${path}`)) {
      // 近邻完整排版已失败：同一 epoch 不把同一章再送进临时槽。
      plan.finish(ticket, false);
      scheduleFullBookWarmupDebounced(150);
      return;
    }
    // 远章没有页数摘要消费者，不再为了写 Map 启动完整排版；只复用既有
    // ResourceServer 文本缓存做轻量资源准备。用户真正打开时仍走真实
    // display gate 和完整测量，摘要 Map/iframe 数量不再作为 ready 证据。
    const prepared = server.textFor(path) !== undefined;
    plan.finish(ticket, prepared);
    if (preloadAllowedRef.current) {
      scheduleFullBookWarmupDebounced(prepared ? 150 : 500);
    } else {
      resetFullBookWarmup();
    }
  };

  /** 输入/显式导航优先：先停掉尚未发布的临时测量，再让前台继续。普通输入不销毁在途预载目标。 */
  const pauseBackgroundWarmupForInput = (): void => {
    clearPreloadTimer();
    warmupGenerationRef.current += 1;
    clearWarmupTimer();
    cancelWarmupIdle();
    warmupPlanRef.current?.interrupt();
    warmupTicketRef.current = null;
    warmupRunningRef.current = false;
    disposeWarmupSlot();
    if (preloadAllowedRef.current && latestRenderSettingsRef.current.readingMode !== "scroll") {
      scheduleAdjacentPreloadsDebounced(500);
    }
  };

  useEffect(() => {
    const syncBackgroundPreparation = (): void => {
      if (document.visibilityState === "hidden") {
        activeSlotRef.current?.paginator?.setMotionWindowForeground?.(false);
        backgroundPausedRef.current = true;
        clearPreloadTimer();
        const pendingPreload = preloadInFlightSlotRef.current;
        if (pendingPreload) disposeSpareSlot(pendingPreload);
        warmupGenerationRef.current += 1;
        clearWarmupTimer();
        cancelWarmupIdle();
        warmupPlanRef.current?.interrupt();
        warmupTicketRef.current = null;
        warmupRunningRef.current = false;
        disposeWarmupSlot();
        return;
      }
      if (!backgroundPausedRef.current) return;
      backgroundPausedRef.current = false;
      activeSlotRef.current?.paginator?.setMotionWindowForeground?.(true);
      if (preloadAllowedRef.current) scheduleAdjacentPreloadsDebounced(250);
    };
    document.addEventListener("visibilitychange", syncBackgroundPreparation);
    syncBackgroundPreparation();
    return () => document.removeEventListener("visibilitychange", syncBackgroundPreparation);
    // scheduler 是稳定函数声明；preloadAllowedRef 在每次 render 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- A16 章边联动：只在高性能预读下、相邻章已在缓存槽排好时使用 ----
  /** 当前章静止在 direction 一侧的章边，且相邻章的缓存槽可以直接拼上来。 */
  /** 当前章静止在 direction 一侧的章边、可以开始联动（来源另行判断）。 */
  const seamEdgeSlot = (direction: 1 | -1): PaginatorSlot | null => {
    if (resolvedTurnAnimation() !== "slide" || inputPausedRef.current) return null;
    const current = activeSlotRef.current;
    const p = current?.paginator;
    if (!current || !p || !isActiveSlot(current) || current.spineIndex === null || !current.ready ||
      current.state.status !== "ready") return null;
    // 竖排步长与方向另算，第二阶段再接。
    if (p.flowsVertically || !p.pageMotionIdle) return null;
    if (direction === 1 ? p.currentPage < p.pageCount - 1 : p.currentPage > 0) return null;
    return current;
  };

  const seamNeighborSlot = (direction: 1 | -1): PaginatorSlot | null => {
    if (!preloadAllowedRef.current || latestRenderSettingsRef.current.seamlessChapterTurn !== true || props.leafSlot) {
      return null;
    }
    const current = seamEdgeSlot(direction);
    const p = current?.paginator;
    if (!current || !p || current.spineIndex === null) return null;
    const target = nextLinearIndex(book, current.spineIndex, direction);
    if (target < 0 || neighbor(current.spineIndex, direction) !== target) return null;
    if (props.seamTargetEligible && !props.seamTargetEligible(target)) return null;
    const path = spineItemPath(book, target);
    const slot = spareSlotsRef.current.find((candidate) => candidate.spineIndex === target && candidate.path === path);
    const neighborPaginator = slot?.paginator;
    if (!slot || !neighborPaginator || !slot.ready || !neighborPaginator.isDisplayReady ||
      slot.state.status !== "ready" || slot.state.empty || neighborPaginator.flowsVertically) return null;
    const latest = latestRenderSettingsRef.current;
    if (!sameRenderingSettings(slot.renderSettings, latest) || !sameRenderingSettings(current.renderSettings, latest)) {
      return null;
    }
    // 空栏与现在进入它应有的不一致时不能直接接任（升格会失败），走原换章。
    if (!fillMatches(slot)) return null;
    const width = current.iframe.clientWidth;
    if (!(width > 0) || slot.iframe.clientWidth !== width || slot.iframe.clientHeight !== current.iframe.clientHeight) {
      return null;
    }
    return neighborPaginator.pageProgression === p.pageProgression ? slot : null;
  };

  /** 进行中的联动；外层显示层之间的联动由外层结束，这里只认领还没结束的那一个。 */
  const liveSeam = () => {
    const entry = seamRef.current;
    if (entry?.seam.done) seamRef.current = null;
    return seamRef.current;
  };

  /** 撤掉两侧平移与联动标记；借用的槽若没有升格，退回隐藏。迟到的落定回调随会话一起作废。 */
  const abortSeam = (): void => {
    const entry = seamRef.current;
    if (!entry) return;
    seamRef.current = null;
    if (entry.external || !entry.slot) {
      entry.external?.cancel();
      return;
    }
    entry.seam.dispose();
    entry.slot.iframe.style.removeProperty("pointer-events");
    const main = readerContainerRef.current;
    if (main) delete main.dataset.chapterSeam;
    if (activeSlotRef.current !== entry.slot) {
      entry.slot.iframe.style.setProperty("visibility", "hidden", "important");
      entry.slot.iframe.style.zIndex = "0";
    }
  };

  /** 外部意图（显式定位、暂停输入、退出）取消联动与待补的那一次翻页。 */
  const cancelSeam = (): void => {
    const replay = seamReplayRef.current;
    seamReplayRef.current = null;
    if (replay) clearTimeout(replay.timer);
    abortSeam();
    endJoinMotion();
  };

  /**
   * 联动落定。回到当前章：撤掉即可，什么都不提交。停在相邻章：与普通跨章同样的
   * 记账与提交，但没有滑出/滑入（相邻章已在屏上）；spineIndex effect 升格接管。
   */
  const settleSeam = (seam: ChapterSeam, landed: boolean): void => {
    const entry = seamRef.current;
    if (!entry || entry.seam !== seam) return;
    if (!landed) {
      abortSeam();
      // 弹回也是一次落定：重新发布当前状态，后台让路的安静期从真实结束算起；丝带画回来。
      const state = paginatorRef.current?.getStateSnapshot();
      if (state?.status === "ready") onPageStateRef.current(state);
      refreshRibbonsRef.current();
      syncJoin();
      return;
    }
    entry.landed = true;
    triggerChapterTransitionWheelLock();
    lockedReverseDirRef.current = seam.direction === 1 ? -1 : 1;
    reverseLockUntilRef.current = Date.now() + 250;
    turnIntentRef.current.reset();
    if (seam.direction === 1) onRequestChapterRef.current(entry.targetIndex);
    else onRequestChapterRef.current(entry.targetIndex, { atEnd: true });
  };

  /** 在章边开始一次联动：相邻章先摆到旁边一屏，再在同一任务内显示出来。 */
  const startSeam = (direction: 1 | -1): ChapterSeam | null => {
    if (liveSeam()) return null;
    const slot = seamNeighborSlot(direction);
    if (!slot) {
      // 相邻是另一种显示（A13 并排组）或常驻普通视图：由外层把两层一起移动。
      if (!props.externalSeam || !seamEdgeSlot(direction)) return null;
      const external = props.externalSeam(direction);
      if (!external) return null;
      seamRef.current = { seam: external.seam, slot: null, external, targetIndex: external.targetIndex,
        landed: false, drag: null, pending: null };
      markRibbonMotion(1200);
      return external.seam;
    }
    const current = activeSlotRef.current;
    const p = current?.paginator;
    const neighborPaginator = slot?.paginator;
    if (!slot || !current || !p || !neighborPaginator || slot.spineIndex === null) return null;
    // 拼接屏的另一章不跟普通联动走：先撤下（都在视口外），落定后按新位置重挂。
    detachJoin();
    // 下一章从第一屏、上一章从最后一屏拼上来；缓存章停在哪里都先归位（隐藏中，不可见）。
    const edge = direction === 1 ? 0 : Math.max(0, neighborPaginator.pageCount - 1);
    if (neighborPaginator.currentPage !== edge) neighborPaginator.setPage(edge);
    let seam: ChapterSeam | null = null;
    seam = new ChapterSeam({
      direction,
      current: current.iframe,
      neighbor: slot.iframe,
      width: current.iframe.clientWidth,
      progression: p.pageProgression,
      touch: prefersCoarsePointer(),
      onSettled: (landed) => { if (seam) settleSeam(seam, landed); },
      onFault: (error) => {
        console.warn("[reader] chapter seam fault", error);
        if (seamRef.current?.seam === seam) cancelSeam();
      },
    });
    slot.iframe.style.removeProperty("visibility");
    slot.iframe.style.zIndex = "1";
    slot.iframe.style.pointerEvents = "none";
    const main = readerContainerRef.current;
    if (main) main.dataset.chapterSeam = direction === 1 ? "next" : "prev";
    seamRef.current = { seam, slot, external: null, targetIndex: slot.spineIndex, landed: false, drag: null, pending: null };
    markRibbonMotion(1200);
    return seam;
  };

  /** 按键/点按/滚轮在章边：联动到相邻章；不满足条件时返回 false，走原换章过渡。 */
  const startSeamTurn = (direction: 1 | -1): boolean => {
    const seam = startSeam(direction);
    if (!seam) return false;
    if (seam.turn(++motionInputIdRef.current, direction) === "moving") return true;
    // 接到的是别处正在进行的同一次联动：不替它取消，只放手。
    if (seamRef.current?.external && !seamRef.current.external.fresh) seamRef.current = null;
    else abortSeam();
    return false;
  };

  const promotePreparedChapter = (path: string, targetIndex: number, atEnd: boolean): boolean => {
    const current = activeSlotRef.current;
    const next = spareSlotsRef.current.find((slot) => slot.path === path && slot.spineIndex === targetIndex);
    // A13-2：穿过拼接屏落定在这一章，它已停在要显示的那一屏。
    const joinLanded = next !== undefined && joinLandingRef.current === next;
    if (next && next.paginator && sameLayoutSettings(next.renderSettings, latestRenderSettingsRef.current)) {
      if (next.renderSettings.theme !== latestRenderSettingsRef.current.theme) {
        if (next.paginator.updateTheme(latestRenderSettingsRef.current.theme)) {
          next.renderSettings = { ...next.renderSettings, theme: latestRenderSettingsRef.current.theme };
        }
      }
    }
    if (
      !current ||
      !sameRenderingSettings(current.renderSettings, latestRenderSettingsRef.current) ||
      current.spineIndex === null ||
      (targetIndex !== nextLinearIndex(book, current.spineIndex, 1) &&
        targetIndex !== nextLinearIndex(book, current.spineIndex, -1)) ||
      !next ||
      !sameRenderingSettings(next.renderSettings, latestRenderSettingsRef.current) ||
      !next.paginator ||
      next.paginator.getCurrentPath() !== path ||
      !next.ready ||
      !next.paginator.isDisplayReady ||
      next.state.status !== "ready" ||
      // 空栏与现在进入它应有的不一致：按普通加载重排（穿越落定的那一章已在屏上，例外）。
      (!joinLanded && !fillMatches(next))
    ) {
      return false;
    }
    const state = next.paginator.getStateSnapshot();
    if (state.status !== "ready") return false;
    // The old active slot is being demoted to cache; close its transient UI
    // and clear its search highlight while it still owns the active identity.
    current.paginator?.closeForNavigation();
    current.paginator?.clearSearchHighlight();
    current.paginator?.setMotionCompanions?.([]);
    joinLandingRef.current = null;
    spareSlotsRef.current = spareSlotsRef.current.filter((slot) => slot !== next);
    // Retain the old current chapter as the adjacent back/forward cache.  The
    // scheduler below will evict the now-distant spare and warm the new edge.
    spareSlotsRef.current.push(current);
    activeSlotRef.current = next;
    paginatorRef.current = next.paginator;
    activeIframeRef.current = next.iframe;
    next.paginator.setNotes(props.notes);
    autoAdvanceRef.current = false;
    triggerChapterTransitionWheelLock();
    lockedReverseDirRef.current = atEnd ? 1 : -1;
    reverseLockUntilRef.current = Date.now() + 250;
    turnIntentRef.current.reset();
    if (joinLanded) {
      // 停在穿越落定的那一屏。
    } else if (atEnd) {
      if (latestRenderSettingsRef.current.readingMode === "scroll") {
        next.paginator.scrollToEnd();
      } else {
        next.paginator.setPage(Math.max(0, next.paginator.pageCount - 1));
      }
    } else {
      if (latestRenderSettingsRef.current.readingMode === "scroll") {
        next.paginator.scrollToStart();
      } else {
        next.paginator.setPage(0);
      }
    }
    setActiveFrameVisual(next.frame as LiveReaderFrame);
    // A16：联动停在这一章时，它已在屏上的最终位置；同一任务内撤掉平移，不闪旧章。
    const seam = seamRef.current;
    const seamPending = seam?.slot === next ? seam.pending : null;
    if (seam?.slot === next) abortSeam();
    // A13-2：穿越收尾（上一章留作伴随元素）或按新的当前章重挂拼接屏；同一任务内，不闪。
    if (joinMotionRef.current) endJoinMotion();
    else syncJoin();
    if (seamPending !== null) {
      const navigation = chapterNavigationRef.current;
      const timer = setTimeout(() => {
        const replay = seamReplayRef.current;
        if (replay?.timer !== timer) return;
        seamReplayRef.current = null;
        if (activeSlotRef.current === next && chapterNavigationRef.current === navigation) {
          turnPageRef.current(seamPending, "ui");
        }
      }, 0);
      seamReplayRef.current = { timer, slot: next, navigation };
    }
    const promotedState = next.paginator.getStateSnapshot();
    if (promotedState.status !== "ready") return false;
    next.state = promotedState;
    lastStateRef.current = promotedState.status;
    lastReadyEmptyRef.current = promotedState.empty;
    onPageStateRef.current(promotedState);
    refreshRibbonsRef.current();
    // B-151：空章缓存被提升时也要走同一自动前进规则；末章空章才发布 ready。
    if (promotedState.empty && next.spineIndex !== null) {
      const nextIndex = nextLinearIndex(book, next.spineIndex, 1);
      if (nextIndex >= 0) {
        autoAdvanceRef.current = true;
        turnIntentRef.current.markLoading();
        redirectEmptyChapterEntry(nextIndex);
        onRequestChapterRef.current(nextIndex);
        return true;
      }
    }
    publishActiveDisplayReady();
    return true;
  };


  // ---- A13-2 章边拼接屏：精确叶数索引、冻结的读者空栏、拼接显示与穿越 ----
  /** 只在高性能预读 + 连续滑动 + 滑动动画 + 双页分页时启用；其他情况完全按旧显示。 */
  const fillEnabled = (): boolean => {
    const current = latestRenderSettingsRef.current;
    return preloadAllowedRef.current && current.seamlessChapterTurn === true && current.readingMode !== "scroll" &&
      current.columnsPerView === 2 && !book.fixedLayout && !leafSlotRef.current && resolvedTurnAnimation() === "slide";
  };

  const fillIndex = (): ChapterFillIndex | null => {
    if (!fillEnabled()) return null;
    const iframe = activeSlotRef.current?.iframe;
    if (!iframe || !(iframe.clientWidth > 0) || !(iframe.clientHeight > 0)) return null;
    const { theme: _theme, ...layout } = latestRenderSettingsRef.current;
    const key = chapterFillLayoutKey(iframe.clientWidth, iframe.clientHeight, layout, textProjectionVersionRef.current);
    const current = fillRef.current;
    if (current?.book === book && current.index.layoutKey === key) return current.index;
    fillTriedRef.current.clear();
    const index = new ChapterFillIndex(key, chapterFillEntries(book));
    fillRef.current = { book, index };
    return index;
  };

  /** 已排好的槽把精确叶数记进索引；分类未知、未定型或不是带空栏选项加载的都不记。 */
  const recordFill = (index: ChapterFillIndex, slot: PaginatorSlot | null): boolean => {
    const p = slot?.paginator;
    if (!slot || !p || slot.spineIndex === null || !slot.ready || !p.isDisplayReady || !p.chapterFillRequested) return false;
    // 槽已改记新章、分页器仍是旧章内容（导航开始到加载之间）时不能记。
    if (!slot.path || p.getCurrentPath() !== slot.path) return false;
    if (!sameRenderingSettings(slot.renderSettings, latestRenderSettingsRef.current)) return false;
    const kindOf = chapterFillKindRef.current;
    const kind = kindOf ? kindOf(slot.spineIndex) : "ordinary";
    const leaves = kind === undefined ? null : p.contentLeafLayout;
    if (!leaves) return false;
    return index.record(index.layoutKey, slot.spineIndex, {
      contentLeafCount: leaves.contentLeafCount,
      joinable: leaves.joinable && kind === "ordinary",
    });
  };

  const harvestFill = (index: ChapterFillIndex): void => {
    recordFill(index, activeSlotRef.current);
    for (const slot of spareSlotsRef.current) recordFill(index, slot);
  };

  /** 进入这一章时冻结的读者空栏：索引已确定就按它，否则按旧配对（不估算）。不启用时不带选项。 */
  const fillOptionFor = (spineIndex: number): { leadingBlankColumns: 0 | 1 } | undefined => {
    const index = fillIndex();
    if (!index) return undefined;
    harvestFill(index);
    const placement = index.placement(spineIndex);
    return { leadingBlankColumns: placement.known ? placement.leadingBlankColumns : 0 };
  };

  /** 缓存槽的空栏与现在进入它应有的一致（否则不能直接接任，见 fillStale）。 */
  const fillMatches = (slot: PaginatorSlot): boolean => {
    const p = slot.paginator;
    if (!p || slot.spineIndex === null) return false;
    const wanted = fillOptionFor(slot.spineIndex)?.leadingBlankColumns ?? 0;
    return (p.readerLeadingColumns ?? 0) === wanted && (wanted === 0 || p.chapterFillRequested === true);
  };

  /** 缓存槽需要在隐藏中重排：空栏不对，或启用后还不是带空栏选项排的（测不了叶数）。 */
  const fillStale = (slot: PaginatorSlot): boolean => {
    const p = slot.paginator;
    if (!p || !slot.ready || slot.spineIndex === null) return false;
    const motion = joinMotionRef.current;
    if (motion && (motion.owner === slot || motion.follower === slot)) return false;
    if (fillEnabled() && !p.chapterFillRequested) return true;
    if (fillMatches(slot)) return false;
    // 已按应有的空栏排过、分页器仍保留不了（作者版式挡住）：不反复重排，进入时走普通加载。
    return slot.fillAsked !== (fillOptionFor(slot.spineIndex)?.leadingBlankColumns ?? 0);
  };

  /**
   * 按阅读顺序补测还没有精确叶数的章：一次一章，用临时测量槽，测完即释放。与原后台
   * 准备同一空闲队列，输入/前台未稳定时让路，换版式即作废。返回是否接手了这一轮。
   */
  const runFillMeasurement = (): boolean => {
    const index = fillIndex();
    const iframe = warmupIframeRef.current;
    if (!index || !iframe || isUserBusy() || isForegroundPending() || server.mediaCacheBudgetExceeded) return false;
    harvestFill(index);
    // 已排好的缓存章只差分类时，补分类后直接记它，不再另排一次。
    const kindOf = chapterFillKindRef.current;
    const residentSlot = (chapter: number): PaginatorSlot | null =>
      [activeSlotRef.current, ...spareSlotsRef.current].find((slot) => slot?.spineIndex === chapter) ?? null;
    const resident = residentChapters();
    const tried = fillTriedRef.current;
    const chapter = index.nextUnmeasured((candidate) => tried.has(candidate) ||
      (resident.has(candidate) && (!kindOf || kindOf(candidate) !== undefined)));
    if (chapter === null) return false;
    const path = spineItemPath(book, chapter);
    if (!path) {
      tried.add(chapter);
      return false;
    }
    const generation = warmupGenerationRef.current;
    const superseded = (): boolean => generation !== warmupGenerationRef.current;
    const controller = new AbortController();
    warmupRunningRef.current = true;
    void (async () => {
      let measured = false;
      try {
        const kindOf = chapterFillKindRef.current;
        let kind = kindOf ? kindOf(chapter) : "ordinary";
        if (kind === undefined && resolveChapterFillKindRef.current) {
          kind = await resolveChapterFillKindRef.current(chapter, controller.signal);
        }
        if (superseded()) return;
        if (kind === "isolated") {
          measured = index.record(index.layoutKey, chapter, { contentLeafCount: 0, joinable: false });
          return;
        }
        if (kind !== "ordinary") return;
        const cached = residentSlot(chapter);
        if (cached && recordFill(index, cached)) {
          measured = true;
          return;
        }
        disposeWarmupSlot();
        const slot: PaginatorSlot = {
          frame: "warmup",
          iframe,
          paginator: null,
          path,
          spineIndex: chapter,
          state: { status: "loading" },
          ready: false,
          generation: 0,
          renderSettings: latestRenderSettingsRef.current,
          restoreTicket: null,
        };
        warmupSlotRef.current = slot;
        const paginator = buildPaginator(slot);
        const ready = await paginator.loadAndWaitForDisplay(path, { resetPage: true, chapterFill: { leadingBlankColumns: 0 } });
        if (superseded() || warmupSlotRef.current !== slot) return;
        let leaves = ready && paginator.isDisplayReady ? paginator.contentLeafLayout : null;
        if (ready && !leaves) {
          // 字体/图片还在定型：稍等一次再读；仍不行就留给之后自然打开时补。
          await new Promise((resolve) => setTimeout(resolve, 600));
          if (superseded() || warmupSlotRef.current !== slot) return;
          leaves = paginator.contentLeafLayout;
        }
        if (leaves) {
          measured = index.record(index.layoutKey, chapter, {
            contentLeafCount: leaves.contentLeafCount,
            joinable: leaves.joinable,
          });
        }
      } catch {
        // 分类或加载失败：当作没测到。
      } finally {
        controller.abort();
        if (!superseded()) {
          if (!measured) tried.add(chapter);
          disposeWarmupSlot();
          warmupRunningRef.current = false;
          // 新的精确叶数可能让缓存章需要按新空栏重排，或让章边可以拼接。
          scheduleAdjacentPreloadsDebounced(150);
        }
      }
    })();
    return true;
  };

  const joinLeaves = (slot: PaginatorSlot): JoinLeaves | null => {
    const p = slot.paginator;
    if (!p || !slot.ready || !p.isDisplayReady || slot.state.status !== "ready" || slot.state.empty ||
      !p.chapterFillRequested || p.flowsVertically) return null;
    const leaves = p.contentLeafLayout;
    return leaves && {
      leading: leaves.leadingBlankColumns,
      contentLeafCount: leaves.contentLeafCount,
      joinable: leaves.joinable,
      pageCount: p.pageCount,
    };
  };

  /** 当前章与 direction 一侧的缓存章能否在章边拼成一屏（按两章实际排出的结果，不按索引推测）。 */
  const joinNeighbor = (direction: 1 | -1): JoinAttachment | null => {
    if (!fillEnabled()) return null;
    const current = activeSlotRef.current;
    const p = current?.paginator;
    if (!current || !p || !isActiveSlot(current) || current.spineIndex === null) return null;
    const target = nextLinearIndex(book, current.spineIndex, direction);
    if (target < 0 || neighbor(current.spineIndex, direction) !== target) return null;
    const kindOf = chapterFillKindRef.current;
    if (kindOf && (kindOf(target) !== "ordinary" || kindOf(current.spineIndex) !== "ordinary")) return null;
    const path = spineItemPath(book, target);
    const slot = spareSlotsRef.current.find((candidate) => candidate.spineIndex === target && candidate.path === path);
    const neighborPaginator = slot?.paginator;
    if (!slot || !neighborPaginator) return null;
    const latest = latestRenderSettingsRef.current;
    if (!sameRenderingSettings(slot.renderSettings, latest) || !sameRenderingSettings(current.renderSettings, latest)) return null;
    if (slot.iframe.clientWidth !== current.iframe.clientWidth || slot.iframe.clientHeight !== current.iframe.clientHeight) return null;
    if (neighborPaginator.pageProgression !== p.pageProgression) return null;
    const mine = joinLeaves(current);
    const theirs = joinLeaves(slot);
    if (!mine || !theirs) return null;
    if (!canJoinChapters(direction === 1 ? mine : theirs, direction === 1 ? theirs : mine)) return null;
    return {
      slot,
      side: direction,
      joinPage: direction === 1 ? mine.pageCount - 1 : 0,
      neighborPage: direction === 1 ? 0 : theirs.pageCount - 1,
    };
  };

  /** 只露出 lane 那一页的半边，叠在上面（下一章露第二页，上一章露第一页）。 */
  const styleJoinHalf = (slot: PaginatorSlot, lane: 0 | 1): void => {
    const iframe = slot.iframe;
    const width = iframe.clientWidth;
    const split = slot.paginator?.spreadLaneSplitX() ?? width / 2;
    iframe.dataset.joinCompanion = "true";
    iframe.style.removeProperty("visibility");
    iframe.style.setProperty("clip-path", joinLaneClip(lane, split, width, slot.paginator?.pageProgression ?? "ltr"));
  };

  const releaseJoinFrame = (slot: PaginatorSlot): void => {
    const iframe = slot.iframe;
    delete iframe.dataset.joinCompanion;
    delete iframe.dataset.joinOwner;
    iframe.style.removeProperty("clip-path");
    iframe.style.removeProperty("transform");
    if (activeSlotRef.current !== slot) {
      iframe.style.setProperty("visibility", "hidden", "important");
      iframe.style.zIndex = "0";
    }
  };

  const setJoinMarker = (on: boolean): void => {
    const main = readerContainerRef.current;
    if (!main) return;
    if (on) main.dataset.chapterJoin = "true";
    else delete main.dataset.chapterJoin;
  };

  /**
   * 按当前章停的位置挂上/撤下拼接屏两侧的另一章（离拼接屏两屏以内才挂，视口外的
   * 跟着本章内容移动）。运动途中不动，落定后会再调用。
   */
  const syncJoin = (): void => {
    if (joinMotionRef.current) return;
    const p = paginatorRef.current;
    if (p && !p.pageMotionIdle) return;
    const wanted: JoinAttachment[] = [];
    if (p && !liveSeam()) {
      for (const direction of [1, -1] as const) {
        const join = joinNeighbor(direction);
        if (join && Math.abs(p.currentPage - join.joinPage) <= 2) wanted.push(join);
      }
    }
    const previous = joinAttachRef.current;
    if (!previous.length && !wanted.length) return;
    for (const old of previous) {
      if (!wanted.some((join) => join.slot === old.slot)) releaseJoinFrame(old.slot);
    }
    joinAttachRef.current = wanted;
    for (const join of wanted) {
      const neighborPaginator = join.slot.paginator;
      if (neighborPaginator && neighborPaginator.currentPage !== join.neighborPage) neighborPaginator.setPage(join.neighborPage);
      styleJoinHalf(join.slot, join.side === 1 ? 1 : 0);
    }
    setJoinMarker(wanted.length > 0);
    p?.setMotionCompanions?.(wanted.map((join) => ({ element: join.slot.iframe, page: join.joinPage })));
  };

  const dropJoinSlot = (slot: PaginatorSlot): void => {
    if (!joinAttachRef.current.some((join) => join.slot === slot)) return;
    releaseJoinFrame(slot);
    joinAttachRef.current = joinAttachRef.current.filter((join) => join.slot !== slot);
    paginatorRef.current?.setMotionCompanions?.(joinAttachRef.current.map((join) => ({ element: join.slot.iframe, page: join.joinPage })));
    setJoinMarker(joinAttachRef.current.length > 0);
  };

  /** 撤下全部拼接（导航、普通联动、重排前）。 */
  const detachJoin = (): void => {
    endJoinMotion();
    for (const join of joinAttachRef.current) releaseJoinFrame(join.slot);
    const hadAttachments = joinAttachRef.current.length > 0;
    joinAttachRef.current = [];
    if (hadAttachments) paginatorRef.current?.setMotionCompanions?.([]);
    setJoinMarker(false);
  };

  /** 停在拼接屏、向另一章翻：另一章接过运动，当前章只露出自己那半边，作为伴随元素一起移动。 */
  const startJoinMotion = (direction: 1 | -1): NonNullable<typeof joinMotionRef.current> | null => {
    const live = joinMotionRef.current;
    if (live) return live.landed ? null : live;
    if (liveSeam()) return null;
    const active = activeSlotRef.current;
    const p = active?.paginator;
    const join = joinAttachRef.current.find((item) => item.side === direction);
    const owner = join?.slot.paginator;
    if (!active || !p || !join || !owner || join.slot.spineIndex === null || !p.pageMotionIdle ||
      p.currentPage !== join.joinPage || owner.currentPage !== join.neighborPage) return null;
    owner.setMotionWindowForeground(true);
    if (!owner.pageMotionAvailable) {
      owner.setMotionWindowForeground(false);
      return null;
    }
    p.setMotionCompanions?.([]);
    const ownerFrame = join.slot.iframe;
    delete ownerFrame.dataset.joinCompanion;
    ownerFrame.dataset.joinOwner = "true";
    ownerFrame.style.removeProperty("clip-path");
    ownerFrame.style.removeProperty("transform");
    styleJoinHalf(active, direction === 1 ? 0 : 1);
    owner.setMotionCompanions([{ element: active.iframe, page: join.neighborPage }]);
    joinMotionRef.current = {
      owner: join.slot,
      follower: active,
      direction,
      homePage: join.neighborPage,
      targetIndex: join.slot.spineIndex,
      drag: null,
      landed: false,
    };
    markRibbonMotion(1200);
    return joinMotionRef.current;
  };

  const startJoinTurn = (direction: 1 | -1): boolean => {
    const motion = startJoinMotion(direction);
    const owner = motion?.owner.paginator;
    if (!motion || !owner) return false;
    if (owner.motionTurn(direction, ++motionInputIdRef.current, true) === "moving") return true;
    endJoinMotion();
    return false;
  };

  /** 穿越落定。回到拼接屏：当前章不变；停在另一章：提交换章，升格时保留它的这一屏。 */
  const settleJoin = (page: number): void => {
    const motion = joinMotionRef.current;
    if (!motion || motion.landed) return;
    if (page === motion.homePage) {
      endJoinMotion();
      const state = paginatorRef.current?.getStateSnapshot();
      if (state?.status === "ready") onPageStateRef.current(state);
      refreshRibbonsRef.current();
      return;
    }
    motion.landed = true;
    joinLandingRef.current = motion.owner;
    triggerChapterTransitionWheelLock();
    lockedReverseDirRef.current = motion.direction === 1 ? -1 : 1;
    reverseLockUntilRef.current = Date.now() + 250;
    turnIntentRef.current.reset();
    if (motion.direction === 1) onRequestChapterRef.current(motion.targetIndex);
    else onRequestChapterRef.current(motion.targetIndex, { atEnd: true });
  };

  /**
   * 结束穿越：落定升格后上一章留作伴随元素；没落定或被打断时另一章退回原位。
   * 都在同一任务内按当前位置重挂，不闪。
   */
  const endJoinMotion = (): void => {
    const motion = joinMotionRef.current;
    if (!motion) return;
    joinMotionRef.current = null;
    if (joinLandingRef.current === motion.owner) joinLandingRef.current = null;
    const owner = motion.owner.paginator;
    owner?.setMotionCompanions([]);
    if (activeSlotRef.current !== motion.owner && owner) {
      owner.setMotionWindowForeground(false);
      if (owner.currentPage !== motion.homePage) owner.setPage(motion.homePage);
    }
    releaseJoinFrame(motion.owner);
    releaseJoinFrame(motion.follower);
    // 其余挂着的（另一侧的伴随章）交给 syncJoin 按新位置决定留下还是撤下。
    syncJoin();
  };


  // 固定版式：分栏间距为 0（每章整页显示）
  const effSettings = effectiveReaderSettings(settings, book.fixedLayout);
  // 渲染层设置：把用户上传字体的 blob URL 注入分页器/sanitize
  const renderSettings: ReaderSettings = { ...effSettings, customFonts: props.userFonts };
  const settingsReloadDebouncerRef = useRef<ReturnType<typeof createSettingsReloadDebouncer> | null>(null);
  if (!settingsReloadDebouncerRef.current) {
    settingsReloadDebouncerRef.current = createSettingsReloadDebouncer(150);
  }
  const latestRenderSettingsRef = useRef(renderSettings);
  latestRenderSettingsRef.current = renderSettings;
  const settingsIdentityRef = useRef<{
    settings: ReaderSettings;
    userFonts: ReaderViewProps["userFonts"];
  } | null>(null);

  // 创建分页器（book/server 就绪后；App 端用 key 保证 book 变化时整体重建）
  useEffect(() => {
    // 同一 ReaderView 实例复用到新 book/server 时，旧 plan 必须换成新书 spine。
    resetFullBookWarmup();
    const iframe = primaryIframeRef.current;
    if (!iframe) return;
    const slot: PaginatorSlot = {
      frame: "primary",
      iframe,
      paginator: null,
      path: null,
      spineIndex: null,
      state: { status: "loading" },
      ready: false,
      generation: 0,
      renderSettings: latestRenderSettingsRef.current,
      restoreTicket: null,
    };
    const p = buildPaginator(slot);
    activeSlotRef.current = slot;
    activeIframeRef.current = iframe;
    paginatorRef.current = p;
    setActiveFrameVisual("primary");
    return () => {
      cancelSeam();
      layoutCoordinatorRef.current.invalidate();
      resetFullBookWarmup();
      clearPreloadTimer();
      settingsReloadDebouncerRef.current?.cancel();
      turnIntentRef.current.reset();
      outerWheelRef.current.reset();
      const owned = new Set<ChapterPaginator>();
      if (slot.paginator) owned.add(slot.paginator);
      if (activeSlotRef.current?.paginator) owned.add(activeSlotRef.current.paginator);
      for (const spare of spareSlotsRef.current) {
        if (spare.paginator) owned.add(spare.paginator);
      }
      for (const paginator of owned) paginator.dispose();
      spareSlotsRef.current = [];
      slot.paginator = null;
      paginatorRef.current = null;
      activeSlotRef.current = null;
      activeIframeRef.current = null;
      // ResourceServer 与 Book 的生命周期由 App 会话管理；ReaderView 仅负责分页器 dispose
      // 不在组件内部 cleanup 中销毁共享 server/book，避免 StrictMode 双重挂载或重绘时资源被提前释放。
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Slot lifetime follows book/server; navigation and settings have separate effects below.
  }, [book, server]);

  useEffect(() => {
    paginatorRef.current?.setNotes(props.notes);
  }, [props.notes]);

  // 章节切换 → 加载
  useEffect(() => {
    // A chapter/anchor transition owns the next load.  A settings timer from
    // the previous chapter must not start a second load after this effect.
    pauseBackgroundWarmupForInput();
    clearPreloadTimer();
    settingsReloadDebouncerRef.current?.cancel();
    settingsIdentityRef.current = { settings, userFonts: props.userFonts };
    if (!paginatorRef.current) return;
    autoAdvanceRef.current = false;
    const path = spineItemPath(book, spineIndex);
    if (!path) {
      turnIntentRef.current.reset();
      props.onPageState({ status: "error", message: uiText("readerMisc.chapter.missing") });
      return;
    }
    // A16 第二阶段：外层把已排好、正显示这一章的本视图接为当前显示（落定在这一层）。
    // 这一次换章请求已经由画面满足：只认领导航编号并对外发布状态，不重新加载或移动。
    const adopted = props.adoptedNavigation;
    const shown = activeSlotRef.current;
    if (adopted && adopted.spineIndex === spineIndex && adopted.anchorNonce === props.anchorNonce &&
      adopted.startNonce === props.startAtEnd.nonce && shown?.paginator && shown.spineIndex === spineIndex &&
      shown.path === path && shown.ready && shown.state.status === "ready" && !props.preciseTarget) {
      lastHandledStartAtEndNonceRef.current = props.startAtEnd.nonce;
      handledAnchorNonceRef.current = props.anchorNonce;
      turnIntentRef.current.reset();
      const state = shown.paginator.getStateSnapshot();
      if (state.status === "ready") {
        shown.state = state;
        lastStateRef.current = state.status;
        onPageStateRef.current(state);
        props.onFlowProgression?.(shown.paginator.pageProgression);
      }
      refreshRibbonsRef.current();
      publishActiveDisplayReady();
      return;
    }
    const navigation = chapterNavigationRef.current;
    let abandoned = false;
    const isCurrentNavigation = (): boolean => !abandoned && navigation === chapterNavigationRef.current;
    void (async () => {
      // 跨章/兼容重载是显式章节跳转：回到开头或页内锚点，
      // 而不是沿用旧页号与旧阅读锚点。回翻上一章时把 atEnd 交给 paginator：
      // 由它“翻到最后一页后再显示”，避免先闪第一页。
      const isNewRequest = props.startAtEnd.nonce !== lastHandledStartAtEndNonceRef.current;
      lastHandledStartAtEndNonceRef.current = props.startAtEnd.nonce;
      const startAtEnd = isNewRequest ? props.startAtEnd.atEnd : false;
      const explicitNavigation = handledAnchorNonceRef.current !== props.anchorNonce;
      handledAnchorNonceRef.current = props.anchorNonce;
      if (explicitNavigation) {
        lockedReverseDirRef.current = 0;
        reverseLockUntilRef.current = 0;
      }
      triggerChapterTransitionWheelLock();
      outerWheelRef.current.reset();
      turnIntentRef.current.reset();
      layoutCoordinatorRef.current.invalidate();
      const preciseTarget = props.preciseTarget && props.preciseTarget.chapterPath === path
        ? props.preciseTarget
        : null;
      // Promotion intentionally happens in this effect, after React has
      // committed the new spineIndex.  This keeps App's synchronous refs and
      // progress writer on the promoted chapter before ready is published.
      // Exact targets use the normal load path so resolution/highlight occur
      // inside the display gate instead of being applied to a visible cache.
      const seam = seamRef.current;
      if (seam && (!seam.landed || seam.targetIndex !== spineIndex || preciseTarget || explicitNavigation)) abortSeam();
      const joinMotion = joinMotionRef.current;
      if (joinMotion && (!joinMotion.landed || joinMotion.targetIndex !== spineIndex || preciseTarget || explicitNavigation)) {
        endJoinMotion();
      }
      if (!preciseTarget && !explicitNavigation) {
        if (promotePreparedChapter(path, spineIndex, startAtEnd)) return;
        const inFlight = spareSlotsRef.current.find(
          (slot) => slot.path === path && slot.spineIndex === spineIndex && slot.paginator
        );
        if (
          inFlight &&
          inFlight.paginator &&
          sameLayoutSettings(inFlight.renderSettings, latestRenderSettingsRef.current)
        ) {
          if (inFlight.renderSettings.theme !== latestRenderSettingsRef.current.theme) {
            if (inFlight.paginator.updateTheme(latestRenderSettingsRef.current.theme)) {
              inFlight.renderSettings = { ...inFlight.renderSettings, theme: latestRenderSettingsRef.current.theme };
            }
          }
          const ready = await inFlight.paginator.waitForDisplayReady();
          if (!isCurrentNavigation()) return;
          if (ready && activeSlotRef.current?.spineIndex !== spineIndex) {
            if (promotePreparedChapter(path, spineIndex, startAtEnd)) return;
          }
        }
      }
      if (!isCurrentNavigation()) return;
      // 没能升格（缓存失效等）：撤掉联动再走普通加载，不把旧章留在平移位置。
      abortSeam();
      detachJoin();
      const activeSlot = activeSlotRef.current;
      const p = activeSlot?.paginator;
      if (!activeSlot || !p) return;
      const oldIndex = activeSlot.spineIndex;
      const settingsChanged = !sameRenderingSettings(activeSlot.renderSettings, latestRenderSettingsRef.current);
      // 先按索引冻结这一章的空栏（索引收录当前各槽时，当前槽仍是旧章）。
      const chapterFill = fillOptionFor(spineIndex);
      activeSlot.fillAsked = chapterFill?.leadingBlankColumns;
      activeSlot.path = path;
      activeSlot.spineIndex = spineIndex;
      activeSlot.renderSettings = latestRenderSettingsRef.current;
      activeSlot.restoreTicket = props.restoreTicket ?? null;
      // Retain valid cached slots in the new live window; only evict distant or stale slots.
      if (settingsChanged) {
        disposeSpareSlots();
      } else if (oldIndex !== spineIndex) {
        const nextLiveWindow = liveWindowIndices(spineIndex);
        for (const slot of [...spareSlotsRef.current]) {
          if (
            slot.spineIndex === null ||
            !nextLiveWindow.includes(slot.spineIndex) ||
            !sameRenderingSettings(slot.renderSettings, latestRenderSettingsRef.current)
          ) {
            disposeSpareSlot(slot);
          }
        }
      }
      turnIntentRef.current.reset();
      p.resetWheelAccumulator?.();
      // Text/media targets are modern semantic identities: a failed resolve
      // must show the chapter start without consuming the legacy page fallback.
      // Legacy index-only anchors and explicit chapter starts keep old behavior.
      const hasModernSemanticInitial = Boolean(
        props.initialAnchor &&
          (props.initialAnchor.anchorTextOffset !== null ||
            props.initialAnchor.anchorTextSnippet !== null ||
            props.initialAnchor.mediaAnchor),
      );
      await p.load(path, {
        settings: latestRenderSettingsRef.current,
        chapterFill,
        hasNextChapter: neighbor(spineIndex, 1) >= 0,
        hasPrevChapter: neighbor(spineIndex, -1) >= 0,
        anchor: props.anchor,
        resetPage: true,
        startAtEnd,
        readingAnchor: props.initialAnchor,
        fallbackPage: preciseTarget || hasModernSemanticInitial ? null : (props.initialPage ?? null),
        reportRestore: !book.fixedLayout && !preciseTarget,
        restoreTicket: props.restoreTicket ?? null,
        preciseNavigation: preciseTarget
          ? {
              requestId: preciseTarget.requestId,
              kind: preciseTarget.kind,
              textHits: preciseTarget.textHits,
              occurrence: preciseTarget.occurrence,
              displayTarget: preciseTarget.displayTarget,
            }
          : null,
      });
      if (isCurrentNavigation() && activeSlotRef.current === activeSlot && paginatorRef.current === p) {
        const latest = latestRenderSettingsRef.current;
        if (activeSlotRef.current.renderSettings.theme !== latest.theme && sameLayoutSettings(activeSlotRef.current.renderSettings, latest)) {
          if (p.updateTheme(latest.theme)) {
            activeSlotRef.current.renderSettings = { ...activeSlotRef.current.renderSettings, theme: latest.theme };
            const surface = activeIframeRef.current;
            paintHandleRef.current?.setSurfaceBackground(surface ? readerSurfaceBackground(surface) : null);
          }
        }
      }
    })();
    return () => { abandoned = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- A navigation owns this load; settings updates are handled by the reload transaction.
  }, [book, spineIndex, props.anchorNonce, props.startAtEnd.nonce]);

  // 纯主题原位提交：活跃槽位与所有备用槽位换色并同步滤镜背景。effect 与
  // ReaderHandle.applyTheme（主题过渡回调内同步提交）共用；updateTheme 同主题不重做。
  const applyThemeInPlaceRef = useRef<(theme: ReaderSettings["theme"]) => void>(() => {});
  applyThemeInPlaceRef.current = (theme) => {
    for (const slot of [activeSlotRef.current, ...spareSlotsRef.current]) {
      if (slot?.paginator?.updateTheme(theme)) {
        slot.renderSettings = { ...slot.renderSettings, theme };
      }
    }
    const surface = activeIframeRef.current;
    paintHandleRef.current?.setSurfaceBackground(surface ? readerSurfaceBackground(surface) : null);
  };

  // 设置变更 → 分层处理：
  // 1. 纯主题变更：原位更新当前活跃槽位与所有备用槽位样式，同步滤镜背景；不重排、不销毁槽位、不丢弃运动窗口
  // 2. 几何排版变更：取消旧近邻缓存并进入防抖重载事务（阅读位置由内容锚点保留）
  useEffect(() => {
    const previous = settingsIdentityRef.current;
    if (!previous) {
      settingsIdentityRef.current = { settings, userFonts: props.userFonts };
      return;
    }
    const prevEff = effectiveReaderSettings(previous.settings, book.fixedLayout);
    const changeType = classifySettingsChange(
      prevEff,
      effSettings,
      previous.userFonts,
      props.userFonts,
    );

    if (changeType === "none") {
      if (preloadAllowedRef.current) scheduleAdjacentPreloads();
      else {
        resetFullBookWarmup();
        disposeSpareSlots();
      }
      settingsIdentityRef.current = { settings, userFonts: props.userFonts };
      return;
    }

    if (changeType === "theme-only") {
      settingsIdentityRef.current = { settings, userFonts: props.userFonts };
      applyThemeInPlaceRef.current(effSettings.theme);
      return;
    }

    // 布局代次变化：取消旧 epoch 的临时测量队列和近邻缓存。
    resetFullBookWarmup();
    disposeSpareSlots();
    settingsIdentityRef.current = { settings, userFonts: props.userFonts };
    const p = paginatorRef.current;
    const active = activeSlotRef.current;
    if (!p || !active || active.paginator !== p) return;

    const epoch = layoutCoordinatorRef.current.requestLayoutReload();
    const targetPath = active.path;
    const targetSpineIndex = active.spineIndex;
    const targetGeneration = active.generation;

    settingsReloadDebouncerRef.current?.schedule(async () => {
      await layoutCoordinatorRef.current.runTransaction({
        epoch,
        slot: active,
        isCurrent: () => {
          const curActive = activeSlotRef.current;
          const curP = paginatorRef.current;
          return Boolean(
            curActive &&
              curP &&
              curActive === active &&
              curP === p &&
              curActive.paginator === p &&
              curActive.path === targetPath &&
              curActive.spineIndex === targetSpineIndex &&
              curActive.generation === targetGeneration
          );
        },
        getDesiredSettings: () => latestRenderSettingsRef.current,
        onSyncTheme: () => {
          const surface = activeIframeRef.current;
          paintHandleRef.current?.setSurfaceBackground(surface ? readerSurfaceBackground(surface) : null);
        },
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reload only for settings/fonts; current paginator and desired settings are read through refs.
  }, [settings, props.userFonts]);

  // T-1 configuration change: dispose neighboring display snapshots and
  // reload the active chapter through the same sampled-anchor transaction.
  const textProjectionVersionRef = useRef<string | null>(null);
  useEffect(() => {
    const preferences = props.textProjectionPreferences ?? DEFAULT_TEXT_PROJECTION_PREFERENCES;
    const version = textProjectionVersion(preferences);
    if (textProjectionVersionRef.current === null) {
      textProjectionVersionRef.current = version;
      const p = paginatorRef.current;
      p?.setTextProjectionPreferences?.(preferences, props.textProjection ?? null);
      return;
    }
    if (textProjectionVersionRef.current === version) return;
    textProjectionVersionRef.current = version;
    resetFullBookWarmup();
    disposeSpareSlots();
    const p = paginatorRef.current;
    if (!p) return;
    p.setTextProjectionPreferences?.(preferences, props.textProjection ?? null);
    void p.reloadWithTextProjection?.(preferences, undefined, props.textProjection ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Projection changes invalidate current/spare paginator state; unrelated renders must not reload it.
  }, [props.textProjectionPreferences, props.textProjection]);

  const visualPreferences = props.visualPreferences ?? DEFAULT_VISUAL_PREFERENCES;
  const visualPreferencesRef = useRef(visualPreferences);
  visualPreferencesRef.current = visualPreferences;
  const compareOriginalRef = useRef(props.compareOriginal === true);
  compareOriginalRef.current = props.compareOriginal === true;

  useEffect(() => {
    const surface = activeIframeRef.current;
    const host = visualOverlayRef.current;
    if (!surface || !host) return;
    const handle = attachReaderPaint(
      surface,
      host,
      visualPreferencesRef.current,
      readerSurfaceBackground(surface),
    );
    paintHandleRef.current = handle;
    handle.update(visualPreferencesRef.current, compareOriginalRef.current);
    return () => {
      handle.dispose();
      if (paintHandleRef.current === handle) paintHandleRef.current = null;
    };
    // Reattach only when the visible active iframe changes; slider and theme updates use the second effect.
  }, [activeFrame, book, settings.readingMode]);

  useEffect(() => {
    paintHandleRef.current?.update(visualPreferences, props.compareOriginal === true);
    const surface = activeIframeRef.current;
    paintHandleRef.current?.setSurfaceBackground(surface ? readerSurfaceBackground(surface) : null);
  }, [visualPreferences, props.compareOriginal, settings.theme]);

  // The setting is deliberately a scheduler toggle: it must not reload the
  // active chapter, but enabling it after a ready chapter should start one
  // lazy secondary paginator once the second iframe is committed.
  useEffect(() => {
    if (preloadAllowedRef.current) scheduleAdjacentPreloads();
    else {
      resetFullBookWarmup();
      disposeSpareSlots();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Scheduler helpers use ref-owned slots; only preload eligibility or frame changes restart preparation.
  }, [settings.preloadNextChapter, book.fixedLayout, settings.readingMode, activeFrame]);

  // 尺寸变化 → 重排（左右拉伸窗口等场景）。
  // 用 debounce：拉伸过程中 ResizeObserver 持续触发，只重置定时器、不做重排；
  // 停止 250ms 后才重排一次。浏览器窗口边框拖动没有 mouseup 事件，
  // 静默期就是"确认拉伸结束"的信号。
  // 关键：重排时不重新捕获锚点——此时用上一次稳定状态（翻页/上次重排）
  // 存下的锚点，保证正在读的内容在拉伸后仍回到页面中部。
  useEffect(() => {
    // Observe the stable reader viewport rather than whichever iframe is
    // currently active. Promoting a prepared chapter must not look like a
    // resize and discard the previous-chapter cache we just retained.
    const el = readerContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      resetFullBookWarmup();
      disposeSpareSlots();
      timer = window.setTimeout(() => {
        paginatorRef.current?.reflow();
        if (preloadAllowedRef.current) scheduleAdjacentPreloadsDebounced(250);
      }, 250);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [book.fixedLayout, settings.preloadNextChapter]);

  // 翻页逻辑（滚轮与按钮/键盘共用）
  const turnPageRef = useRef<(dir: 1 | -1, source?: "wheel" | "key" | "ui") => void>(() => {});
  const tapRouting = useReaderTapRouting();
  const turnOwner = useContext(ReaderTurnOwnerContext);
  const routeTap = (clientX: number, clientY?: number) => {
    const hostLeft = tapRouting?.hostLeft();
    const hostTop = tapRouting?.hostTop?.();
    return tapRouting && hostLeft !== null && hostLeft !== undefined
      ? routeReaderTap(tapRouting, hostLeft, clientX,
        clientY !== undefined && hostTop !== null && hostTop !== undefined ? { hostTop, clientY } : undefined)
      : { kind: "center" } as const;
  };
  // 一次正文点击只走这一处：左右区翻页（反馈归物理侧），中间交给宿主（手机呼出菜单，PC 不动作）。
  const plainTapRef = useRef<(tap: PlainTapInfo) => void>(() => {});
  plainTapRef.current = (tap) => {
    const route = routeTap(tap.clientX, tap.clientY);
    if (route.kind === "bookmark") {
      if (!props.onBookmarkCornerTap?.(route.side)) props.onPlainTap?.();
    } else if (route.kind === "turn" && tapRouting) {
      tapRouting.feedback.hold(edgeFeedbackKeyOf(route.side));
      if (turnOwner) turnOwner(route.direction);
      else turnPageRef.current(route.direction);
    } else if (route.kind === "center") {
      props.onPlainTap?.();
    }
  };
  const claimsRepeatTapRef = useRef<(point: PlainTapPoint) => boolean>(() => false);
  claimsRepeatTapRef.current = (point) => routeTap(point.clientX, point.clientY).kind === "turn";
  turnPageRef.current = (dir, source) => {
    pauseBackgroundWarmupForInput();
    const p = paginatorRef.current;
    if (!p) return;
    if (source === "wheel") {
      if (isWheelGestureSuppressed()) return;
      if (dir === lockedReverseDirRef.current && Date.now() < reverseLockUntilRef.current) return;
    }
    // 页数未知时不执行，但保留最后一个方向；display-ready 后最多消费一次。
    const immediate = turnIntentRef.current.request(dir);
    if (immediate === null) return;
    if (latestRenderSettingsRef.current.readingMode === "scroll") {
      // 滚动模式：命令含义是移动视口约 0.9 屏；只有真实边界才换章。
      // 不用虚拟 currentPage 判断章尾，也不把惯性滚动变成连续切章。
      if (p.scrollByViewport(immediate)) return;
      if (lastStateRef.current === "loading" || lastStateRef.current === "measuring") return;
      // 反向回弹保护（单向锁 250ms）
      if (immediate === lockedReverseDirRef.current && Date.now() < reverseLockUntilRef.current) return;
      // 同向连续换章微防抖（150ms）
      if (Date.now() < sameDirThrottleUntilRef.current) return;
      if (immediate === 1) {
        const next = neighbor(spineIndexRef.current, 1);
        if (next >= 0) {
          triggerChapterTransitionWheelLock();
          lockedReverseDirRef.current = -1;
          reverseLockUntilRef.current = Date.now() + 250;
          sameDirThrottleUntilRef.current = Date.now() + 150;
          turnIntentRef.current.markLoading();
          props.onRequestChapter(next);
        }
      } else {
        const prev = neighbor(spineIndexRef.current, -1);
        if (prev >= 0) {
          triggerChapterTransitionWheelLock();
          lockedReverseDirRef.current = 1;
          reverseLockUntilRef.current = Date.now() + 250;
          sameDirThrottleUntilRef.current = Date.now() + 150;
          turnIntentRef.current.markLoading();
          props.onRequestChapter(prev, { atEnd: true });
        }
      }
      return;
    }
    const joinEntry = joinMotionRef.current;
    if (joinEntry) {
      // 穿过拼接屏途中：拖动松手续接同一手势；其他命令交给接过运动的那一章（越界不再连跨）。
      const joinDrag = joinEntry.drag;
      joinEntry.drag = null;
      const owner = joinEntry.owner.paginator;
      if (joinEntry.landed || !owner) return;
      if (joinDrag && owner.motionRelease(joinDrag.ticket, immediate,
        releaseVelocity(joinDrag.samples, performance.now()))) return;
      owner.motionTurn(immediate, ++motionInputIdRef.current, false);
      return;
    }
    const seamEntry = liveSeam();
    if (seamEntry) {
      // 联动进行中：拖动松手续接同一手势；其他命令改变目标或反向，越界的同向命令
      // 预约一次，到新章后执行（不连跨两章）。
      const seamDrag = seamEntry.drag;
      seamEntry.drag = null;
      if (seamDrag && seamEntry.seam.release(seamDrag.ticket, immediate,
        releaseVelocity(seamDrag.samples, performance.now()))) return;
      if (!seamEntry.landed && seamEntry.seam.turn(++motionInputIdRef.current, immediate) !== "beyond") return;
      if (immediate === seamEntry.seam.direction) seamEntry.pending = immediate;
      return;
    }
    const requestChapterTurn = (adjacent: number): void => {
      beginChapterTurn(immediate, adjacent);
      triggerChapterTransitionWheelLock();
      lockedReverseDirRef.current = immediate === 1 ? -1 : 1;
      reverseLockUntilRef.current = Date.now() + 250;
      turnIntentRef.current.reset();
      if (immediate === 1) props.onRequestChapter(adjacent);
      else props.onRequestChapter(adjacent, { atEnd: true });
    };
    if (p.pageMotionAvailable && resolvedTurnAnimation() === "slide") {
      // 运动层：拖动松手属于同一手势，接续拖动；其他都是新的独立输入。
      const motionDrag = motionDragRef.current;
      motionDragRef.current = null;
      if (motionDrag && p.motionRelease(motionDrag.ticket, immediate,
        releaseVelocity(motionDrag.samples, performance.now()))) return;
      const adjacent = neighbor(spineIndexRef.current, immediate);
      const outcome = p.motionTurn(immediate, ++motionInputIdRef.current, adjacent >= 0);
      if (outcome === "chapter" && !startJoinTurn(immediate) && !startSeamTurn(immediate)) requestChapterTurn(adjacent);
      if (outcome !== "unavailable") return;
    }
    // 先落定进行中的 JS 动画；拖动松手续接同一手势已固定的 frame/目标屏。
    slideAnimRef.current?.finish();
    const drag = slideDragRef.current;
    slideDragRef.current = null;
    if (drag && drag.dir === immediate && resolvedTurnAnimation() === "slide") {
      startSlideTurn(p, { page: drag.frame.page, from: drag.scrollLeft, to: drag.frame.to }, drag);
      return;
    }
    if (drag) p.previewPagedScroll(drag.frame.from);
    // 计划按真实视觉位置生成（原生吸附途中正式页号可能落后）。
    const adjacent = neighbor(spineIndexRef.current, immediate);
    const plan = p.planPagedTurn(immediate, adjacent >= 0);
    if (!plan) return;
    if (plan.kind === "page") {
      if (plan.page === p.currentPage && Math.abs(plan.to - plan.from) <= 0.5) {
        p.setPage(plan.page, { userInitiated: true });
        return;
      }
      if (!startSlideTurn(p, plan)) {
        triggerTurnAnimation(immediate);
        p.setPage(plan.page, { userInitiated: true });
      }
      return;
    }
    // 章边/书边：先正式提交该物理边界屏（接管后未发正式状态时补发）。
    p.setPage(plan.kind === "chapter" ? plan.fromPage : plan.page, { userInitiated: true });
    if (plan.kind === "chapter" && !startJoinTurn(immediate) && !startSeamTurn(immediate)) requestChapterTurn(adjacent);
  };

  const applySwipePreview = (dx: number | null): void => {
    const main = readerContainerRef.current;
    if (!main) return;
    if (dx === null) {
      main.classList.remove("reader-swipe-dragging");
      main.style.removeProperty("--reader-swipe-offset");
      main.style.removeProperty("--reader-swipe-opacity");
      delete main.dataset.swipeDirection;
      delete main.dataset.swipeReady;
      delete main.dataset.swipeFollow;
      const seamEntry = seamRef.current;
      const seamDrag = seamEntry?.drag ?? null;
      if (seamEntry && seamDrag) {
        // 联动拖动同理：没有被翻页接手就回到起点屏（当前章）。
        queueMicrotask(() => {
          if (seamRef.current !== seamEntry || seamEntry.drag !== seamDrag) return;
          seamEntry.drag = null;
          seamEntry.seam.release(seamDrag.ticket, 0, releaseVelocity(seamDrag.samples, performance.now()));
        });
      }
      const joinEntry = joinMotionRef.current;
      const joinDrag = joinEntry?.drag ?? null;
      if (joinEntry && joinDrag) {
        // 穿越拖动同理：没有被翻页接手就回到拼接屏。
        queueMicrotask(() => {
          if (joinMotionRef.current !== joinEntry || joinEntry.drag !== joinDrag) return;
          joinEntry.drag = null;
          joinEntry.owner.paginator?.motionRelease(joinDrag.ticket, 0, releaseVelocity(joinDrag.samples, performance.now()));
        });
      }
      const motionDrag = motionDragRef.current;
      if (motionDrag) {
        // 与下方 drag 同理：没有被翻页接手（距离不足/反悔/被拦截）就回到起点屏。
        queueMicrotask(() => {
          if (motionDragRef.current !== motionDrag) return;
          motionDragRef.current = null;
          paginatorRef.current?.motionRelease(motionDrag.ticket, 0,
            releaseVelocity(motionDrag.samples, performance.now()));
        });
      }
      const drag = slideDragRef.current;
      if (drag) {
        // touchend 先清预览再同步调用 onNext/onPrev；翻页会接手 drag，
        // 否则（距离不足、反悔、被拦截）下一微任务回弹到当前页。
        queueMicrotask(() => {
          if (slideDragRef.current !== drag) return;
          slideDragRef.current = null;
          settleSlideDrag(drag);
        });
      }
      return;
    }
    const logicalDx = dx * pageAxisSign(progressionNow());
    const direction = logicalDx < 0 ? 1 : -1;
    const p = paginatorRef.current;
    const followSeam = (): boolean => {
      const entry = liveSeam();
      if (!entry) return false;
      // 落定后到升格前的零星位移不再驱动任何东西。
      if (entry.landed) return true;
      if (!entry.drag) {
        const ticket = entry.seam.beginDrag(direction);
        entry.drag = ticket === null ? null : { ticket, samples: [] };
      }
      if (!entry.drag) return false;
      entry.seam.drag(entry.drag.ticket, logicalDx);
      entry.drag.samples.push({ t: performance.now(), x: -logicalDx });
      if (entry.drag.samples.length > 8) entry.drag.samples.shift();
      main.classList.add("reader-swipe-dragging");
      main.dataset.swipeFollow = "true";
      main.style.removeProperty("--reader-swipe-offset");
      return true;
    };
    const followJoin = (): boolean => {
      const entry = joinMotionRef.current;
      if (!entry) return false;
      if (entry.landed) return true;
      const owner = entry.owner.paginator;
      if (!owner) return false;
      if (!entry.drag) {
        const ticket = owner.motionBeginDrag(direction);
        entry.drag = ticket === null ? null : { ticket, samples: [] };
      }
      if (!entry.drag) return false;
      owner.motionDrag(entry.drag.ticket, logicalDx);
      entry.drag.samples.push({ t: performance.now(), x: -logicalDx });
      if (entry.drag.samples.length > 8) entry.drag.samples.shift();
      main.classList.add("reader-swipe-dragging");
      main.dataset.swipeFollow = "true";
      main.style.removeProperty("--reader-swipe-offset");
      return true;
    };
    // 穿过拼接屏途中（含被新手势打断）：这次拖动交给接过运动的那一章。
    if (followJoin()) return;
    // 联动进行中（含被新手势打断）：这次拖动属于联动。
    if (followSeam()) return;
    if (p && resolvedTurnAnimation() === "slide" && p.pageMotionAvailable) {
      let motionDrag = motionDragRef.current;
      if (!motionDrag) {
        const ticket = p.motionBeginDrag(direction);
        motionDrag = ticket === null ? null : { ticket, samples: [] };
        motionDragRef.current = motionDrag;
        if (motionDrag) {
          main.classList.add("reader-swipe-dragging");
          main.dataset.swipeFollow = "true";
          main.style.removeProperty("--reader-swipe-offset");
        }
      }
      if (motionDrag) {
        // 运动层 1:1 跟手（只写合成层 transform）；静止于章边向外拖则走下方跨章预览。
        p.motionDrag(motionDrag.ticket, logicalDx);
        motionDrag.samples.push({ t: performance.now(), x: -logicalDx });
        if (motionDrag.samples.length > 8) motionDrag.samples.shift();
        return;
      }
      delete main.dataset.swipeFollow;
    }
    // 会话可能在本次创建时拒绝几何；同章仍须接续备用跟手路径，不能冒充章边。
    if (p && resolvedTurnAnimation() === "slide") {
      let drag = slideDragRef.current;
      if (!drag || drag.dir !== direction) {
        slideAnimRef.current?.finish();
        if (drag) p.previewPagedScroll(drag.frame.from);
        const frame = p.pagedSlideFrame(direction);
        drag = frame ? { dir: direction, frame, scrollLeft: frame.from, samples: [] } : null;
        slideDragRef.current = drag;
      }
      if (drag) {
        // 同章相邻页已在同一多栏文档内：内容 1:1 跟手，不再平移 iframe 或显示文字提示。
        drag.scrollLeft = dragScrollLeft(drag.frame, logicalDx);
        p.previewPagedScroll(drag.scrollLeft);
        drag.samples.push({ t: performance.now(), x: drag.scrollLeft });
        if (drag.samples.length > 8) drag.samples.shift();
        main.classList.add("reader-swipe-dragging");
        main.dataset.swipeFollow = "true";
        main.style.removeProperty("--reader-swipe-offset");
        return;
      }
      delete main.dataset.swipeFollow;
    }
    // 停在拼接屏向另一章拖：另一章接过运动，当前章露出的半边跟着移出。
    if (resolvedTurnAnimation() === "slide" && startJoinMotion(direction) && followJoin()) return;
    if (joinMotionRef.current && !joinMotionRef.current.drag) endJoinMotion();
    // 静止在章边向外拖：相邻章已排好时两章一起跟手，否则走下方的跨章预览。
    if (resolvedTurnAnimation() === "slide" && startSeam(direction) && followSeam()) return;
    if (liveSeam() && !seamRef.current?.drag) abortSeam();
    const canTurn = Boolean(p && (direction === 1
      ? p.currentPage < p.pageCount - 1 || neighbor(spineIndexRef.current, 1) >= 0
      : p.currentPage > 0 || neighbor(spineIndexRef.current, -1) >= 0));
    const ready = canTurn && Math.abs(dx) >= PAGED_SWIPE_THRESHOLD_PX;
    const chapterEdge = Boolean(p && (direction === 1 ? p.currentPage >= p.pageCount - 1 : p.currentPage <= 0));
    const offset = resolvedTurnAnimation() === "none" ? 0
      : Math.max(-72, Math.min(72, dx * (canTurn ? 0.4 : 0.12)));
    main.classList.add("reader-swipe-dragging");
    main.dataset.swipeDirection = direction === 1 ? "next" : "prev";
    main.dataset.swipeReady = String(ready);
    main.style.setProperty("--reader-swipe-offset", `${offset}px`);
    main.style.setProperty("--reader-swipe-opacity", String(Math.min(1, Math.abs(dx) / PAGED_SWIPE_THRESHOLD_PX)));
    if (swipeHintRef.current) {
      swipeHintRef.current.textContent = !canTurn
        ? uiText(direction === 1 ? "readerMisc.swipe.end" : "readerMisc.swipe.start")
        : uiText(chapterEdge ? (direction === 1 ? "readerMisc.swipe.nextChapter" : "readerMisc.swipe.prevChapter") : (direction === 1 ? "readerMisc.swipe.nextPage" : "readerMisc.swipe.prevPage")) + (ready ? uiText("readerMisc.swipe.release") : "");
    }
  };
  updateSwipePreviewRef.current = (dx) => {
    const preview = swipePreviewRef.current;
    if (dx !== null && Math.abs(dx) > 2) markRibbonMotion();
    else if (dx === null && ribbonMotionRef.current) markRibbonMotion(450);
    preview.dx = dx;
    if (dx === null) {
      if (preview.frame) window.cancelAnimationFrame(preview.frame);
      preview.frame = 0;
      applySwipePreview(null);
    } else if (!preview.frame) {
      preview.frame = window.requestAnimationFrame(() => {
        preview.frame = 0;
        applySwipePreview(preview.dx);
      });
    }
  };

  // iframe events do not bubble to the host: attach the same controller to
  // the surrounding reading surface so its margins also accept a swipe.
  useEffect(() => {
    const main = readerContainerRef.current;
    if (!main || settings.readingMode === "scroll") return;
    main.dataset.swipeInput = "true";
    const cleanup = installPagedSwipe(main, {
      onNext: () => turnPageRef.current(pageAxisSign(progressionNow()), "ui"),
      onPrev: () => turnPageRef.current((-pageAxisSign(progressionNow())) as 1 | -1, "ui"),
      onPreview: (dx) => updateSwipePreviewRef.current(dx),
      onGestureStart: () => {
        paginatorRef.current?.prepareMotion(true);
      },
      onGestureEnd: () => paginatorRef.current?.endMotionContact(),
      shouldIgnore: () => inputPausedRef.current || activeSlotRef.current?.state.status !== "ready" ||
        Boolean(activeIframeRef.current?.contentWindow?.getSelection()?.toString()),
    });
    return () => {
      cleanup();
      updateSwipePreviewRef.current(null);
      delete main.dataset.swipeInput;
    };
  }, [book, settings.readingMode]);

  useEffect(() => {
    if (!props.inputPaused) return;
    updateSwipePreviewRef.current(null);
    // 打开阻断输入的面板/图片查看：进行中的章边联动作废，不再请求相邻章。
    cancelSeam();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancelSeam only touches refs.
  }, [props.inputPaused]);

  useEffect(() => {
    const wanted = nativeSnapWantedRef.current;
    activeSlotRef.current?.paginator?.setNativeSnapPaging?.(wanted);
    for (const slot of spareSlotsRef.current) slot.paginator?.setNativeSnapPaging?.(wanted);
  }, [settings.turnAnimation]);

  useImperativeHandle(
    ref,
    () => ({
      applyTheme(theme) {
        applyThemeInPlaceRef.current(theme);
      },
      nextPage() {
        turnPageRef.current(1);
      },
      prevPage() {
        turnPageRef.current(-1);
      },
      setPage(i: number) {
        pauseBackgroundWarmupForInput();
        cancelSeam();
        slideAnimRef.current?.finish();
        const p = paginatorRef.current;
        if (p && i !== p.currentPage) {
          triggerTurnAnimation(i > p.currentPage ? 1 : -1);
        }
        paginatorRef.current?.setPage(i);
      },
      scrollToRatio(ratio: number) {
        pauseBackgroundWarmupForInput();
        const p = paginatorRef.current;
        if (!p || p.pageCount <= 1) return;
        const targetPage = Math.min(p.pageCount - 1, Math.max(0, Math.round(ratio * (p.pageCount - 1))));
        this.setPage(targetPage);
      },
      seekContentFraction(target, _token) {
        pauseBackgroundWarmupForInput();
        const p = paginatorRef.current;
        if (!p) return;
        const pageCount = p.pageCount;
        if (pageCount <= 1) {
          this.setPage(0);
          return;
        }
        const targetPage = Math.min(pageCount - 1, Math.max(0, Math.round(target.fraction * (pageCount - 1))));
        this.setPage(targetPage);
      },
      diagnose() {
        return paginatorRef.current?.diagnose() ?? uiText("log.diagnostics.unavailable");
      },
      getReadingAnchor() {
        return paginatorRef.current?.getReadingAnchor() ?? null;
      },
      resolveBookmarkPage(bookmark) {
        return paginatorRef.current?.resolveBookmarkPage?.(bookmark) ?? bookmark.page ?? null;
      },
      screenBookmarks(bookmarks) {
        const screen = readScreenBookmarks(bookmarks);
        return screen
          ? { kind: "paged", columns: screen.columns, pages: screen.pages.map(({ lane, side, spineIndex, ids }) => ({ lane, side, spineIndex, ids })) }
          : null;
      },
      pageMotionIdle() {
        // A16 联动在外层移动两个 iframe，章内会话此时是 idle；联动到升格交接完成前都算在途。
        return (paginatorRef.current?.pageMotionIdle ?? true) && liveSeam() === null && joinMotionRef.current === null;
      },
      seamReady(edge) {
        const slot = activeSlotRef.current;
        const p = slot?.paginator;
        if (!slot || !p || !slot.ready || slot.state.status !== "ready" || slot.state.empty || !p.pageMotionIdle) {
          return false;
        }
        return edge === "start" ? p.currentPage === 0 : p.currentPage === p.pageCount - 1;
      },
      spreadLeafLayout() {
        const p = paginatorRef.current;
        if (!p || p.isMeasuredForViewport?.() === false) return "pending";
        const geometry = p.spreadLayoutSnapshot?.geometry;
        return geometry && geometry.columns === 2 ? { columnStep: geometry.columnStep } : null;
      },
      captureBookmarkAnchor(lane) {
        const p = paginatorRef.current;
        const slot = activeSlotRef.current;
        if (!p || !slot || slot.spineIndex === null || slot.state.status !== "ready") return null;
        const captured = p.captureLaneAnchor?.(lane);
        return captured ? { spineIndex: slot.spineIndex, page: p.currentPage, ...captured } : null;
      },
      getAnchorText() {
        return paginatorRef.current?.getAnchorText() ?? null;
      },
      readPositionSnapshot(options) {
        return paginatorRef.current?.readPositionSnapshot(options) ?? null;
      },
      jumpToAnchor(anchor) {
        pauseBackgroundWarmupForInput();
        cancelSeam();
        paginatorRef.current?.jumpToAnchor(anchor);
      },
      navigateWithinCurrentChapter(options) {
        pauseBackgroundWarmupForInput();
        cancelSeam();
        const paginator = paginatorRef.current;
        if (!paginator) return false;
        const navigated = paginator.navigateWithinCurrentChapter(options);
        if (navigated) onInternalNavigationSettledRef.current();
        return navigated;
      },
      navigateToSearchTarget(request) {
        pauseBackgroundWarmupForInput();
        cancelSeam();
        const chapterPath = request.chapterPath;
        const activePath = activeSlotRef.current?.path;
        if (chapterPath && activePath && chapterPath !== activePath) return "unresolved";
        return paginatorRef.current?.navigateToSearchTarget(request) ?? "unresolved";
      },
      getFootnoteMarkerRect() {
        const p = paginatorRef.current;
        const iframe = activeIframeRef.current;
        const main = iframe?.parentElement;
        const r = p?.getFootnoteMarkerRect();
        if (!p || !iframe || !main || !r) return null;
        const ir = iframe.getBoundingClientRect();
        const mr = main.getBoundingClientRect();
        const dx = ir.left - mr.left;
        const dy = ir.top - mr.top;
        return {
          left: r.left + dx,
          top: r.top + dy,
          right: r.right + dx,
          bottom: r.bottom + dy,
        };
      },
      dismissFootnote() {
        paginatorRef.current?.dismissFootnote();
      },
      pinFootnote() {
        paginatorRef.current?.pinFootnote();
      },
      setFootnoteOverlayHover(over: boolean) {
        paginatorRef.current?.setFootnoteOverlayHover(over);
      },
      clearTextSelection() {
        paginatorRef.current?.clearTextSelection();
      },
      scrollToStart() {
        cancelSeam();
        paginatorRef.current?.scrollToStart();
      },
      scrollToEnd() {
        cancelSeam();
        paginatorRef.current?.scrollToEnd();
      },
      atScrollBoundary(direction) {
        return paginatorRef.current?.atScrollBoundary(direction) ?? true;
      },
      scrollByViewport(direction) {
        return paginatorRef.current?.scrollByViewport(direction) ?? false;
      },
      scrollByDelta(deltaY) {
        paginatorRef.current?.scrollByDelta(deltaY);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Keep the public handle stable within a book; methods access the live paginator through refs.
    [book]
  );

  // 固定版式：按 viewport 设置宽高比
  const vp = parseViewport(book.viewport);
  const overlayInputActive = props.inputPaused === true;

  return (
    <>
      {overlayInputActive && (
        <style data-reader="overlay-input-gate">
          {`.reader[data-overlay-input="true"] iframe { pointer-events: none !important; }`}
        </style>
      )}
      <div
        ref={readerContainerRef}
        className={`reader${turnAnim ? ` has-turn-anim ${turnAnim.direction === 1 ? "turn-next" : "turn-prev"}` : ""}`}
        data-overlay-input={overlayInputActive ? "true" : undefined}
        // 正文点击在 iframe 里由 plainTap 路由；这里只接 iframe 之外的空白（隐藏的
        // 帧、固定版式留边）。翻页带不再接收点击，按同一几何翻页并亮反馈。
        onPointerDown={(event) => {
          if (event.target === event.currentTarget && !inputPausedRef.current &&
            routeHostBlankTurn(tapRouting, event.clientX, event.clientY)) paginatorRef.current?.prepareMotion?.();
        }}
        onClick={(event) => {
          // 输入暂停（图片查看等）时 iframe 不接点击，点击会落到这里：同样不翻页、不亮箭头。
          if (event.target !== event.currentTarget || inputPausedRef.current) return;
          const route = routeHostBlankTurn(tapRouting, event.clientX, event.clientY);
          if (!route || !tapRouting) return;
          tapRouting.feedback.hold(edgeFeedbackKeyOf(route.side));
          if (turnOwner) turnOwner(route.direction);
          else turnPageRef.current(route.direction);
        }}
        onWheel={(event) => {
          if (overlayInputActive) return;
          // 输入到达优先：先取消未发布的后台任务；具体翻页仍由后面路径决定。
          pauseBackgroundWarmupForInput();
          if (latestRenderSettingsRef.current.readingMode === "scroll") {
            const p = paginatorRef.current;
            if (!p) return;
            if (lastStateRef.current === "loading" || lastStateRef.current === "measuring") return;
            const deltaY = event.deltaMode === 1
              ? event.deltaY * 28
              : event.deltaMode === 2
                ? event.deltaY * (readerContainerRef.current?.clientHeight ?? 600)
                : event.deltaY;
            const dir = deltaY > 0 ? 1 : -1;
            if (!p.atScrollBoundary(dir)) {
              outerScrollWheelRef.current.reset();
              p.scrollByDelta(deltaY);
              return;
            }
            // 已经在边界：检查反向回弹保护（单向锁 800ms）
            if (dir === lockedReverseDirRef.current && Date.now() < reverseLockUntilRef.current) {
              outerScrollWheelRef.current.reset();
              return;
            }
            // 同向连续换章微防抖（150ms）
            if (Date.now() < sameDirThrottleUntilRef.current) {
              outerScrollWheelRef.current.reset();
              return;
            }
            const direction = outerScrollWheelRef.current.push(deltaY);
            if (direction === null) return;
            lockedReverseDirRef.current = -direction as 1 | -1;
            reverseLockUntilRef.current = Date.now() + 250;
            sameDirThrottleUntilRef.current = Date.now() + 150;
            event.preventDefault();
            turnPageRef.current(direction, "wheel");
            return;
          }
          // visibility:hidden 时滚轮会命中外层；浏览器还可能把同一连续手势
          // 锁定在这个目标上，所以 iframe 显示后也必须继续消费外层事件。
          if (isWheelGestureSuppressed()) return;
          const direction = outerWheelRef.current.push(event.deltaY);
          if (direction === null) return;
          if (direction === lockedReverseDirRef.current && Date.now() < reverseLockUntilRef.current) {
            outerWheelRef.current.reset();
            return;
          }
          event.preventDefault();
          turnPageRef.current(direction, "wheel");
        }}
      style={
        book.fixedLayout && vp
          ? {
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 12,
            }
          : undefined
      }
    >
      {(book.fixedLayout || settings.preloadNextChapter === true || activeFrame === "primary") && (
        <iframe
          ref={primaryIframeRef}
          title={activeFrame === "primary" ? "chapter" : "preloaded chapter"}
          aria-hidden={activeFrame !== "primary"}
          style={
            book.fixedLayout && vp
              ? {
                  position: "relative",
                  inset: "auto",
                  width: "auto",
                  height: "auto",
                  aspectRatio: `${vp.w} / ${vp.h}`,
                  maxWidth: "100%",
                  maxHeight: "100%",
                }
              : activeFrame === "primary"
                ? undefined
                : { visibility: "hidden", zIndex: 0 }
          }
        />
      )}
      {!book.fixedLayout && (settings.preloadNextChapter === true || activeFrame === "secondary") && (
        <iframe
          ref={secondaryIframeRef}
          title={activeFrame === "secondary" ? "chapter" : "preloaded chapter"}
          aria-hidden={activeFrame !== "secondary"}
          // It remains layoutable at the exact reader dimensions, but can
          // never become visible or interactive until its prepared slot is
          // promoted after the React spineIndex effect.
          style={activeFrame === "secondary" ? undefined : { visibility: "hidden", zIndex: 0 }}
        />
      )}
      {!book.fixedLayout && (settings.preloadNextChapter === true || activeFrame === "tertiary") && (
        <iframe
          ref={tertiaryIframeRef}
          title={activeFrame === "tertiary" ? "chapter" : "preloaded chapter"}
          aria-hidden={activeFrame !== "tertiary"}
          style={activeFrame === "tertiary" ? undefined : { visibility: "hidden", zIndex: 0 }}
        />
      )}
      {!book.fixedLayout && (settings.preloadNextChapter === true || activeFrame === "quaternary") && (
        <iframe
          ref={quaternaryIframeRef}
          title={activeFrame === "quaternary" ? "chapter" : "preloaded chapter"}
          aria-hidden={activeFrame !== "quaternary"}
          style={activeFrame === "quaternary" ? undefined : { visibility: "hidden", zIndex: 0 }}
        />
      )}
      {!book.fixedLayout && (settings.preloadNextChapter === true || activeFrame === "quinary") && (
        <iframe
          ref={quinaryIframeRef}
          title={activeFrame === "quinary" ? "chapter" : "preloaded chapter"}
          aria-hidden={activeFrame !== "quinary"}
          style={activeFrame === "quinary" ? undefined : { visibility: "hidden", zIndex: 0 }}
        />
      )}
      {!book.fixedLayout && settings.preloadNextChapter === true && (
        <iframe
          ref={warmupIframeRef}
          title="preloaded chapter"
          aria-hidden="true"
          style={{ visibility: "hidden", zIndex: 0 }}
        />
      )}
      <div
        ref={visualOverlayRef}
        className="reader-visual-overlay-host"
        aria-hidden="true"
      />
      {!book.fixedLayout && <BookmarkRibbonLayer marks={ribbonMarks} cue={props.bookmarkCue ?? null} motion={ribbonMotion} />}
      <div ref={swipeHintRef} className="reader-swipe-hint" aria-hidden="true" />
      {edgeTurnZoneSpecs(tapRouting).map((zone) => <EdgeTurnZone key={zone.side}
        direction={zone.direction}
        side={zone.sideProp}
        region={zone.region}
      />)}
      </div>
    </>
  );
});

export const ReaderView = forwardRef<ReaderHandle, ReaderViewProps>(function ReaderView(props, ref) {
  const edgeFeedback = useEdgeTurnFeedbackOwner();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // A13：整图章和短文字章（只读 XHTML 判断）连续成段，两两并排；能否并排由显示确认。
  const imageSpreads = useMemo(() => new SingleLeafSpreads(props.book,
    createLeafChapterClassifier(props.book, (path, signal) => props.server.readTextFor(path, signal))),
  [props.book, props.server]);
  const [imagePlan, setImagePlan] = useState<{
    resolver: SingleLeafSpreads; index: number; spread: SingleLeafSpread | null;
  } | null>(null);
  const requestedSpread = props.settings.readingMode !== "scroll" &&
    props.settings.columnsPerView === 2 && !props.book.fixedLayout;
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setWidth(element.clientWidth);
    setHeight(element.clientHeight);
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
      setHeight(element.clientHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!requestedSpread) return;
    const controller = new AbortController();
    void imageSpreads.resolve(props.spineIndex, controller.signal).then((spread) => {
      if (!controller.signal.aborted) setImagePlan({ resolver: imageSpreads, index: props.spineIndex, spread });
    }, () => {
      // Ordinary chapter loading owns resource/parse errors. Never turn a
      // failed classification into a permanently cached "not an image".
      if (!controller.signal.aborted) setImagePlan({ resolver: imageSpreads, index: props.spineIndex, spread: null });
    });
    return () => controller.abort();
  }, [imageSpreads, props.spineIndex, props.anchorNonce, requestedSpread]);
  // 版式身份变了（窗口高宽、字号、行距、页边距、字体……）：退回过单章的组下次进入时重新确认。
  // 只换主题颜色不影响排版，不算。
  const [height, setHeight] = useState(0);
  const { theme: _theme, ...layoutSettings } = props.settings;
  const layoutIdentity = `${width}x${height}|${JSON.stringify(layoutSettings)}`;
  useEffect(() => {
    imageSpreads.retryRejected();
  }, [imageSpreads, layoutIdentity]);
  const imageGeometry = createSpreadGeometry(Math.max(0, width -
    (props.settings.pageMarginsPx?.left ?? 0) - (props.settings.pageMarginsPx?.right ?? 0)), props.settings.gapPx, 2);
  const planned = imageSpreads.peek(props.spineIndex) ?? (imagePlan?.resolver === imageSpreads &&
    imagePlan.index === props.spineIndex ? imagePlan.spread : null);
  const pair = requestedSpread && imageGeometry.columns === 2 ? planned : null;
  // A16：会显示为 A13 并排组的相邻章换的是另一种视图，章边联动不进入；分类未知时也不进入。
  const spreadsShown = requestedSpread && imageGeometry.columns === 2;
  // 只在章边联动可能发生时（高性能预读 + 连续滑动 + 滑动动画）才多分类前后章，普通模式不增加读取。
  const seamPossible = props.settings.preloadNextChapter === true && props.settings.seamlessChapterTurn === true &&
    normalizeTurnAnimation(props.settings.turnAnimation) === "slide" && !prefersReducedMotion();
  const seamTargetEligible = useCallback((index: number) => !spreadsShown || imageSpreads.peek(index) === null,
    [spreadsShown, imageSpreads]);
  // A13-2：章边拼接只在普通正文之间；A13 并排组是独立边界（配对从它之后重新开始）。
  const chapterFillKind = useCallback((index: number): "ordinary" | "isolated" | undefined => {
    if (!spreadsShown) return "ordinary";
    const spread = imageSpreads.peek(index);
    return spread === undefined ? undefined : spread === null ? "ordinary" : "isolated";
  }, [spreadsShown, imageSpreads]);
  const resolveChapterFillKind = useCallback(async (index: number, signal: AbortSignal): Promise<"ordinary" | "isolated"> => {
    if (!spreadsShown) return "ordinary";
    return await imageSpreads.resolve(index, signal) === null ? "ordinary" : "isolated";
  }, [spreadsShown, imageSpreads]);
  // A16 第二阶段：连续滑动 + 双页时，外层同时保留当前显示与相邻显示层（见 presentationStack）。
  const stackOn = seamPossible && spreadsShown && props.settings.readingMode !== "scroll" && !props.book.fixedLayout;
  const [classifiedTick, setClassifiedTick] = useState(0);
  const plan: PresentationPlan | null = stackOn
    ? planPresentationLayers(props.book, props.spineIndex, pair, (index) => imageSpreads.peek(index))
    : null;
  const parkedIndex = plan?.layers.find((layer) => layer.key === PAGED_LAYER)?.spineIndex ?? -1;
  useEffect(() => {
    if (!spreadsShown || !seamPossible) return;
    // 提前分类相邻显示单元（只读 XHTML），让章边联动知道它们是否会并排；分好后重新规划。
    const controller = new AbortController();
    const first = pair?.left ?? props.spineIndex;
    const last = pair ? pair.right ?? pair.left : props.spineIndex;
    const wanted = [nextLinearIndex(props.book, last, 1), nextLinearIndex(props.book, first, -1), parkedIndex];
    for (const index of wanted) {
      if (index >= 0 && imageSpreads.peek(index) === undefined) {
        void imageSpreads.resolve(index, controller.signal).then(() => {
          if (!controller.signal.aborted) setClassifiedTick((tick) => tick + 1);
        }, () => {});
      }
    }
    return () => controller.abort();
  }, [imageSpreads, props.book, props.spineIndex, pair, parkedIndex, spreadsShown, seamPossible, classifiedTick]);
  const tapGeometry = useMemo(() => createReaderTapGeometry(width, props.tapRegions), [width, props.tapRegions]);
  const bookProgression = effectivePageProgression(props.book.pageProgression, props.settings, props.book.fixedLayout);
  // 点击翻页区按本章实际方向映射（竖排书元数据没写方向时与元数据不同）。
  const [flow, setFlow] = useState<{ book: Book; progression: "ltr" | "rtl" } | null>(null);
  const progression = flow?.book === props.book ? flow.progression : bookProgression;
  const onFlowProgression = useCallback((value: "ltr" | "rtl") => {
    setFlow((current) => current?.book === props.book && current.progression === value ? current : { book: props.book, progression: value });
  }, [props.book]);
  const tapRouting = useMemo<ReaderTapRouting | null>(() => props.tapRegions ? {
    device: props.tapRegions.device,
    preferences: props.tapRegions.preferences,
    progression,
    geometry: tapGeometry,
    hostLeft: () => host.current?.getBoundingClientRect().left ?? null,
    hostTop: () => host.current?.getBoundingClientRect().top ?? null,
    feedback: edgeFeedback,
  } : null, [props.tapRegions, progression, tapGeometry, edgeFeedback]);
  // ---- 显示层（仅 stackOn）：每层自己的 handle 与元素；App 的 ref 只转到当前显示 ----
  const layerHandles = useRef(new Map<string, RefObject<ReaderHandle>>());
  const layerElements = useRef(new Map<string, HTMLDivElement>());
  const handleRefFor = (key: string): RefObject<ReaderHandle> => {
    let handleRef = layerHandles.current.get(key);
    if (!handleRef) {
      handleRef = createRef<ReaderHandle>();
      layerHandles.current.set(key, handleRef);
    }
    return handleRef;
  };
  const planRef = useRef(plan);
  planRef.current = plan;
  const latestProps = useRef(props);
  latestProps.current = props;
  const progressionRef = useRef(progression);
  progressionRef.current = progression;
  useImperativeHandle(stackOn ? ref : null, () => new Proxy({} as ReaderHandle, {
    get: (_target, property) => {
      const handle = layerHandles.current.get(planRef.current?.mainKey ?? PAGED_LAYER)?.current as
        unknown as Record<PropertyKey, unknown> | null | undefined;
      const value = handle?.[property];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(handle) : value;
    },
  }), []);

  // 上一次提交时各预备层停在哪一章：App 换到其中一层正显示的章时由那一层直接接管。
  const committed = useRef<{ anchorNonce: number; standby: Map<string, number> }>({ anchorNonce: props.anchorNonce, standby: new Map() });
  useLayoutEffect(() => {
    committed.current = {
      anchorNonce: props.anchorNonce,
      standby: new Map(plan?.layers.filter((layer) => layer.role === "standby").map((layer) => [layer.key, layer.spineIndex]) ?? []),
    };
  });
  const adoptedFor = (key: string, spineIndex: number) => stackOn && spineIndex === props.spineIndex &&
    committed.current.standby.get(key) === props.spineIndex && committed.current.anchorNonce === props.anchorNonce &&
    !props.preciseTarget && (key !== PAGED_LAYER || !props.startAtEnd.atEnd)
    ? { spineIndex: props.spineIndex, anchorNonce: props.anchorNonce, startNonce: props.startAtEnd.nonce }
    : null;

  // 层间联动：当前显示与相邻预备层一起移动；落定后提交换章，由预备层接管（见 adoptedFor）。
  // 记下联动当时的两个元素：清理可能发生在提交的变更阶段，那时层的 ref 已经摘下。
  const layerSeam = useRef<{
    seam: ChapterSeam; external: ExternalSeam; target: HTMLElement; host: HTMLElement; landed: boolean;
  } | null>(null);
  const clearLayerSeam = (): void => {
    const entry = layerSeam.current;
    if (!entry) return;
    layerSeam.current = null;
    entry.seam.dispose();
    delete entry.target.dataset.seamReveal;
    delete entry.host.dataset.chapterSeam;
  };
  const externalSeam = useCallback((direction: 1 | -1): ExternalSeam | null => {
    const live = layerSeam.current;
    if (live && !live.seam.done) return live.landed ? null : { ...live.external, fresh: false };
    const current = planRef.current;
    if (!current) return null;
    const targetKey = direction === 1 ? current.nextKey : current.prevKey;
    const targetIndex = direction === 1 ? current.nextIndex : current.prevIndex;
    if (!targetKey || targetIndex < 0 || targetKey === current.mainKey) return null;
    const target = layerHandles.current.get(targetKey)?.current;
    if (!target?.seamReady?.(direction === 1 ? "start" : "end")) return null;
    const mainElement = layerElements.current.get(current.mainKey);
    const targetElement = layerElements.current.get(targetKey);
    const hostElement = host.current;
    const width = hostElement?.clientWidth ?? 0;
    if (!mainElement || !targetElement || !hostElement || !(width > 0)) return null;
    let seam: ChapterSeam | null = null;
    seam = new ChapterSeam({
      direction,
      current: mainElement,
      neighbor: targetElement,
      width,
      progression: progressionRef.current,
      touch: prefersCoarsePointer(),
      onSettled: (landed) => {
        const entry = layerSeam.current;
        if (!entry || entry.seam !== seam) return;
        if (!landed) {
          clearLayerSeam();
          return;
        }
        entry.landed = true;
        latestProps.current.onRequestChapter(targetIndex, direction === -1 ? { atEnd: true } : undefined);
      },
      onFault: (error) => {
        console.warn("[reader] chapter layer seam fault", error);
        if (layerSeam.current?.seam === seam) clearLayerSeam();
      },
    });
    targetElement.dataset.seamReveal = "true";
    hostElement.dataset.chapterSeam = direction === 1 ? "next" : "prev";
    const external: ExternalSeam = {
      seam,
      targetIndex,
      fresh: true,
      cancel: () => {
        const entry = layerSeam.current;
        if (entry?.seam === seam && !entry.landed) clearLayerSeam();
      },
    };
    layerSeam.current = { seam, external, target: targetElement, host: hostElement, landed: false };
    return external;
    // Reads only refs; stable for the life of the wrapper.
  }, []);
  // 层间联动只由这里持有：当前显示换层（落定接管）时同一次提交里撤掉平移，新层已在原位，不闪；
  // 换书/资源、版式几何变化、App 发起的任何导航、暂停输入、卸载（退出本书）都在落定前作废它，
  // 迟到的完成回调因 layerSeam 已清空而无权再请求章节。
  const mainKey = plan?.mainKey ?? null;
  useLayoutEffect(() => clearLayerSeam, [mainKey, stackOn, props.book, props.server, layoutIdentity,
    props.spineIndex, props.anchorNonce, props.startAtEnd.nonce, props.inputPaused]);

  let content;
  if (props.settings.readingMode === "scroll" && !props.book.fixedLayout) {
    content = <ContinuousReaderView {...props} ref={ref} />;
  } else if (plan) {
    content = plan.layers.map((layer) => {
      const main = layer.role === "main";
      const layerProps = main ? props : standbyReaderProps(props, layer.spineIndex);
      const node = layer.kind === "paged"
        ? <PagedReaderView {...layerProps} ref={handleRefFor(layer.key)}
          onFlowProgression={main ? onFlowProgression : undefined}
          seamTargetEligible={seamTargetEligible}
          chapterFillKind={chapterFillKind}
          resolveChapterFillKind={resolveChapterFillKind}
          externalSeam={main ? externalSeam : undefined}
          adoptedNavigation={adoptedFor(layer.key, layer.spineIndex)} />
        : <ImageSpreadReaderView {...layerProps} ref={handleRefFor(layer.key)}
          spread={layer.spread} Page={PagedReaderView}
          externalSeam={main ? externalSeam : undefined}
          adoptedNavigation={adoptedFor(layer.key, layer.spineIndex)}
          onUnsupported={() => {
            imageSpreads.reject(layer.spread);
            if (main) setImagePlan({ resolver: imageSpreads, index: props.spineIndex, spread: null });
            else setClassifiedTick((tick) => tick + 1);
          }} />;
      return <div key={layer.key} className="reader-layer" data-role={layer.role}
        ref={(element) => {
          if (element) layerElements.current.set(layer.key, element);
          else layerElements.current.delete(layer.key);
        }}>{node}</div>;
    });
  } else if (pair) {
    content = <ImageSpreadReaderView key={`${pair.left}:${pair.right}`} {...props} ref={ref}
      spread={pair} Page={PagedReaderView}
      onUnsupported={() => {
        imageSpreads.reject(pair);
        setImagePlan({ resolver: imageSpreads, index: props.spineIndex, spread: null });
      }} />;
  } else {
    content = <PagedReaderView {...props} ref={ref} onFlowProgression={onFlowProgression}
      seamTargetEligible={seamTargetEligible} chapterFillKind={chapterFillKind}
      resolveChapterFillKind={resolveChapterFillKind} />;
  }
  return <EdgeTurnFeedbackContext.Provider value={edgeFeedback}>
    <ReaderTapRoutingContext.Provider value={tapRouting}>
      <div ref={host} className="reader-presentation-host">{content}</div>
    </ReaderTapRoutingContext.Provider>
  </EdgeTurnFeedbackContext.Provider>;
});
