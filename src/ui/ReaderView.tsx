import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
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
} from "../render/paginator";
import type { ResourceServer } from "../render/resources";
import type { ReaderSettings } from "../render/settings";
import { createSettingsReloadDebouncer } from "./settingsReload";
import { TurnIntentBuffer, WheelTurnAccumulator } from "./turnIntent";
import { ReadingWarmupPlan, backgroundPreparation, type WarmupTicket } from "./readerWarmup";
import { ContinuousReaderView } from "./ContinuousReaderView";
import type { ScrubToken } from "./readerProgressAxis";

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
  /** 当前锚点元素的一行文本（书签列表展示用） */
  getAnchorText(): string | null;
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
}

interface ReaderViewProps {
  book: Book;
  server: ResourceServer;
  spineIndex: number;
  /** 目录跳转的页内锚点（随章节切换一起更新） */
  anchor?: string;
  /** 锚点变更序号：仅用于跨章或同章 direct 失败后的兼容重载 */
  anchorNonce: number;
  settings: ReaderSettings;
  /** 用户上传字体的会话内资源（family + blob URL） */
  userFonts: Array<{ family: string; url: string }>;
  /** 当前章节笔记；更新仅重建 CSS Highlight，不触发章节重载。 */
  notes: ReaderNoteForPaginator[];
  onPageState(s: ChapterState): void;
  /** Paginator display gate released after final anchor/page positioning. */
  onDisplayReady(): void;
  /** 请求切换到相邻章节（next/prev 或空章自动前进） */
  onRequestChapter(index: number, opts?: { atEnd?: boolean }): void;
  /** 章节切换请求（nonce 单调递增；atEnd=true 表示加载完成后翻到最后一页） */
  startAtEnd: { nonce: number; atEnd: boolean };
  onIssues(issues: string[]): void;
  /** 书内链接跳转（已解析为书内路径，含可选 #anchor） */
  onInternalLink(href: string): void;
  /** 普通书内链接改变位置前通知 UI 记录一次撤销快照。 */
  onBeforeInternalNavigate(href: string): void;
  /** 同章 fragment 已同步完成定位，可再次捕获下一次跳转。 */
  onInternalNavigationSettled(): void;
  /** 连续模式语义锚点失败时结束 loading，但不冒充定位成功。 */
  onNavigationUnresolved?(reported: boolean): void;
  /** 连续宿主发生真实用户位移；程序化定位/重排不触发。 */
  onUserReadingPositionChange?(): void;
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
}

function parseViewport(vp: string | undefined): { w: number; h: number } | null {
  if (!vp) return null;
  const m = /^(\d+)\s*[xX,]\s*(\d+)$/.exec(vp.trim());
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
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
export function sameRenderingSettings(a: ReaderSettings, b: ReaderSettings): boolean {
  return (
    a.fontSizePx === b.fontSizePx &&
    a.theme === b.theme &&
    a.fontFamily === b.fontFamily &&
    a.customFontName === b.customFontName &&
    a.fontSource === b.fontSource &&
    a.customFontId === b.customFontId &&
    a.customFonts === b.customFonts &&
    a.customCss === b.customCss &&
    a.gapPx === b.gapPx &&
    a.readingMode === b.readingMode &&
    a.columnsPerView === b.columnsPerView &&
    a.spreadGapMode === b.spreadGapMode &&
    // 值比较：新建同值对象不应触发重载。
    samePageMargins(a.pageMarginsPx, b.pageMarginsPx) &&
    a.lineHeight === b.lineHeight &&
    a.fontWeight === b.fontWeight &&
    a.letterSpacingPx === b.letterSpacingPx &&
    a.wordSpacingPx === b.wordSpacingPx &&
    a.forceHorizontal === b.forceHorizontal
  );
}

function samePageMargins(
  a: ReaderSettings["pageMarginsPx"],
  b: ReaderSettings["pageMarginsPx"],
): boolean {
  if (a === b) return true;
  const keys = ["top", "bottom", "left", "right"] as const;
  for (const key of keys) {
    if ((a?.[key] ?? null) !== (b?.[key] ?? null)) return false;
  }
  return true;
}

const PagedReaderView = forwardRef<ReaderHandle, ReaderViewProps>(function PagedReaderView(
  props,
  ref
) {
  const { book, server, spineIndex, settings } = props;
  const primaryIframeRef = useRef<HTMLIFrameElement>(null);
  const secondaryIframeRef = useRef<HTMLIFrameElement>(null);
  const tertiaryIframeRef = useRef<HTMLIFrameElement>(null);
  const quaternaryIframeRef = useRef<HTMLIFrameElement>(null);
  const quinaryIframeRef = useRef<HTMLIFrameElement>(null);
  const warmupIframeRef = useRef<HTMLIFrameElement>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);
  const activeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const paginatorRef = useRef<ChapterPaginator | null>(null);
  const activeSlotRef = useRef<PaginatorSlot | null>(null);
  // 高性能模式下活动章加最多四个邻章组成当前章 ±2 五章活缓存。
  // Spare slots are never allowed to emit UI callbacks; their state is only
  // used by the cache scheduler.
  const spareSlotsRef = useRef<PaginatorSlot[]>([]);
  const [activeFrame, setActiveFrame] = useState<ReaderFrame>("primary");
  const activeFrameRef = useRef<ReaderFrame>("primary");

  // ---- 硬件加速 2D 翻页过渡动画（Zen UI Packet C） ----
  const [turnAnim, setTurnAnim] = useState<{ direction: 1 | -1 } | null>(null);
  const turnAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (turnAnimTimerRef.current) {
        clearTimeout(turnAnimTimerRef.current);
      }
    };
  }, []);

  const triggerTurnAnimation = (dir: 1 | -1) => {
    if (settings.instantTurn === true) {
      setTurnAnim(null);
      return;
    }
    if (turnAnimTimerRef.current) clearTimeout(turnAnimTimerRef.current);
    setTurnAnim({ direction: dir });
    turnAnimTimerRef.current = setTimeout(() => {
      setTurnAnim(null);
    }, 180);
  };
  const preloadGenerationRef = useRef(0);
  // Keep the scheduler independent from the closure used when the active
  // paginator was created.  Toggling the experimental mode must neither
  // reload the active chapter nor let an old display-ready callback restart
  // a cancelled preload.
  const preloadAllowedRef = useRef(false);
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
  const onSelectionContextMenuRef = useRef(props.onSelectionContextMenu);
  const onPageStateRef = useRef(props.onPageState);
  const onIssuesRef = useRef(props.onIssues);
  const onRequestChapterRef = useRef(props.onRequestChapter);
  const onFootnoteRef = useRef(props.onFootnote);
  const onFootnoteCloseRef = useRef(props.onFootnoteClose);
  const onExternalLinkRef = useRef(props.onExternalLink);
  const onPreciseNavigationStatusRef = useRef(props.onPreciseNavigationStatus);
  const onImageActivationRef = useRef(props.onImageActivation);
  // 图片浮层打开时，分页器对按键/滚轮的回调被短路，触摸翻页也由下面的
  // overlay-active 样式屏蔽；关闭后不需要重新接线。
  const inputPausedRef = useRef(props.inputPaused === true);

  spineIndexRef.current = spineIndex;
  onInternalLinkRef.current = props.onInternalLink;
  onBeforeInternalNavigateRef.current = props.onBeforeInternalNavigate;
  onInternalNavigationSettledRef.current = props.onInternalNavigationSettled;
  onDisplayReadyRef.current = props.onDisplayReady;
  onSelectionContextMenuRef.current = props.onSelectionContextMenu;
  onPageStateRef.current = props.onPageState;
  onIssuesRef.current = props.onIssues;
  onRequestChapterRef.current = props.onRequestChapter;
  onFootnoteRef.current = props.onFootnote;
  onFootnoteCloseRef.current = props.onFootnoteClose;
  onExternalLinkRef.current = props.onExternalLink;
  onPreciseNavigationStatusRef.current = props.onPreciseNavigationStatus;
  onImageActivationRef.current = props.onImageActivation;
  inputPausedRef.current = props.inputPaused === true;
  preloadAllowedRef.current =
    settings.preloadNextChapter === true &&
    !book.fixedLayout &&
    settings.readingMode !== "scroll";

  const isActiveSlot = (slot: PaginatorSlot): boolean =>
    activeSlotRef.current === slot && paginatorRef.current === slot.paginator && slot.paginator !== null;

  const setActiveFrameVisual = (frame: LiveReaderFrame): void => {
    activeFrameRef.current = frame;
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
    if (!slot || !paginator || !isActiveSlot(slot)) return;
    const state = paginator.getStateSnapshot();
    lastStateRef.current = state.status;
    if (state.status !== "ready") return;
    // B-151：空章是成功加载的一种终态。只有明确还有下一章且已经发起自动
    // 跳转时，旧空章不发布 active ready；末章空章必须解除 loading/turn intent。
    const hasNext = slot.spineIndex !== null && nextLinearIndex(book, slot.spineIndex, 1) >= 0;
    if (state.empty && (hasNext || autoAdvanceRef.current)) return;
    lastReadyEmptyRef.current = state.empty;
    armChapterTransitionDisplaySettled();
    onDisplayReadyRef.current();
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
    const paginator = new ChapterPaginator(
      slot.iframe,
      server,
      slot.renderSettings,
      book.version === 2,
      (state) => {
        slot.state = state;
        if (state.status !== "ready") slot.ready = false;
        if (!isActiveSlot(slot)) return;
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
        onPageStateRef.current(state);
        if (state.status !== "ready" || !state.empty || autoAdvanceRef.current) return;
        const next = nextLinearIndex(book, spineIndexRef.current, 1);
        if (next >= 0) {
          autoAdvanceRef.current = true;
          turnIntentRef.current.markLoading();
          onRequestChapterRef.current(next);
        }
      },
      (issues) => {
        if (isActiveSlot(slot)) onIssuesRef.current(issues);
      },
      book.fixedLayout,
      (href) => {
        if (isActiveSlot(slot)) onInternalLinkRef.current(href);
      },
      (href) => {
        if (isActiveSlot(slot)) onBeforeInternalNavigateRef.current(href);
      },
      () => {
        if (isActiveSlot(slot)) onInternalNavigationSettledRef.current();
      },
      (dir) => {
        if (!isActiveSlot(slot)) return;
        // 输入到达先于切换判断：即使处于换章静默期，也暂停未发布的后台测量。
        pauseBackgroundWarmupForInput();
        if (isWheelGestureSuppressed()) return;
        if (dir === lockedReverseDirRef.current && Date.now() < reverseLockUntilRef.current) return;
        turnPageRef.current(dir, "wheel");
      },
      (dir) => {
        if (isActiveSlot(slot) && !inputPausedRef.current) turnPageRef.current(dir, "key");
      },
      (payload) => {
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
      () => {
        if (isActiveSlot(slot)) onFootnoteCloseRef.current();
      },
      (url) => {
        if (isActiveSlot(slot)) onExternalLinkRef.current(url);
      },
      () => {
        slot.ready = true;
        slot.state = paginator.getStateSnapshot();
        if (isActiveSlot(slot)) publishActiveDisplayReady();
      },
      (payload) => {
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
      (status) => {
        if (isActiveSlot(slot)) onPreciseNavigationStatusRef.current?.(status);
      },
      (image) => {
        // 非活动槽（预加载）不得打开浮层；同时避免借用已撤销的 blob URL。
        if (isActiveSlot(slot)) onImageActivationRef.current?.(image);
      }
    );
    slot.paginator = paginator;
    return paginator;
  };

  const disposeSpareSlot = (slot: PaginatorSlot): void => {
    const index = spareSlotsRef.current.indexOf(slot);
    if (index < 0) return;
    if (preloadInFlightSlotRef.current === slot) preloadInFlightSlotRef.current = null;
    spareSlotsRef.current.splice(index, 1);
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
    for (const slot of [...spareSlotsRef.current]) {
      if (
        slot.spineIndex === null ||
        !wantedPaths.has(slot.spineIndex) ||
        slot.path !== wantedPaths.get(slot.spineIndex) ||
        !sameRenderingSettings(slot.renderSettings, latestRenderSettingsRef.current)
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
      };
      spareSlotsRef.current.push(slot);
      usedFrames.add(frame);
      preloadInFlightSlotRef.current = slot;
      const paginator = buildPaginator(slot);
      const generation = slot.generation;
      void paginator
        .loadAndWaitForDisplay(path, { resetPage: true })
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
    if (!preloadAllowedRef.current || latestRenderSettingsRef.current.readingMode === "scroll") {
      resetFullBookWarmup();
      return;
    }
    if (warmupRunningRef.current || warmupIdleRef.current !== null) return;
    requestWarmupIdle(() => runNextFullBookWarmup());
  };

  const runNextFullBookWarmup = (): void => {
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

  const promotePreparedChapter = (path: string, targetIndex: number, atEnd: boolean): boolean => {
    const current = activeSlotRef.current;
    const next = spareSlotsRef.current.find((slot) => slot.path === path && slot.spineIndex === targetIndex);
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
      next.state.status !== "ready"
    ) {
      return false;
    }
    const state = next.paginator.getStateSnapshot();
    if (state.status !== "ready") return false;
    // The old active slot is being demoted to cache; close its transient UI
    // and clear its search highlight while it still owns the active identity.
    current.paginator?.closeForNavigation();
    current.paginator?.clearSearchHighlight();
    spareSlotsRef.current = spareSlotsRef.current.filter((slot) => slot !== next);
    // Retain the old current chapter as the adjacent back/forward cache.  The
    // scheduler below will evict the now-distant spare and warm the new edge.
    spareSlotsRef.current.push(current);
    activeSlotRef.current = next;
    paginatorRef.current = next.paginator;
    activeIframeRef.current = next.iframe;
    setActiveFrameVisual(next.frame as LiveReaderFrame);
    next.paginator.setNotes(props.notes);
    autoAdvanceRef.current = false;
    triggerChapterTransitionWheelLock();
    lockedReverseDirRef.current = atEnd ? 1 : -1;
    reverseLockUntilRef.current = Date.now() + 250;
    turnIntentRef.current.reset();
    if (atEnd) {
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
    const promotedState = next.paginator.getStateSnapshot();
    if (promotedState.status !== "ready") return false;
    next.state = promotedState;
    lastStateRef.current = promotedState.status;
    lastReadyEmptyRef.current = promotedState.empty;
    onPageStateRef.current(promotedState);
    // B-151：空章缓存被提升时也要走同一自动前进规则；末章空章才发布 ready。
    if (promotedState.empty && next.spineIndex !== null) {
      const nextIndex = nextLinearIndex(book, next.spineIndex, 1);
      if (nextIndex >= 0) {
        autoAdvanceRef.current = true;
        turnIntentRef.current.markLoading();
        onRequestChapterRef.current(nextIndex);
        return true;
      }
    }
    publishActiveDisplayReady();
    return true;
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
    };
    const p = buildPaginator(slot);
    activeSlotRef.current = slot;
    activeIframeRef.current = iframe;
    paginatorRef.current = p;
    setActiveFrameVisual("primary");
    return () => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const p = paginatorRef.current;
    if (!p) return;
    autoAdvanceRef.current = false;
    const path = spineItemPath(book, spineIndex);
    if (!path) {
      turnIntentRef.current.reset();
      props.onPageState({ status: "error", message: "章节资源缺失" });
      return;
    }
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
      const preciseTarget = props.preciseTarget && props.preciseTarget.chapterPath === path
        ? props.preciseTarget
        : null;
      // Promotion intentionally happens in this effect, after React has
      // committed the new spineIndex.  This keeps App's synchronous refs and
      // progress writer on the promoted chapter before ready is published.
      // Exact targets use the normal load path so resolution/highlight occur
      // inside the display gate instead of being applied to a visible cache.
      if (!preciseTarget && !explicitNavigation) {
        if (promotePreparedChapter(path, spineIndex, startAtEnd)) return;
        const inFlight = spareSlotsRef.current.find(
          (slot) => slot.path === path && slot.spineIndex === spineIndex && slot.paginator
        );
        if (
          inFlight &&
          inFlight.paginator &&
          sameRenderingSettings(inFlight.renderSettings, latestRenderSettingsRef.current)
        ) {
          const ready = await inFlight.paginator.waitForDisplayReady();
          if (ready && activeSlotRef.current?.spineIndex !== spineIndex) {
            if (promotePreparedChapter(path, spineIndex, startAtEnd)) return;
          }
        }
      }
      const activeSlot = activeSlotRef.current;
      const oldIndex = activeSlot?.spineIndex ?? null;
      const settingsChanged = activeSlot && !sameRenderingSettings(activeSlot.renderSettings, latestRenderSettingsRef.current);
      if (activeSlot) {
        activeSlot.path = path;
        activeSlot.spineIndex = spineIndex;
        activeSlot.renderSettings = latestRenderSettingsRef.current;
      }
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
      await p.load(path, {
        settings: latestRenderSettingsRef.current,
        hasNextChapter: nextLinearIndex(book, spineIndex, 1) >= 0,
        hasPrevChapter: nextLinearIndex(book, spineIndex, -1) >= 0,
        anchor: props.anchor,
        resetPage: true,
        startAtEnd,
        readingAnchor: props.initialAnchor,
        fallbackPage: preciseTarget ? null : (props.initialPage ?? null),
        preciseNavigation: preciseTarget
          ? {
              requestId: preciseTarget.requestId,
              kind: preciseTarget.kind,
              textHits: preciseTarget.textHits,
              occurrence: preciseTarget.occurrence,
            }
          : null,
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, spineIndex, props.anchorNonce, props.startAtEnd.nonce]);

  // 设置变更 → 合并后重载（阅读位置由分页器内容锚点保留；仅在实际变化时触发）。
  // 章节 effect 已先记录该次 render 的设置，因此章节切换只走一次正常 load，
  // 不会再被 settings effect 追加一个重载。
  useEffect(() => {
    const previous = settingsIdentityRef.current;
    if (!previous) {
      settingsIdentityRef.current = { settings, userFonts: props.userFonts };
      return;
    }
    const renderingUnchanged =
      sameRenderingSettings(
        effectiveReaderSettings(previous.settings, book.fixedLayout),
        effSettings,
      ) && previous.userFonts === props.userFonts;
    if (renderingUnchanged) {
      if (preloadAllowedRef.current) scheduleAdjacentPreloads();
      else {
        resetFullBookWarmup();
        disposeSpareSlots();
      }
      settingsIdentityRef.current = { settings, userFonts: props.userFonts };
      return;
    }
    // 布局代次变化：取消旧 epoch 的临时测量队列和近邻缓存。
    resetFullBookWarmup();
    disposeSpareSlots();
    settingsIdentityRef.current = { settings, userFonts: props.userFonts };
    const p = paginatorRef.current;
    if (!p) return;
    settingsReloadDebouncerRef.current?.schedule(() => {
      const current = paginatorRef.current;
      if (!current || current !== p) return;
      if (activeSlotRef.current) activeSlotRef.current.renderSettings = latestRenderSettingsRef.current;
      void current.reloadWithSettings(latestRenderSettingsRef.current);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, props.userFonts]);

  // The setting is deliberately a scheduler toggle: it must not reload the
  // active chapter, but enabling it after a ready chapter should start one
  // lazy secondary paginator once the second iframe is committed.
  useEffect(() => {
    if (preloadAllowedRef.current) scheduleAdjacentPreloads();
    else {
      resetFullBookWarmup();
      disposeSpareSlots();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const next = nextLinearIndex(book, spineIndexRef.current, 1);
        if (next >= 0) {
          triggerChapterTransitionWheelLock();
          lockedReverseDirRef.current = -1;
          reverseLockUntilRef.current = Date.now() + 250;
          sameDirThrottleUntilRef.current = Date.now() + 150;
          turnIntentRef.current.markLoading();
          props.onRequestChapter(next);
        }
      } else {
        const prev = nextLinearIndex(book, spineIndexRef.current, -1);
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
    if (immediate === 1) {
      if (p.currentPage < p.pageCount - 1) {
        triggerTurnAnimation(1);
        p.setPage(p.currentPage + 1);
      } else {
        const next = nextLinearIndex(book, spineIndexRef.current, 1);
        if (next >= 0) {
          triggerTurnAnimation(1);
          triggerChapterTransitionWheelLock();
          lockedReverseDirRef.current = -1;
          reverseLockUntilRef.current = Date.now() + 250;
          turnIntentRef.current.reset();
          props.onRequestChapter(next);
        }
      }
    } else {
      if (p.currentPage > 0) {
        triggerTurnAnimation(-1);
        p.setPage(p.currentPage - 1);
      } else {
        const prev = nextLinearIndex(book, spineIndexRef.current, -1);
        if (prev >= 0) {
          triggerTurnAnimation(-1);
          triggerChapterTransitionWheelLock();
          lockedReverseDirRef.current = 1;
          reverseLockUntilRef.current = Date.now() + 250;
          turnIntentRef.current.reset();
          props.onRequestChapter(prev, { atEnd: true });
        }
      }
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      nextPage() {
        turnPageRef.current(1);
      },
      prevPage() {
        turnPageRef.current(-1);
      },
      setPage(i: number) {
        pauseBackgroundWarmupForInput();
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
        return paginatorRef.current?.diagnose() ?? "（阅读器未初始化）";
      },
      getReadingAnchor() {
        return paginatorRef.current?.getReadingAnchor() ?? null;
      },
      resolveBookmarkPage(bookmark) {
        return paginatorRef.current?.resolveBookmarkPage?.(bookmark) ?? bookmark.page ?? null;
      },
      getAnchorText() {
        return paginatorRef.current?.getAnchorText() ?? null;
      },
      jumpToAnchor(anchor) {
        pauseBackgroundWarmupForInput();
        paginatorRef.current?.jumpToAnchor(anchor);
      },
      navigateWithinCurrentChapter(options) {
        pauseBackgroundWarmupForInput();
        const paginator = paginatorRef.current;
        if (!paginator) return false;
        const navigated = paginator.navigateWithinCurrentChapter(options);
        if (navigated) onInternalNavigationSettledRef.current();
        return navigated;
      },
      navigateToSearchTarget(request) {
        pauseBackgroundWarmupForInput();
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
      setFootnoteOverlayHover(over: boolean) {
        paginatorRef.current?.setFootnoteOverlayHover(over);
      },
      clearTextSelection() {
        paginatorRef.current?.clearTextSelection();
      },
      scrollToStart() {
        paginatorRef.current?.scrollToStart();
      },
      scrollToEnd() {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {/* 左右边缘 5% 悬停感应区与翻页指示 (Zen UI Packet C) */}
      <div
        className="edge-turn-zone edge-turn-prev"
        onClick={(e) => {
          e.stopPropagation();
          turnPageRef.current(-1);
        }}
        title="上一页"
        aria-label="上一页"
      >
        <button
          type="button"
          className="edge-turn-arrow"
          tabIndex={-1}
          aria-hidden="true"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      <div
        className="edge-turn-zone edge-turn-next"
        onClick={(e) => {
          e.stopPropagation();
          turnPageRef.current(1);
        }}
        title="下一页"
        aria-label="下一页"
      >
        <button
          type="button"
          className="edge-turn-arrow"
          tabIndex={-1}
          aria-hidden="true"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
      </div>
    </>
  );
});

export const ReaderView = forwardRef<ReaderHandle, ReaderViewProps>(function ReaderView(props, ref) {
  if (props.settings.readingMode === "scroll" && !props.book.fixedLayout) {
    return <ContinuousReaderView {...props} ref={ref} />;
  }
  return <PagedReaderView {...props} ref={ref} />;
});
