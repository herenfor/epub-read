import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Book } from "../core/types";
import { nextLinearIndex, spineItemPath } from "../core/book";
import {
  ChapterPaginator,
  type ChapterState,
  type FootnotePayload,
  type ImageActivationPayload,
  type ReaderNoteForPaginator,
  type SelectionContextPayload,
  type WithinChapterNavigationOptions,
  type PreciseNavigationRequest,
  type PreciseNavigationStatus,
} from "../render/paginator";
import type { ResourceServer } from "../render/resources";
import type { ReaderSettings } from "../render/settings";
import { createSettingsReloadDebouncer } from "./settingsReload";
import { TurnIntentBuffer, WheelTurnAccumulator } from "./turnIntent";

export interface ReaderHandle {
  nextPage(): void;
  prevPage(): void;
  setPage(i: number): void;
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
  } | null;
  /** 当前锚点元素的一行文本（书签列表展示用） */
  getAnchorText(): string | null;
  /** 跳到页内锚点（注释返回链接等） */
  jumpToAnchor(anchor: string): void;
  /** 在已完成布局的当前章节内同步导航；失败不改变位置。 */
  navigateWithinCurrentChapter(options: WithinChapterNavigationOptions): boolean;
  /** 同章精确搜索命中；失败/不支持高亮时保留当前位置并返回明确状态。 */
  navigateToSearchTarget(request: PreciseNavigationRequest): PreciseNavigationStatus;
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
  } | null;
  /** Legacy page fallback; paginator consumes it only after both anchors fail. */
  initialPage?: number | null;
}

type ReaderFrame = "primary" | "secondary" | "tertiary";

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

export const ReaderView = forwardRef<ReaderHandle, ReaderViewProps>(function ReaderView(
  props,
  ref
) {
  const { book, server, spineIndex, settings } = props;
  const primaryIframeRef = useRef<HTMLIFrameElement>(null);
  const secondaryIframeRef = useRef<HTMLIFrameElement>(null);
  const tertiaryIframeRef = useRef<HTMLIFrameElement>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);
  const activeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const paginatorRef = useRef<ChapterPaginator | null>(null);
  const activeSlotRef = useRef<PaginatorSlot | null>(null);
  // The active slot plus at most two spare slots form a tiny three-chapter
  // window: previous/current/next.  Spare slots are never allowed to emit
  // UI callbacks; their state is only used by the cache scheduler.
  const spareSlotsRef = useRef<PaginatorSlot[]>([]);
  const [activeFrame, setActiveFrame] = useState<ReaderFrame>("primary");
  const activeFrameRef = useRef<ReaderFrame>("primary");
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
  const outerScrollWheelRef = useRef(new WheelTurnAccumulator(400));
  const lockedReverseDirRef = useRef<1 | -1 | 0>(0);
  const reverseLockUntilRef = useRef(0);
  const sameDirThrottleUntilRef = useRef(0);
  const chapterTransitionLockedRef = useRef(false);
  const chapterTransitionCooldownUntilRef = useRef(0);
  const chapterTransitionQuietUntilRef = useRef(0);
  const preloadDebounceTimerRef = useRef<number | null>(null);

  const clearPreloadTimer = (): void => {
    if (preloadDebounceTimerRef.current !== null) {
      window.clearTimeout(preloadDebounceTimerRef.current);
      preloadDebounceTimerRef.current = null;
    }
  };

  /**
   * 换章滚轮手势保护（静默门禁）：
   * 必须同时满足：
   * 1. 换章已完成并展示在前台（显示门解除）；
   * 2. 距离显示就绪时刻已达到基础冷静期（350ms）；
   * 3. 距离上一次检测到的物理滚轮脉冲已静默至少 180ms（手势已完全停歇）；
   * 处于换章锁定或冷静期时，所有残余滚轮脉冲一律丢弃并清空累加器，杜绝跨章惯性串流翻页。
   */
  const isWheelGestureSuppressed = (): boolean => {
    if (!chapterTransitionLockedRef.current) return false;
    const now = Date.now();
    if (now < chapterTransitionCooldownUntilRef.current || now < chapterTransitionQuietUntilRef.current) {
      chapterTransitionQuietUntilRef.current = now + 180;
      outerWheelRef.current.reset();
      paginatorRef.current?.resetWheelAccumulator?.();
      return true;
    }
    // 基础冷却与静默期均已满足，解锁新章节滚轮交互
    chapterTransitionLockedRef.current = false;
    outerWheelRef.current.reset();
    paginatorRef.current?.resetWheelAccumulator?.();
    return false;
  };

  const triggerChapterTransitionWheelLock = (): void => {
    const now = Date.now();
    chapterTransitionLockedRef.current = true;
    // 在新章节真正 display-ready 前，锁定持续有效（先设一个兜底时间戳）
    chapterTransitionCooldownUntilRef.current = now + 400;
    chapterTransitionQuietUntilRef.current = now + 200;
    outerWheelRef.current.reset();
    paginatorRef.current?.resetWheelAccumulator?.();
  };

  const armChapterTransitionDisplaySettled = (): void => {
    const now = Date.now();
    // 新章节已完成排版并正式呈现给用户，从此时起算 350ms 冷却与 180ms 静默
    chapterTransitionCooldownUntilRef.current = now + 350;
    chapterTransitionQuietUntilRef.current = now + 180;
    outerWheelRef.current.reset();
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
  preloadAllowedRef.current = settings.preloadNextChapter === true && !book.fixedLayout;

  const isActiveSlot = (slot: PaginatorSlot): boolean =>
    activeSlotRef.current === slot && paginatorRef.current === slot.paginator && slot.paginator !== null;

  const setActiveFrameVisual = (frame: ReaderFrame): void => {
    activeFrameRef.current = frame;
    const primary = primaryIframeRef.current;
    const secondary = secondaryIframeRef.current;
    const tertiary = tertiaryIframeRef.current;
    for (const [candidate, candidateFrame] of [
      [primary, "primary" as const],
      [secondary, "secondary" as const],
      [tertiary, "tertiary" as const],
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
    if (state.status !== "ready" || state.empty) return;
    lastReadyEmptyRef.current = false;
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
        autoAdvanceRef.current = true;
        const next = nextLinearIndex(book, spineIndexRef.current, 1);
        if (next >= 0) {
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
    return tertiaryIframeRef.current;
  };

  const scheduleAdjacentPreloads = (): void => {
    // 滚动模式首版暂停备用槽调度（保留用户开关），只保持活动章一个文档。
    if (latestRenderSettingsRef.current.readingMode === "scroll") {
      disposeSpareSlots();
      return;
    }
    if (!preloadAllowedRef.current || !secondaryIframeRef.current || !tertiaryIframeRef.current) {
      disposeSpareSlots();
      return;
    }
    const active = activeSlotRef.current;
    if (!active?.paginator || active.spineIndex === null || !active.ready || active.state.status !== "ready" ||
      !sameRenderingSettings(active.renderSettings, latestRenderSettingsRef.current)) {
      return;
    }
    const wanted = [
      nextLinearIndex(book, active.spineIndex, 1),
      nextLinearIndex(book, active.spineIndex, -1),
    ].filter((index, position, values) => index >= 0 && values.indexOf(index) === position);
    const wantedPaths = new Map<number, string>();
    for (const index of wanted) {
      const path = spineItemPath(book, index);
      if (path) wantedPaths.set(index, path);
    }

    // Keep only the two adjacent chapters.  This also evicts the chapter two
    // steps away immediately after a promotion.
    for (const slot of [...spareSlotsRef.current]) {
      if (slot.spineIndex === null || !wantedPaths.has(slot.spineIndex) || slot.path !== wantedPaths.get(slot.spineIndex) ||
        !sameRenderingSettings(slot.renderSettings, latestRenderSettingsRef.current)) {
        disposeSpareSlot(slot);
      }
    }

    const usedFrames = new Set<ReaderFrame>([
      active.frame,
      ...spareSlotsRef.current.map((slot) => slot.frame),
    ]);
    for (const [index, path] of wantedPaths) {
      const existing = spareSlotsRef.current.find((slot) => slot.spineIndex === index && slot.path === path);
      if (existing?.paginator) {
        // display-ready is the cache-hit boundary.  Do not restart a chapter
        // merely because another ready callback caused the scheduler to run.
        if (existing.ready && existing.paginator.isDisplayReady) continue;
        // wanted 顺序为 next→previous；高优先级仍在准备时不启动低优先级，
        // 避免两个完整分页测量同时争抢主线程。
        if (existing.state.status === "loading" || existing.state.status === "measuring") return;
        disposeSpareSlot(existing);
        usedFrames.delete(existing.frame);
      }
      if (spareSlotsRef.current.length >= 2) break;
      const frame = (["primary", "secondary", "tertiary"] as const).find((candidate) => !usedFrames.has(candidate));
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
      const paginator = buildPaginator(slot);
      const generation = slot.generation;
      void paginator.loadAndWaitForDisplay(path, { resetPage: true }).then((ready) => {
        if (!spareSlotsRef.current.includes(slot) || slot.generation !== generation || slot.paginator !== paginator) return;
        slot.state = paginator.getStateSnapshot();
        slot.ready = ready && paginator.isDisplayReady;
        if (!slot.ready) disposeSpareSlot(slot);
        else scheduleAdjacentPreloadsDebounced(150);
      });
      // 一次只启动一个后台完整排版任务；完成后再由上面的回调准备另一侧。
      return;
    }
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
    setActiveFrameVisual(next.frame);
    next.paginator.setNotes(props.notes);
    autoAdvanceRef.current = false;
    triggerChapterTransitionWheelLock();
    lockedReverseDirRef.current = atEnd ? 1 : -1;
    reverseLockUntilRef.current = Date.now() + 600;
    turnIntentRef.current.reset();
    if (atEnd) {
      if (latestRenderSettingsRef.current.readingMode === "scroll") {
        next.paginator.scrollToEnd();
      } else {
        next.paginator.setPage(Math.max(0, next.paginator.pageCount - 1));
      }
    }
    const promotedState = next.paginator.getStateSnapshot();
    if (promotedState.status !== "ready") return false;
    next.state = promotedState;
    lastStateRef.current = promotedState.status;
    lastReadyEmptyRef.current = promotedState.empty;
    onPageStateRef.current(promotedState);
    if (!promotedState.empty) publishActiveDisplayReady();
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
      if (!preciseTarget && !explicitNavigation && promotePreparedChapter(path, spineIndex, startAtEnd)) return;
      const activeSlot = activeSlotRef.current;
      const oldIndex = activeSlot?.spineIndex ?? null;
      const settingsChanged = activeSlot && !sameRenderingSettings(activeSlot.renderSettings, latestRenderSettingsRef.current);
      if (activeSlot) {
        activeSlot.path = path;
        activeSlot.spineIndex = spineIndex;
        activeSlot.renderSettings = latestRenderSettingsRef.current;
      }
      // Adjacent-but-not-ready and non-adjacent jumps both use the original
      // P0 load path; same-chapter anchor reloads may retain valid edge caches.
      if (oldIndex !== spineIndex || settingsChanged) disposeSpareSlots();
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
      else disposeSpareSlots();
      settingsIdentityRef.current = { settings, userFonts: props.userFonts };
      return;
    }
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
    else disposeSpareSlots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.preloadNextChapter, book.fixedLayout, activeFrame]);

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
      // 反向回弹保护（单向锁 800ms）
      if (immediate === lockedReverseDirRef.current && Date.now() < reverseLockUntilRef.current) return;
      // 同向连续换章微防抖（150ms）
      if (Date.now() < sameDirThrottleUntilRef.current) return;
      if (immediate === 1) {
        const next = nextLinearIndex(book, spineIndexRef.current, 1);
        if (next >= 0) {
          lockedReverseDirRef.current = -1;
          reverseLockUntilRef.current = Date.now() + 800;
          sameDirThrottleUntilRef.current = Date.now() + 150;
          turnIntentRef.current.markLoading();
          props.onRequestChapter(next);
        }
      } else {
        const prev = nextLinearIndex(book, spineIndexRef.current, -1);
        if (prev >= 0) {
          lockedReverseDirRef.current = 1;
          reverseLockUntilRef.current = Date.now() + 800;
          sameDirThrottleUntilRef.current = Date.now() + 150;
          turnIntentRef.current.markLoading();
          props.onRequestChapter(prev, { atEnd: true });
        }
      }
      return;
    }
    if (immediate === 1) {
      if (p.currentPage < p.pageCount - 1) {
        p.setPage(p.currentPage + 1);
      } else {
        const next = nextLinearIndex(book, spineIndexRef.current, 1);
        if (next >= 0) {
          triggerChapterTransitionWheelLock();
          lockedReverseDirRef.current = -1;
          reverseLockUntilRef.current = Date.now() + 600;
          turnIntentRef.current.reset();
          props.onRequestChapter(next);
        }
      }
    } else {
      if (p.currentPage > 0) {
        p.setPage(p.currentPage - 1);
      } else {
        const prev = nextLinearIndex(book, spineIndexRef.current, -1);
        if (prev >= 0) {
          triggerChapterTransitionWheelLock();
          lockedReverseDirRef.current = 1;
          reverseLockUntilRef.current = Date.now() + 600;
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
        paginatorRef.current?.setPage(i);
      },
      diagnose() {
        return paginatorRef.current?.diagnose() ?? "（阅读器未初始化）";
      },
      getReadingAnchor() {
        return paginatorRef.current?.getReadingAnchor() ?? null;
      },
      getAnchorText() {
        return paginatorRef.current?.getAnchorText() ?? null;
      },
      jumpToAnchor(anchor) {
        paginatorRef.current?.jumpToAnchor(anchor);
      },
      navigateWithinCurrentChapter(options) {
        const paginator = paginatorRef.current;
        if (!paginator) return false;
        const navigated = paginator.navigateWithinCurrentChapter(options);
        if (navigated) onInternalNavigationSettledRef.current();
        return navigated;
      },
      navigateToSearchTarget(request) {
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
        className="reader"
        data-overlay-input={overlayInputActive ? "true" : undefined}
        onWheel={(event) => {
          if (overlayInputActive) return;
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
            reverseLockUntilRef.current = Date.now() + 800;
            sameDirThrottleUntilRef.current = Date.now() + 150;
            event.preventDefault();
            turnPageRef.current(direction);
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
      </div>
    </>
  );
});
