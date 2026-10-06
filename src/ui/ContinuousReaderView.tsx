import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Book, TocNode } from "../core/types";
import { nextLinearIndex, spineItemPath } from "../core/book";
import { splitHref } from "../core/paths";
import {
  ChapterPaginator,
  type ChapterState,
  type FootnotePayload,
  type ImageActivationPayload,
  type MediaReadingAnchor,
  type MediaAnchorAndContentY,
  type ReaderNoteForPaginator,
  type SelectionContextPayload,
  type WithinChapterNavigationOptions,
  type PreciseNavigationRequest,
  type PreciseNavigationStatus,
  type ReadingAnchor,
  type ReadingAnchorAndContentY,
  type ResolvedContentFraction,
} from "../render/paginator";
import type { ResourceServer } from "../render/resources";
import type { ReaderSettings } from "../render/settings";
import {
  ContinuousChapterLayout,
  ChapterLoadGate,
  PendingScrollNavigation,
  continuousFrameBleed,
  continuousWheelPixels,
  type ChapterExtent,
  type ChapterProjection,
  type ChapterLoadTicket,
  type ContinuousAnchor,
  type ScrollNavigationTicket,
} from "./continuousChapterLayout";
import { CHAPTER_KEY_ATTRIBUTE, commitContinuousGeometry } from "./continuousGeometryCommit";
import { classifyChapterMeasurement } from "./continuousChapterGeometry";
import type { PersistedNavigationAnchor } from "../render/navigationAnchor";
import { DampedScrollAnimator } from "./dampedScroll";
import { createSettingsReloadDebouncer } from "./settingsReload";
import type { ScrubToken } from "./readerProgressAxis";
import {
  continuousReadingLine,
  commitExplicitPosition,
  acceptPositionSample,
  releaseExplicitPosition,
  rebasePosition,
  type ReadingPositionSnapshot,
} from "./bookmarkReadingPosition";
import {
  effectiveReaderSettings,
  sameRenderingSettings,
  type ReaderHandle,
} from "./ReaderView";

export interface ContinuousReaderViewProps {
  book: Book;
  server: ResourceServer;
  spineIndex: number;
  anchor?: string;
  anchorNonce: number;
  settings: ReaderSettings;
  userFonts: Array<{ family: string; url: string }>;
  notes: ReaderNoteForPaginator[];
  onPageState(s: ChapterState): void;
  onDisplayReady(): void;
  onRequestChapter(index: number, opts?: { atEnd?: boolean }): void;
  startAtEnd: { nonce: number; atEnd: boolean };
  onIssues(issues: string[]): void;
  onInternalLink(href: string): void;
  onBeforeInternalNavigate(href: string): void;
  onInternalNavigationSettled(): void;
  onExternalLink(url: string): void;
  onFootnote(payload: FootnotePayload): void;
  onFootnoteClose(): void;
  onSelectionContextMenu?(payload: SelectionContextPayload | null): void;
  preciseTarget?: (PreciseNavigationRequest & { chapterPath: string }) | null;
  onImageActivation?(image: ImageActivationPayload): void;
  inputPaused?: boolean;
  /** 手机普通轻点：显隐阅读工具；连续模式不在 iframe 内阻止默认行为。 */
  onPlainTap?: () => void;
  onPreciseNavigationStatus?(status: {
    requestId: number;
    status: PreciseNavigationStatus;
    exact: boolean;
  }): void;
  /** 语义锚点解析失败时结束 busy 且不冒充成功；reported 表示已发精确状态。 */
  onNavigationUnresolved?(reported: boolean): void;
  /** 通知宿主恢复失败定位后的进度保存，不通过采样比例推断用户输入。 */
  onUserReadingPositionChange?(): void;
  initialAnchor?: {
    index: number;
    ratio: number;
    anchorTextOffset: number | null;
    anchorTextSnippet: string | null;
    /** B-155：纯图片页可选的媒体身份锚点，与文本锚点二选一优先文本。 */
    mediaAnchor?: MediaReadingAnchor | null;
  } | null;
  initialPage?: number | null;
  /** 连续模式恢复初始对齐：reading-line 对齐到 20% 阅读线（书签恢复专用），context 对齐到顶部微小 inset（默认） */
  initialAlignment?: "reading-line" | "context";
  /** 视口上方约 20% 阅读线采样观察到的章节变化；只更新状态，不触发重载 */
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

interface ActiveSlot {
  key: string;
  spineIndex: number;
  path: string;
  iframe: HTMLIFrameElement;
  paginator: ChapterPaginator;
  ticket: ChapterLoadTicket;
  status: "loading" | "ready" | "error";
  renderSettings: ReaderSettings;
  unmounted?: boolean;
}

interface LinearSpineItem {
  idref: string;
  linear: boolean;
  index: number;
  path: string;
  key: string;
}

/** 测量未就绪（容器尚未布局）时的按帧重测上限，避免极端情况下无限重试。 */
const MEASURE_RETRY_LIMIT = 180;

/** 视口上方 20% 是连续阅读的“阅读线”，锚点采样与状态展示共用同一位置。 */
const READING_LINE_RATIO = 0.2;

/** 连续阅读的宿主层章间 gap；默认布局常量，不新增设置项。 */
const CONTINUOUS_CHAPTER_GAP_PX = 24;

/** 显式导航在屏幕上希望目标出现的位置；搜索/笔记沿用 paginator 的小 inset。 */
function desiredScreenInset(viewportHeight: number): number {
  return Math.round(Math.min(24, Math.max(0, viewportHeight * 0.04)));
}

/**
 * B-155：显式滚动导航的不可变目标。章节装载、重排期间票据保留；宿主
 * 只在目标 display-ready 后解析内容坐标并一次提交外层 scrollTop。
 */
type ContinuousNavigationTarget =
  | { kind: "start" }
  | { kind: "fragment"; fragment: string }
  | {
      kind: "anchor";
      anchor: PersistedNavigationAnchor | null;
      mediaAnchor?: MediaReadingAnchor | null;
      fallbackPage?: number | null;
      alignment?: "reading-line" | "context";
    }
  | {
      kind: "note";
      requestId: number;
      anchor: PersistedNavigationAnchor | null;
      mediaAnchor?: MediaReadingAnchor | null;
      fallbackPage?: number | null;
    }
  | {
      kind: "search";
      request: PreciseNavigationRequest & { chapterPath?: string };
    }
  | {
      kind: "content-fraction";
      fraction: number;
      token: ScrubToken;
    };

interface PendingContinuousNavigation {
  readonly ticket: ScrollNavigationTicket<ContinuousNavigationTarget>;
  /** 最近一次解析使用的布局代次；布局变化后同一票据重解析。 */
  measuredRevision: number;
}

/**
 * 一次稳定的阅读位置。
 *
 * `offset`/`screenY` 是同一内容点在“章内内容坐标 / 宿主屏幕坐标”的配对：
 * 重排后用 `withMeasurements` 把该内容点放回同一屏幕行。`text` 是同一位置的
 * 文本锚点（纯图片页为 null），用于章内上方内容增高时重新求 `offset`；
 * `media` 是纯图片页的图内比例锚点（有文本锚点时恒为 null），两者互斥。
 */
interface ReadingSpot {
  key: string;
  offset: number;
  screenY: number;
  scrollTop: number;
  text: ReadingAnchor | null;
  media: MediaReadingAnchor | null;
}

/** 无文字可锚定时的章内像素锚点（仅首次加载、媒体也未就绪时使用）。 */
function pixelSpot(
  key: string,
  offset: number,
  screenY: number,
  scrollTop: number
): ReadingSpot {
  return { key, offset, screenY, scrollTop, text: null, media: null };
}

/** 阅读线采样：文本锚点与图内比例锚点互斥，同时为空时由调用方退回像素锚点。 */
interface ReadingSample {
  fine: ReadingAnchorAndContentY | null;
  media: MediaAnchorAndContentY | null;
}

function findChapterTitle(nodes: readonly TocNode[] | undefined, path: string): string | null {
  if (!nodes) return null;
  for (const node of nodes) {
    const nodePath = splitHref(node.href).path;
    if (nodePath === path) return node.label;
    const child = findChapterTitle(node.children, path);
    if (child) return child;
  }
  return null;
}

export const ContinuousReaderView = forwardRef<ReaderHandle, ContinuousReaderViewProps>(
  function ContinuousReaderView(props, ref) {
    const {
      book,
      server,
      spineIndex,
      settings,
      notes,
      inputPaused,
      preciseTarget,
      onVisibleChapterChange,
      onPageState,
      onDisplayReady,
      onIssues,
      onInternalLink,
      onBeforeInternalNavigate,
      onInternalNavigationSettled,
      onExternalLink,
      onFootnote,
      onFootnoteClose,
      onSelectionContextMenu,
      onImageActivation,
      onPreciseNavigationStatus,
    } = props;

    const inputPausedRef = useRef(inputPaused === true);
    inputPausedRef.current = inputPaused === true;
    const onPlainTapRef = useRef(props.onPlainTap);
    onPlainTapRef.current = props.onPlainTap;
    const containerRef = useRef<HTMLDivElement>(null);
    /** 显式总高的 canvas：几何提交必须先于宿主 scrollTop，见 commitContinuousGeometry。 */
    const canvasRef = useRef<HTMLDivElement>(null);
    const onInternalNavigationSettledRef = useRef(props.onInternalNavigationSettled);
    onInternalNavigationSettledRef.current = props.onInternalNavigationSettled;
    const onNavigationUnresolvedRef = useRef(props.onNavigationUnresolved);
    onNavigationUnresolvedRef.current = props.onNavigationUnresolved;
    const onUserReadingPositionChangeRef = useRef(props.onUserReadingPositionChange);
    onUserReadingPositionChangeRef.current = props.onUserReadingPositionChange;
    const [viewportHeight, setViewportHeight] = useState(600);
    // 宿主宽度只用于识别“需要重排的尺寸变化”，iframe 宽度仍是容器的 100%
    const [viewportWidth, setViewportWidth] = useState(0);
    const viewportHeightRef = useRef(viewportHeight);
    viewportHeightRef.current = viewportHeight;

    // 线性阅读顺序章节清单与稳定 key（spineIndex:path）
    const linearItems: LinearSpineItem[] = useMemo(() => {
      return book.spine
        .map((item, originalIndex) => {
          const path = spineItemPath(book, originalIndex);
          return path ? { ...item, index: originalIndex, path, key: `${originalIndex}:${path}` } : null;
        })
        .filter((item): item is LinearSpineItem => item !== null && item.linear !== false);
    }, [book]);

    // 检查当前请求的 spineIndex 是否属于 linear=no 的辅助章节
    const currentSpineItem = book.spine[spineIndex];
    const isLinearNoChapter = currentSpineItem?.linear === false;

    // 线性章节初始高度估算表（未测量时为 1V）
    // 变化只跟随换书/章节清单：宿主尺寸变化不得重建整张表，否则已测高度
    // 会被全部清空成估值，窗口 resize 时整本书的位置与总高都会跳。
    const initialExtents: ChapterExtent[] = useMemo(() => {
      const estimate = viewportHeightRef.current > 0 ? viewportHeightRef.current : 600;
      return linearItems.map((item) => ({
        key: `${item.index}:${item.path}`,
        height: estimate,
        measured: false,
      }));
    }, [linearItems]);

    const [layout, setLayout] = useState(
      () => new ContinuousChapterLayout(initialExtents, CONTINUOUS_CHAPTER_GAP_PX)
    );
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    /** 布局代次：显式导航票据提交前用它证明“当前解析基于最新几何”。 */
    const layoutRevisionRef = useRef(0);
    /** 每本书一个递增会话号；不能只靠书 ID 防止旧书票据提交。 */
    const bookSessionRef = useRef(0);
    const pendingNavigationRef = useRef<
      PendingScrollNavigation<ContinuousNavigationTarget> | null
    >(null);
    if (!pendingNavigationRef.current) {
      pendingNavigationRef.current = new PendingScrollNavigation<ContinuousNavigationTarget>();
    }
    const pendingNavigationMetaRef = useRef<PendingContinuousNavigation | null>(null);
    /** 票据已在 commit 批次内失败结算时，防止调用方再补一次成功 onDisplayReady。 */
    const pendingNavigationFailureRef = useRef(false);
    /** 打开书/书签/历史返回的语义锚点每次会话只应用一次。 */
    const initialNavigationHandledRef = useRef(false);

    // 监听换书/线性 spine 变化重新初始化 layout（尺寸变化走重排事务）
    useEffect(() => {
      const estimate = viewportHeightRef.current > 0 ? viewportHeightRef.current : 600;
      const extents = linearItems.map((item) => ({
        key: `${item.index}:${item.path}`,
        height: estimate,
        measured: false,
      }));
      const next = new ContinuousChapterLayout(extents, CONTINUOUS_CHAPTER_GAP_PX);
      layoutRef.current = next;
      setLayout(next);
      layoutRevisionRef.current += 1;
      pendingSpotRef.current = null;
      lastStableSpotRef.current = null;
      readingPositionRef.current = null;
    }, [book, linearItems]);

    // 换书/离开阅读器取消未提交的显式导航，避免旧 session 在 async 后提交。
    useEffect(() => {
      bookSessionRef.current += 1;
      readingPositionRef.current = null;
      const ticket = pendingNavigationRef.current?.current();
      pendingNavigationRef.current?.cancel();
      pendingNavigationMetaRef.current = null;
      if (ticket?.target.kind === "content-fraction") {
        props.onContentFractionCancelled?.(ticket.target.token);
      }
      initialNavigationHandledRef.current = false;
      return () => {
        const t = pendingNavigationRef.current?.current();
        pendingNavigationRef.current?.cancel();
        pendingNavigationMetaRef.current = null;
        if (t?.target.kind === "content-fraction") {
          props.onContentFractionCancelled?.(t.target.token);
        }
      };
    }, [book]);

    const gateRef = useRef(new ChapterLoadGate());
    const slotsRef = useRef(new Map<string, ActiveSlot>());
    const retryCountersRef = useRef(new Map<string, number>());
    const [slotUpdateNonce, setSlotUpdateNonce] = useState(0);

    // 章节高度测量重试：容器可见后重测，避免把 0 高度提交进布局
    const measureFrameRef = useRef(new Map<string, number>());
    const measuringRef = useRef(new Set<string>());
    const measureRetriesRef = useRef(new Map<string, number>());
    const checkVisibleChapterRef = useRef<(() => void) | null>(null);

    // 宿主滚轮/视口跳转的阻尼动画（B-134 手感）
    const dampedScrollRef = useRef(
      new DampedScrollAnimator({
        request: (callback) => window.requestAnimationFrame(callback),
        cancel: (handle) => window.cancelAnimationFrame(handle),
      })
    );

    // 设置变更重载：已挂载章节必须用新主题/字号重新 sanitize，否则书页主题不跟随
    const settingsIdentityRef = useRef<ReaderSettings | null>(null);
    const settingsReloadDebouncerRef = useRef<ReturnType<typeof createSettingsReloadDebouncer> | null>(null);
    if (!settingsReloadDebouncerRef.current) {
      settingsReloadDebouncerRef.current = createSettingsReloadDebouncer(150);
    }
    const reloadingRef = useRef(new Set<string>());
    const desiredSettingsRef = useRef(effectiveReaderSettings(settings, false));
    const reloadSlotSettingsRef = useRef<(slot: ActiveSlot) => Promise<void>>(async () => {});
    const projectionsRef = useRef<ChapterProjection[]>([]);
    // linear=no 辅助章节的单章 paginator（设置变更时用 key 重建，需显式销毁旧的）
    const auxPaginatorRef = useRef<ChapterPaginator | null>(null);

    // 重排补偿：上次稳定阅读位置、待用锚点与合并重测的帧调度
    const lastStableSpotRef = useRef<ReadingSpot | null>(null);
    const readingPositionRef = useRef<ReadingPositionSnapshot<ReadingSpot> | null>(null);
    const pendingSpotRef = useRef<ReadingSpot | null>(null);
    const layoutRemeasureFrameRef = useRef<number | null>(null);
    const layoutRemeasureRetriesRef = useRef(0);
    /**
     * paginator 的重排完成回调只注册一次，转发到最新实现：
     * 若直接把当时的闭包交给 paginator，旧槽位会一直用创建时的 V 与几何。
     */
    const layoutSettledRef = useRef<(key: string) => void>(() => {});
    /**
     * 长生命周期回调（首次 ready、按帧重试、重排提交、外部滚轮适配器）只注册
     * 一次，全部转发到最新实现。react 生成新回调不会替换已注册在旧 paginator
     * 中的函数，只加 useCallback 依赖无法修复这类旧闭包（R4）。
     */
    const commitLayoutBatchRef = useRef<(updates: ChapterExtent[], spot: ReadingSpot | null) => void>(
      () => {}
    );
    /** 每次布局提交后尝试一次性结清等待装载/重排的显式导航票据。 */
    const resolvePendingNavigationRef = useRef<(changedKey?: string) => boolean>(() => false);
    const commitChapterMeasurementRef = useRef<
      (key: string, paginator: ChapterPaginator, ticket: ChapterLoadTicket, sameChapterReload?: boolean) => boolean
    >(() => true);
    const scheduleChapterMeasurementRef = useRef<
      (key: string, paginator: ChapterPaginator, ticket: ChapterLoadTicket) => void
    >(() => {});
    const externalScrollHandlersRef = useRef<{
      onWheelPixels: (deltaY: number) => void;
      onViewportStep: (direction: 1 | -1) => void;
    }>({ onWheelPixels: () => {}, onViewportStep: () => {} });
    /** 已应用过的宿主尺寸；相同的值不得重复触发整轮重排 */
    const appliedHostSizeRef = useRef<{ width: number; height: number } | null>(null);

    // 容器尺寸监听（宽高都要观察：宽度变化同样会让书内文字与图片重排）
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const ro = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (!rect) return;
        const h = Math.round(rect.height);
        const w = Math.round(rect.width);
        setViewportHeight((prev) => (h > 0 && Math.abs(h - prev) > 1 ? h : prev));
        setViewportWidth((prev) => (w > 0 && Math.abs(w - prev) > 1 ? w : prev));
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // 有界窗口投影计算
    const V = viewportHeight > 0 ? viewportHeight : 600;
    // 资源预算已超时收缩后台预读窗口：只保留真正可见章，先让 LRU 有机会
    // 淘汰已离开投影区的无主资源；当前可见章仍允许暂时超预算。
    const mediaBudgetExceeded = server.mediaCacheBudgetExceeded;
    const overscan = mediaBudgetExceeded ? 0 : settings.preloadNextChapter === true ? 1.5 * V : 0.5 * V;
    // iframe 上下缓冲：宿主滚动由合成线程先行，iframe 位置要等下一次 JS 同步，
    // 没有缓冲时这一两帧会在顶部/底部露出背景，看起来像边距在伸缩。
    const frameBleed = continuousFrameBleed(V);
    const initialTargetScrollTop = useMemo(() => {
      if (spineIndex <= 0) return 0;
      const path = spineItemPath(book, spineIndex);
      if (!path) return 0;
      const box = layout.boxFor(`${spineIndex}:${path}`);
      return box ? layout.clampScrollTop(box.top, V) : 0;
    }, [book, layout, spineIndex, V]);
    const [currentScrollTop, setCurrentScrollTop] = useState(initialTargetScrollTop);
    const scrollTopRef = useRef(initialTargetScrollTop);

    useLayoutEffect(() => {
      if (initialTargetScrollTop > 0 && containerRef.current && containerRef.current.scrollTop === 0) {
        containerRef.current.scrollTop = initialTargetScrollTop;
      }
    }, [initialTargetScrollTop]);

    const projections = useMemo(() => {
      return layout.project(scrollTopRef.current, V, overscan, frameBleed);
    }, [layout, V, overscan, frameBleed, currentScrollTop]);
    projectionsRef.current = projections;

    // 同步投影更新到活动 iframe DOM（不等待 React 渲染，确保 60fps 零延迟）
    const syncProjectionDoms = useCallback((projList: ChapterProjection[]) => {
      for (const p of projList) {
        const slot = slotsRef.current.get(p.box.key);
        if (slot?.iframe) {
          slot.iframe.style.top = `${p.frameOffset}px`;
          slot.paginator.projectContinuousScroll(p.innerScrollTop);
        }
      }
    }, []);

    // 滚动事件处理
    const lastVisibleKeyRef = useRef<string | null>(null);
    const scrollRafRef = useRef<number | null>(null);

    /**
     * 阅读线采样：文本锚点可用时取文本；纯图片页（命中媒体但 textOffset 为 null）
     * 取图内比例锚点。两者都失败才由调用方退回章内像素锚点。
     */
    const sampleReadingLine = useCallback((slot: ActiveSlot, localY: number): ReadingSample => {
      const fine = slot.paginator.getReadingAnchorAt(localY);
      // 纯图片页同样会返回 anchor，但 textOffset 为 null：只有带文本偏移的锚点
      // 才能跨重排解析回同一行文字，其余情况都必须保存图内比例。
      const hasTextAnchor = Boolean(fine?.anchor && fine.anchor.textOffset !== null);
      const media = hasTextAnchor ? null : slot.paginator.getMediaAnchorAt(localY);
      return { fine, media };
    }, []);

    /**
     * 把一次采样配成“内容坐标 + 真实屏幕坐标”的稳定阅读点。
     *
     * - 文本锚点优先：`getReadingAnchorAt` 的 `contentY` 是采样线坐标，不等于
     *   字形位置，必须用字形的内容坐标配它真正的屏幕坐标，否则重排会把命中到
     *   的最近文字搬到采样线，产生一屏内的跳动。
     * - 纯图片页用媒体身份 + 图内比例：窗口宽度改变会让图片实际高度变化，
     *   只保存章内像素位置会把读者送到图尾或下一章。
     * - 章尚未就绪或两种锚点都取不到时退回像素锚点，只作为首次加载兜底。
     */
    const buildReadingSpot = useCallback(
      (
        key: string,
        slot: ActiveSlot,
        projection: ChapterProjection | undefined,
        S: number,
        sample: ReadingSample,
        fallback: { offset: number; screenY: number }
      ): ReadingSpot => {
        if (!projection) return pixelSpot(key, fallback.offset, fallback.screenY, S);
        const clampTop = layoutRef.current.clampScrollTop(S, V);
        const { fine, media } = sample;
        if (fine) {
          const glyphY = fine.anchor ? slot.paginator.resolveAnchorContentY(fine.anchor) : null;
          const offset = glyphY !== null ? glyphY : fine.contentY;
          if (fine.anchor) {
            return {
              key,
              offset,
              screenY: projection.box.top + offset - clampTop,
              scrollTop: S,
              text: fine.anchor,
              media: null,
            };
          }
        }
        if (media) {
          return {
            key,
            offset: media.contentY,
            screenY: projection.box.top + media.contentY - clampTop,
            scrollTop: S,
            text: null,
            media: media.anchor,
          };
        }
        if (fine) return pixelSpot(key, fine.contentY, fallback.screenY, S);
        return pixelSpot(key, fallback.offset, fallback.screenY, S);
      },
      [V]
    );

    const checkVisibleChapter = useCallback(() => {
      // 恢复目标未提交前，可见的只是估算落点/邻章，不能覆盖 App 的目标章节与进度。
      if (pendingNavigationRef.current?.current()) return;
      const el = containerRef.current;
      if (!el) return;
      const S = el.scrollTop;
      const readingLineY = READING_LINE_RATIO * V;

      const explicitSnapshot = readingPositionRef.current;
      const isExplicitActive =
        explicitSnapshot !== null &&
        explicitSnapshot.session === bookSessionRef.current &&
        explicitSnapshot.source === "explicit";

      let activeKey: string;
      let activeOffset: number;
      let activeScreenY: number;
      let sampleFine: ReadingAnchorAndContentY | null = null;
      let sampleMedia: MediaAnchorAndContentY | null = null;

      if (isExplicitActive) {
        activeKey = explicitSnapshot.chapterKey;
        activeOffset = explicitSnapshot.value.offset;
        activeScreenY = explicitSnapshot.value.screenY;
        if (explicitSnapshot.value.text) {
          sampleFine = {
            anchor: explicitSnapshot.value.text,
            contentY: explicitSnapshot.value.offset,
          };
        }
        if (explicitSnapshot.value.media) {
          sampleMedia = {
            anchor: explicitSnapshot.value.media,
            contentY: explicitSnapshot.value.offset,
          };
        }
      } else {
        const anchor = layoutRef.current.anchorAt(S, V, readingLineY);
        if (!anchor) return;
        activeKey = anchor.key;
        activeOffset = anchor.offset;
        activeScreenY = anchor.screenY;
      }

      const slot = slotsRef.current.get(activeKey);
      if (slot && slot.status === "ready") {
        // 用当前布局表现算投影：React state 里的 projections 可能落后一帧，
        // 会让“上次稳定锚点”的章内坐标失真。
        const p = layoutRef.current
          .project(S, V, overscan, frameBleed)
          .find((item) => item.box.key === activeKey);
        const frameScreenTop = p ? p.frameScreenTop : 0;

        let sample: ReadingSample;
        if (isExplicitActive) {
          sample = { fine: sampleFine, media: sampleMedia };
          lastStableSpotRef.current = explicitSnapshot.value;
        } else {
          sample = sampleReadingLine(slot, readingLineY - frameScreenTop);
          // 保存“上次稳定”的阅读位置：重排与图片晚加载补偿都只能用这个
          // 稳定锚点，不能在已变化的几何里重新挑一个“当前内容”。
          // 事务进行中的采样同样属于“已变化、未提交”，必须丢弃而不是覆盖保存点。
          if (!pendingSpotRef.current && reloadingRef.current.size === 0 && slot.paginator.isMeasuredForViewport()) {
            const spot = buildReadingSpot(
              activeKey,
              slot,
              p,
              S,
              sample,
              { offset: activeOffset, screenY: activeScreenY }
            );
            lastStableSpotRef.current = spot;
            readingPositionRef.current = acceptPositionSample(
              readingPositionRef.current,
              {
                session: bookSessionRef.current,
                chapterKey: activeKey,
                source: "sampled",
                value: spot,
              }
            );
          }
        }

        // 章节已就绪与能否采到文本/媒体锚点是两回事：作者留白也要结束 loading。
        const state = slot.paginator.getStateSnapshot();
        if (state.status !== "ready") return;
        if (lastVisibleKeyRef.current !== activeKey) {
          lastVisibleKeyRef.current = activeKey;
          onVisibleChapterChange?.(slot.spineIndex, sample.fine ? sample.fine.anchor : null);
        }
        const maxS = layoutRef.current.maxScrollTop(V);
        const totalProgress = maxS > 0 ? Math.min(1, Math.max(0, S / maxS)) : 0;
        const isAtScrollEnd = maxS > 0 ? S >= maxS - 2 : false;
        const isLastLinear = linearItems.length > 0 && linearItems[linearItems.length - 1].key === slot.key;
        const atEnd = isLastLinear && isAtScrollEnd;

        let chapterFraction: number | null = null;
        if (sample.fine && sample.fine.anchor && sample.fine.anchor.textOffset !== null) {
          const totalChars = slot.paginator.totalChars;
          chapterFraction = totalChars > 0 ? sample.fine.anchor.textOffset / totalChars : 0;
        } else if (sample.media && sample.media.anchor) {
          const M = slot.paginator.mediaUnits > 0 ? slot.paginator.mediaUnits : 1;
          chapterFraction = (sample.media.anchor.index + sample.media.anchor.ratio) / M;
        }

        onPageState?.({
          status: "ready",
          pageCount: 1,
          currentPage: 0,
          empty: state.empty,
          mode: "scroll",
          // 阅读线在本章中的纵向比例；anchor.ratio 是文字盒内的横向位置。
          scrollProgress: p && p.box.height > 0
            ? Math.min(1, Math.max(0, activeOffset / p.box.height))
            : 0,
          totalScrollProgress: totalProgress,
          atEnd,
        });

        if (chapterFraction !== null) {
          props.onUserProgressSample?.({
            key: slot.key,
            spineIndex: slot.spineIndex,
            fraction: chapterFraction,
            atEnd,
          });
        }
      }
    }, [V, buildReadingSpot, frameBleed, linearItems, onPageState, onVisibleChapterChange, overscan, props, sampleReadingLine]);
    checkVisibleChapterRef.current = checkVisibleChapter;

    /** 把宿主已确定的最新滚动位置同步到投影与章节状态。 */
    const syncToScrollTop = useCallback(
      (S: number, userScroll = false) => {
        const previousS = scrollTopRef.current;
        // B-157：在外层实际用户位移发生时关闭所有活动槽的固定弹注；必须在
        // 更新 ref 之前判断，后续同值原生 scroll 事件不会重复关闭。
        // 程序化几何补偿和投影同步传 userScroll=false，不当作用户滚动。
        const movedByUser = userScroll && Math.abs(S - previousS) > 0.5;
        if (movedByUser) {
          readingPositionRef.current = releaseExplicitPosition(readingPositionRef.current);
          onUserReadingPositionChangeRef.current?.();
          for (const slot of slotsRef.current.values()) {
            slot.paginator.closeForNavigation();
          }
          // 用户真实滚动优先于未提交的显式导航，取消票据并结束 busy。
          if (pendingNavigationMetaRef.current) {
            const cancelledTicket = pendingNavigationRef.current?.current();
            pendingNavigationRef.current?.cancel();
            pendingNavigationMetaRef.current = null;
            if (cancelledTicket?.target.kind === "content-fraction") {
              props.onContentFractionCancelled?.(cancelledTicket.target.token);
            }
            onInternalNavigationSettledRef.current?.();
          }
        }
        // 用户在等待重排时仍可滚动：移动保存点的屏幕位置，不用尚未提交的
        // 新 DOM 重新命中另一段文字。程序化补偿不再次累计这段位移。
        // 未排入重测事务时不得篡改稳定锚点 screenY，避免滚轮累积成巨大负坐标。
        if (userScroll && movedByUser && pendingSpotRef.current) {
          const spot = pendingSpotRef.current;
          pendingSpotRef.current = {
            ...spot,
            screenY: spot.screenY - (S - spot.scrollTop),
            scrollTop: S,
          };
        }
        scrollTopRef.current = S;
        const currentProjections = layoutRef.current.project(S, V, overscan, frameBleed);
        syncProjectionDoms(currentProjections);

        if (scrollRafRef.current === null) {
          scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = null;
            // 合并帧必须消费排入时之后可能更新的位置：同一帧里 resize 补偿
            // 提交的新 S 若被排入时捕获的旧值覆盖，React 会把位置拉回去。
            setCurrentScrollTop(scrollTopRef.current);
            checkVisibleChapterRef.current?.();
          });
        }
      },
      [V, checkVisibleChapter, overscan, frameBleed, syncProjectionDoms]
    );

    const handleHostScroll = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      syncToScrollTop(el.scrollTop, true);
    }, [syncToScrollTop]);

    /**
     * 采样当前阅读位置。布局表尚未提交时它仍描述旧几何，因此必须在改动
     * iframe 尺寸之前调用；章节未就绪时退化为纯像素锚点（无文本锚点）。
     *
     * 尺寸事务优先复用 `lastStableSpotRef`（变化前的稳定样本），本方法只作为
     * 首次加载、无稳定样本或用户确实在等待期间滚动时的兜底。
     */
    const captureReadingSpot = useCallback((): ReadingSpot | null => {
      const el = containerRef.current;
      if (!el) return null;
      const S = el.scrollTop;
      const base = layoutRef.current.anchorAt(S, V, READING_LINE_RATIO * V);
      if (!base) return null;
      const slot = slotsRef.current.get(base.key);
      const projection = layoutRef.current
        .project(S, V, overscan, frameBleed)
        .find((p) => p.box.key === base.key);
      const fallback = { offset: base.offset, screenY: base.screenY };
      if (!slot || slot.status !== "ready" || !projection) {
        return pixelSpot(base.key, fallback.offset, fallback.screenY, S);
      }
      const sample = sampleReadingLine(slot, READING_LINE_RATIO * V - projection.frameScreenTop);
      return buildReadingSpot(base.key, slot, projection, S, sample, fallback);
    }, [V, buildReadingSpot, overscan, frameBleed, sampleReadingLine]);

    /**
     * 一次批量高度提交：新的占位高度、宿主 scrollTop 与 iframe 投影在同一帧
     * 生效。锚点用内容点而非滚动数字：章内上方内容增高时用文本锚点重新求
     * `y'`；用户已滚动过则改用最近输入的位置，不提交旧锚点。
     *
     * 提交顺序是硬约束：`setLayout` 只是排队渲染，必须先由
     * `commitContinuousGeometry` 把 canvas/wrapper 几何同步写进 DOM，再写
     * 宿主 scrollTop；否则书尾附近的新位置会被**旧**最大滚动值截断，而稍后
     * canvas 变高也补不回丢失的位移（R1）。
     */
    const commitLayoutBatch = useCallback(
      (updates: ChapterExtent[], spot: ReadingSpot | null) => {
        const el = containerRef.current;
        const currentS = el?.scrollTop ?? 0;
        const effective = spot;
        let anchor: ContinuousAnchor | null;
        if (!effective) {
          anchor = layoutRef.current.anchorAt(currentS, V, READING_LINE_RATIO * V);
        } else {
          let offset = effective.offset;
          let resolveFailed = false;
          const measuredHere = updates.some((update) => update.key === effective!.key);
          const slot = measuredHere ? slotsRef.current.get(effective.key) : undefined;
          if (slot && effective.text) {
            // 同一文本位置在新几何里的字形坐标：宽度变化导致换行时，
            // 旧像素位置不足以保持同一行文字（R2）。
            const resolved = slot.paginator.resolveAnchorContentY(effective.text);
            if (resolved !== null) offset = resolved;
            else if (measuredHere) resolveFailed = true;
          } else if (slot && effective.media) {
            // 纯图片页：用图内比例在缩放后的实际图高上重建（R3）。
            const resolved = slot.paginator.resolveMediaAnchorContentY(effective.media);
            if (resolved !== null) offset = resolved;
            else if (measuredHere) resolveFailed = true;
          }
          anchor = { key: effective.key, offset, screenY: effective.screenY };
          if (resolveFailed && readingPositionRef.current?.session === bookSessionRef.current) {
            readingPositionRef.current = releaseExplicitPosition(readingPositionRef.current);
          }
        }
        const pendingTarget = pendingNavigationRef.current?.current();
        if (pendingTarget) {
          // 前置章节测出真实高度时继续让待恢复章处于装载窗口，避免估算 S
          // 留在前章而使目标被回收。精确内容位置在目标 ready 后另行提交。
          anchor = { key: pendingTarget.chapterKey, offset: 0, screenY: 0 };
        }
        const { layout: newLayout, scrollTop: newS } = layoutRef.current.withMeasurements(
          updates,
          anchor,
          V,
          currentS
        );
        layoutRef.current = newLayout;
        setLayout(newLayout);
        layoutRevisionRef.current += 1;
        // 先几何、后位置：同步写 DOM，不依赖 React 已渲染。
        const accepted = commitContinuousGeometry({
          canvas: canvasRef.current,
          host: el,
          layout: newLayout,
          scrollTop: newS,
        });
        const scrollDelta = accepted - currentS;
        if (scrollDelta !== 0) {
          dampedScrollRef.current.shiftTarget(scrollDelta, newLayout.maxScrollTop(V));
        }
        const box = effective ? newLayout.boxFor(effective.key) : null;
        const newScreenY = box && effective && anchor ? box.top + anchor.offset - accepted : effective?.screenY ?? 0;
        if (effective && anchor) {
          effective.offset = anchor.offset;
          effective.screenY = newScreenY;
          effective.scrollTop = accepted;
        }
        if (
          readingPositionRef.current &&
          readingPositionRef.current.session === bookSessionRef.current &&
          readingPositionRef.current.source === "explicit" &&
          effective &&
          readingPositionRef.current.chapterKey === effective.key &&
          anchor
        ) {
          readingPositionRef.current = rebasePosition(readingPositionRef.current, {
            ...readingPositionRef.current.value,
            offset: anchor.offset,
            screenY: newScreenY,
            scrollTop: accepted,
          });
        }
        if (el) {
          // 只改原生 scrollTop 不够：React 状态/ref 与 iframe 投影必须同步，
          // 否则下一次渲染会用旧位置覆盖补偿结果。
          syncToScrollTop(accepted);
        }
        setSlotUpdateNonce((n) => n + 1);
        // 目标高度变化后，若显式导航仍有效则用同一票据在新几何里重解析。
        resolvePendingNavigationRef.current?.(effective?.key);
      },
      [V, syncToScrollTop]
    );
    commitLayoutBatchRef.current = commitLayoutBatch;

    /**
     * B-155：只用当前目标的只读解析结果换算内容坐标；媒体身份优先于像素
     * fallback，文本锚点优先于媒体。函数不写历史、不消费票据、不滚动 DOM。
     */
    const resolvePendingTargetContentY = (
      slot: ActiveSlot,
      target: ContinuousNavigationTarget,
    ): number | null => {
      const box = layoutRef.current.boxFor(slot.key);
      if (!box) return null;
      if (target.kind === "start") return 0;
      if (target.kind === "fragment") {
        return slot.paginator.resolveFragmentContentY(target.fragment);
      }
      if (target.kind === "search") {
        return slot.paginator.resolveSearchTargetContentY(target.request);
      }
      if (target.kind === "content-fraction") {
        if (target.fraction <= 0) return 0;
        const resolved = slot.paginator.resolveContentFraction(target.fraction);
        return resolved ? resolved.contentY : null;
      }
      if (target.kind !== "anchor" && target.kind !== "note") return null;
      // anchor/note：同一文本/媒体锚点跨模式复用。R4：请求提供了文本或
      // 媒体身份却解析失败时必须 unresolved，不能让旧页码兜底冒充成功。
      const hasTextIdentity = Boolean(
        target.anchor && target.anchor.anchorTextOffset !== null,
      );
      const hasMediaIdentity = Boolean(target.mediaAnchor);
      if (hasTextIdentity && target.anchor) {
        const resolved = slot.paginator.resolvePersistedAnchorContentY(target.anchor);
        if (resolved !== null) return resolved;
      }
      if (hasMediaIdentity && target.mediaAnchor) {
        const resolved = slot.paginator.resolveMediaAnchorContentY(target.mediaAnchor);
        if (resolved !== null) return resolved;
      }
      if (hasTextIdentity || hasMediaIdentity) return null;
      if (target.fallbackPage !== null && target.fallbackPage !== undefined) {
        const pageCount = slot.paginator.pageCount;
        const ratio = pageCount > 1
          ? Math.max(0, Math.min(1, target.fallbackPage / (pageCount - 1)))
          : 0;
        return ratio * box.height;
      }
      return 0;
    };

    /** 显式导航在目标图内/文本处需要提交的位置；失败明确报告，不冒充成功。 */
    const settlePendingNavigationFailure = (
      ticket: ScrollNavigationTicket<ContinuousNavigationTarget>,
    ): void => {
      const manager = pendingNavigationRef.current;
      if (!manager) return;
      manager.settle(ticket);
      pendingNavigationMetaRef.current = null;
      pendingNavigationFailureRef.current = true;
      let reported = false;
      if (ticket.target.kind === "search") {
        onPreciseNavigationStatus?.({
          requestId: ticket.target.request.requestId,
          status: "unresolved",
          exact: false,
        });
        reported = true;
      } else if (ticket.target.kind === "note") {
        onPreciseNavigationStatus?.({
          requestId: ticket.target.requestId,
          status: "unresolved",
          exact: false,
        });
        reported = true;
      } else if (ticket.target.kind === "content-fraction") {
        props.onContentFractionFailed?.(ticket.target.token);
      }
      onNavigationUnresolvedRef.current?.(reported);
    };

    /**
     * 目标章 ready/几何变化后，用一个票据一次性提交外层 scrollTop、投影与
     * 高亮。未 ready、无目标或布局代次变化时返回 false 并保留票据。
     */
    const resolvePendingNavigation = (changedKey?: string): boolean => {
      const manager = pendingNavigationRef.current;
      const meta = pendingNavigationMetaRef.current;
      if (!manager || !meta) return false;
      const ticket = manager.current();
      if (!ticket || ticket !== meta.ticket) {
        pendingNavigationMetaRef.current = null;
        return false;
      }
      if (ticket.bookSession !== bookSessionRef.current) {
        manager.cancel();
        pendingNavigationMetaRef.current = null;
        return false;
      }
      if (changedKey !== undefined && ticket.chapterKey !== changedKey) return false;
      if (!manager.canCommit(
        ticket,
        bookSessionRef.current,
        layoutRevisionRef.current,
        layoutRevisionRef.current,
      )) {
        return false;
      }
      const box = layoutRef.current.boxFor(ticket.chapterKey);
      const slot = slotsRef.current.get(ticket.chapterKey);
      if (!box || !slot || slot.unmounted || slot.status !== "ready" || !slot.paginator.isDisplayReady) {
        return false;
      }
      // 空白章节仍能定位章首；搜索/笔记/失效语义锚点继续由只读解析返回 null。
      let contentFractionResult: ResolvedContentFraction | null = null;
      if (ticket.target.kind === "content-fraction") {
        contentFractionResult = slot.paginator.resolveContentFraction(ticket.target.fraction);
        if (ticket.target.fraction > 0 && !contentFractionResult) {
          settlePendingNavigationFailure(ticket);
          return true;
        }
      }

      const contentY = resolvePendingTargetContentY(slot, ticket.target);
      if (contentY === null) {
        settlePendingNavigationFailure(ticket);
        return true;
      }

      const el = containerRef.current;
      if (!el) return false;
      pendingNavigationFailureRef.current = false;
      const isReadingLine = ticket.target.kind === "anchor" && ticket.target.alignment === "reading-line";
      const desiredInset =
        ticket.target.kind === "start" || (ticket.target.kind === "content-fraction" && ticket.target.fraction <= 0)
          ? 0
          : isReadingLine
            ? continuousReadingLine(V)
            : desiredScreenInset(V);
      const hostS = layoutRef.current.clampScrollTop(box.top + contentY - desiredInset, V);

      // 先只读应用章内状态（fragment/hash、搜索高亮、文本锚点字段），再写
      // 宿主几何；R2：搜索不再调用会改内部 scrollTop/采样/提前通知的完整
      // navigateToSearchTarget，只应用同一份 ranges。
      let preciseStatus: PreciseNavigationStatus | null = null;
      if (ticket.target.kind === "search") {
        preciseStatus = slot.paginator.applySearchTargetHighlight(ticket.target.request);
        if (preciseStatus !== "located" && preciseStatus !== "unsupported-highlight") {
          settlePendingNavigationFailure(ticket);
          return true;
        }
      } else if (ticket.target.kind === "fragment") {
        slot.paginator.navigateWithinCurrentChapter({ fragment: ticket.target.fragment });
      } else if (
        (ticket.target.kind === "anchor" || ticket.target.kind === "note") &&
        ticket.target.anchor
      ) {
        slot.paginator.setReadingAnchor(slot.path, ticket.target.anchor);
      } else if (ticket.target.kind === "content-fraction" && contentFractionResult) {
        slot.paginator.setReadingAnchor(slot.path, contentFractionResult.anchor);
      }

      const accepted = commitContinuousGeometry({
        canvas: canvasRef.current,
        host: el,
        layout: layoutRef.current,
        scrollTop: hostS,
      });
      pendingSpotRef.current = null;
      const screenY = box.top + contentY - accepted;
      const targetAnchor =
        (ticket.target.kind === "anchor" || ticket.target.kind === "note")
          ? ticket.target.anchor
          : ticket.target.kind === "content-fraction" && contentFractionResult
            ? contentFractionResult.anchor
            : null;
      const text = targetAnchor && targetAnchor.anchorTextOffset !== null
        ? {
            index: targetAnchor.index,
            ratio: targetAnchor.ratio,
            charsRead: targetAnchor.anchorTextOffset,
            totalChars: slot.paginator.totalChars,
            mediaUnits: 0,
            textOffset: targetAnchor.anchorTextOffset,
            textSnippet: targetAnchor.anchorTextSnippet,
          }
        : null;
      const media =
        (ticket.target.kind === "anchor" || ticket.target.kind === "note")
          ? (ticket.target.mediaAnchor ?? null)
          : ticket.target.kind === "content-fraction" && contentFractionResult
            ? (contentFractionResult.mediaAnchor ?? null)
            : null;
      const committedSpot: ReadingSpot = {
        key: slot.key,
        offset: contentY,
        screenY,
        scrollTop: accepted,
        text,
        media,
      };
      lastStableSpotRef.current = committedSpot;
      readingPositionRef.current = commitExplicitPosition(
        bookSessionRef.current,
        slot.key,
        committedSpot,
      );
      syncToScrollTop(accepted, false);
      if (ticket.target.kind === "search" && preciseStatus) {
        onPreciseNavigationStatus?.({
          requestId: ticket.target.request.requestId,
          status: preciseStatus,
          exact: true,
        });
      } else if (ticket.target.kind === "note") {
        onPreciseNavigationStatus?.({
          requestId: ticket.target.requestId,
          status: "located",
          exact: false,
        });
      }
      const maxS = layoutRef.current.maxScrollTop(V);
      const isAtScrollEnd = maxS > 0 ? accepted >= maxS - 2 : true;
      const isLastLinear = linearItems.length > 0 && linearItems[linearItems.length - 1].key === slot.key;
      const atEnd = isLastLinear && isAtScrollEnd;

      if (ticket.target.kind === "content-fraction") {
        const token = ticket.target.token;
        const actualFraction = contentFractionResult ? contentFractionResult.fraction : ticket.target.fraction;
        props.onContentFractionSettled?.(token, {
          key: slot.key,
          spineIndex: slot.spineIndex,
          fraction: actualFraction,
          atEnd,
        });
      }
      if (manager.settle(ticket)) {
        pendingNavigationMetaRef.current = null;
        onInternalNavigationSettledRef.current?.();
      }
      checkVisibleChapterRef.current?.();
      return true;
    };
    resolvePendingNavigationRef.current = resolvePendingNavigation;

    /**
     * 合并一次“存活 iframe 高度重测”。同一帧内的多个触发只提交一批；
     * 极端情况下容器尚未布局时按帧重试，上限与章节测量一致。
     */
    const scheduleLayoutRemeasure = useCallback(
      (spot: ReadingSpot | null) => {
        if (spot && !pendingSpotRef.current) pendingSpotRef.current = spot;
        if (layoutRemeasureFrameRef.current !== null) return;
        layoutRemeasureRetriesRef.current = 0;
        const attempt = () => {
          layoutRemeasureFrameRef.current = null;
          const updates: ChapterExtent[] = [];
          let pending = reloadingRef.current.size > 0;
          for (const [key, slot] of slotsRef.current.entries()) {
            if (slot.unmounted || slot.status !== "ready") continue;
            if (reloadingRef.current.has(key)) continue;
            // 必须等分页器按新视口完成一次测量：iframe 刚改尺寸时内容可能
            // 还没重排完，直接读会得到偏小的中间高度并污染整本布局表。
            if (!slot.paginator.isMeasuredForViewport()) {
              pending = true;
              continue;
            }
            const height = slot.paginator.getContinuousContentHeight();
            const container = slot.iframe.parentElement;
            const laidOut = container !== null && container.offsetParent !== null;
            const measurement = classifyChapterMeasurement({
              displayReady: slot.paginator.isDisplayReady,
              viewportLaidOut: laidOut,
              contentHeight: height,
            });
            if (measurement.kind === "pending") {
              pending = true;
              continue;
            }
            const extent = measurement.kind === "empty" ? viewportHeightRef.current : measurement.height;
            updates.push({ key, height: extent, measured: true });
          }
          if (pending) {
            if (layoutRemeasureRetriesRef.current < MEASURE_RETRY_LIMIT) {
              layoutRemeasureRetriesRef.current += 1;
              layoutRemeasureFrameRef.current = window.requestAnimationFrame(attempt);
            }
            // 长字体等待交给最终布局通知唤醒；不提交半批数据或丢掉原锚点。
            return;
          }
          const spotForCommit = pendingSpotRef.current;
          layoutRemeasureRetriesRef.current = 0;
          // 必须走最新实现：等待字体/测量期间跨过下一次 resize 时，
          // 原闭包里的 V/投影函数已经过期（R4）。
          if (updates.length > 0) commitLayoutBatchRef.current(updates, spotForCommit);
          pendingSpotRef.current = null;
          checkVisibleChapterRef.current?.();
        };
        layoutRemeasureFrameRef.current = window.requestAnimationFrame(attempt);
      },
      []
    );

    /**
     * 已就绪章节的布局变化（图片晚加载、分页器重排完成、设置重载中的重排）
     * → 重测真实高度。首次 ready 走 ChapterLoadGate 路径，这里只处理 ready
     * 之后的几何变化；用上次稳定锚点补偿，避免在已经变化的几何里重新选
     * “当前内容”。设置重载也必须经过同一事务，不再单独跳过。
     */
    layoutSettledRef.current = (key: string) => {
      const current = slotsRef.current.get(key);
      if (!current || current.unmounted) return;
      if (current.status !== "ready") return;
      // 布局变动平移阻尼目标，不再野蛮掐断滚轮动量；优先采样当前视口真实阅读点
      scheduleLayoutRemeasure(captureReadingSpot() ?? lastStableSpotRef.current);
    };

    /**
     * 宿主尺寸变化 → 重排事务。
     *
     * V 是书内 `vh` 与 viewer 100% 的基准，只有 iframe 视口该用它；章节
     * wrapper 高度必须继续用真实内容高 H。这里同步所有存活 iframe（含仍在
     * 加载中的槽位），停止基于旧视口的阻尼动画，采样阅读位置后按帧重测 H，
     * 由 commitLayoutBatch 在同一帧提交新高度、宿主位置与投影。
     * 不重建整本书的 layout，也不清空已测高度。
     */
    useEffect(() => {
      if (viewportWidth <= 0 || V <= 0) return;
      const applied = appliedHostSizeRef.current;
      if (applied && applied.width === viewportWidth && applied.height === V) return;
      appliedHostSizeRef.current = { width: viewportWidth, height: V };
      const el = containerRef.current;
      if (!el) return;
      dampedScrollRef.current.stop();
      // 必须使用**变化前**保存的稳定阅读点：宿主 ResizeObserver 触发时
      // iframe 宽度（100%）已经跟着变了，此时再采样可能命中另一段内容，
      // 作者的媒体查询/vw 规则也会立刻改变书内几何（R2）。只有首次加载
      // 还没有稳定样本时才允许在新几何里兜底采样。
      const stored = lastStableSpotRef.current;
      const spot =
        stored && layoutRef.current.boxFor(stored.key) ? stored : captureReadingSpot();
      if (spot && !pendingSpotRef.current) pendingSpotRef.current = spot;
      for (const slot of slotsRef.current.values()) {
        if (slot.unmounted) continue;
        slot.iframe.style.height = `${V + 2 * frameBleed}px`;
        slot.paginator.setContinuousBleed(frameBleed);
        if (slot.status === "ready" || slot.paginator.isDisplayReady) slot.paginator.reflow();
      }
      scheduleLayoutRemeasure(spot);
    }, [V, captureReadingSpot, scheduleLayoutRemeasure, viewportWidth]);

    // 外部滚轮及按键转交处理器。
    // 连续滚动模式下 iframe 内的滚轮/按键由 ExternalScrollAdapter 转交给宿主，
    // 旧分页器的阻尼动画因此不可达；这里在宿主上重建同一套手感：
    // 目标按格累加、单条 rAF 逐帧指数衰减、约 4~6 帧到位后吸附停定。
    const handleExternalWheelPixels = useCallback((deltaY: number) => {
      if (inputPaused) return;
      const el = containerRef.current;
      if (!el) return;
      dampedScrollRef.current.addDelta(
        deltaY,
        () => ({ current: el.scrollTop, maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight) }),
        (position) => {
          el.scrollTop = position;
          syncToScrollTop(el.scrollTop, true);
        }
      );
    }, [inputPaused, syncToScrollTop]);

    const handleExternalViewportStep = useCallback((direction: 1 | -1) => {
      if (inputPaused) return;
      const el = containerRef.current;
      if (!el) return;
      // 约 0.9 屏的视口跳转同样走阻尼，保持与滚轮一致的网页级手感。
      dampedScrollRef.current.addDelta(
        direction * Math.round(0.9 * V),
        () => ({ current: el.scrollTop, maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight) }),
        (position) => {
          el.scrollTop = position;
          syncToScrollTop(el.scrollTop, true);
        }
      );
    }, [V, inputPaused, syncToScrollTop]);

    // 外部滚轮适配器只注册一次；转发到最新实现，避免 resize 后仍用旧 V 计算视口步长。
    externalScrollHandlersRef.current = {
      onWheelPixels: handleExternalWheelPixels,
      onViewportStep: handleExternalViewportStep,
    };

    // 加载队列与单并发调度
    const inFlightLoadRef = useRef(false);

    const loadChapterSlot = useCallback(
      async (key: string, path: string, spineIdx: number) => {
        const ticket = gateRef.current.begin(key);
        if (!ticket) return;

        // 创建临时 iframe
        // 视口高度取最新宿主尺寸，不用创建时的闭包旧值；宿主 resize 后已有
        // 槽位由尺寸事务统一覆盖。
        const currentV = viewportHeightRef.current > 0 ? viewportHeightRef.current : V;
        const iframe = document.createElement("iframe");
        iframe.title = `continuous chapter ${spineIdx}`;
        iframe.style.position = "absolute";
        iframe.style.left = "0";
        iframe.style.right = "0";
        iframe.style.width = "100%";
        iframe.style.height = `${currentV + 2 * continuousFrameBleed(currentV)}px`;
        iframe.style.border = "none";

        let slot: ActiveSlot;

        const effectiveSettings = effectiveReaderSettings(settings, false);

        const paginator = new ChapterPaginator(
          iframe,
          server,
          effectiveSettings,
          false,
          () => {},
          onIssues,
          false,
          onInternalLink,
          onBeforeInternalNavigate,
          onInternalNavigationSettled,
          () => {}, // 不使用旧 onWheelNavigate
          () => {}, // 不使用旧 onKeyNavigate
          (payload) => {
            // 纠正脚注文档内标记的坐标为宿主阅读区坐标
            const el = containerRef.current;
            if (!el) {
              onFootnote(payload);
              return;
            }
            const hostRect = el.getBoundingClientRect();
            const iframeRect = iframe.getBoundingClientRect();
            const dx = iframeRect.left - hostRect.left;
            const dy = iframeRect.top - hostRect.top;
            onFootnote({
              ...payload,
              rect: {
                left: payload.rect.left + dx,
                top: payload.rect.top + dy,
                right: payload.rect.right + dx,
                bottom: payload.rect.bottom + dy,
              },
            });
          },
          onFootnoteClose,
          onExternalLink,
          () => {
            // onDisplayReady 回调：先尝试提交真实高度。
            // 同章设置重载走独立分支：它沿用同一个 paginator，gate 里已没有本次票据，
            // 只需重测高度并刷新布局，不重复置 ready / 不重放 onDisplayReady。
            // 这个回调注册在 paginator 上，会一直活到槽位回收：必须转发到最新
            // 实现并校验实例，否则旧槽位会继续用创建时的 V / 几何提交（R4）。
            const current = slotsRef.current.get(key);
            if (!current || current.unmounted || current.paginator !== paginator) return;
            const reloading = reloadingRef.current.has(key);
            // 设置重载由串行 worker 等待最终显示门并统一批量提交。
            // 某一章先完成不能清掉其它章还需要的稳定锚点。
            if (reloading) return;
            if (!reloading && !gateRef.current.isCurrent(ticket)) return;
            if (!paginator.isMeasuredForViewport()) paginator.reflow();
            const committed = commitChapterMeasurementRef.current(key, paginator, ticket, reloading);
            if (!committed) {
              scheduleChapterMeasurementRef.current(key, paginator, ticket);
            }
          },
          (payload) => {
            if (!payload) {
              onSelectionContextMenu?.(null);
              return;
            }
            const el = containerRef.current;
            if (!el) {
              onSelectionContextMenu?.(payload);
              return;
            }
            const hostRect = el.getBoundingClientRect();
            const iframeRect = iframe.getBoundingClientRect();
            const dx = iframeRect.left - hostRect.left;
            const dy = iframeRect.top - hostRect.top;
            onSelectionContextMenu?.({
              ...payload,
              rect: {
                left: payload.rect.left + dx,
                top: payload.rect.top + dy,
                right: payload.rect.right + dx,
                bottom: payload.rect.bottom + dy,
              },
            });
          },
          (status) => {
            onPreciseNavigationStatus?.(status);
          },
          onImageActivation,
          {
            onWheelPixels: (delta) => externalScrollHandlersRef.current.onWheelPixels(delta),
            onViewportStep: (direction) =>
              externalScrollHandlersRef.current.onViewportStep(direction),
          },
          undefined,
          () => {
            if (!inputPausedRef.current) onPlainTapRef.current?.();
          },
          () => inputPausedRef.current
        );

        slot = {
          key,
          spineIndex: spineIdx,
          path,
          iframe,
          paginator,
          ticket,
          status: "loading",
          renderSettings: effectiveSettings,
        };

        // 已就绪章节的重排（图片晚加载、窗口尺寸变化）走独立通知：首次 ready
        // 仍由 ChapterLoadGate 票据路径负责，这里不重复结束票据或重报就绪。
        // 只注册一次转发，避免旧槽位持有创建时的 V / 几何闭包。
        paginator.setLayoutSettledHandler(() => layoutSettledRef.current(key));

        slotsRef.current.set(key, slot);
        setSlotUpdateNonce((n) => n + 1);

        // 打开书/书签/历史返回的语义锚点只交给目标章，不让邻章预载误用。
        const targetReadingAnchor =
          props.initialAnchor && spineIdx === props.spineIndex
            ? props.initialAnchor
            : null;
        const targetFallbackPage =
          spineIdx === props.spineIndex ? (props.initialPage ?? null) : null;
        try {
          await paginator.load(path, {
            settings: effectiveSettings,
            hasNextChapter: nextLinearIndex(book, spineIdx, 1) >= 0,
            hasPrevChapter: nextLinearIndex(book, spineIdx, -1) >= 0,
            resetPage: true,
            readingAnchor: targetReadingAnchor,
            fallbackPage: targetFallbackPage,
          });
        } catch {
          if (gateRef.current.isCurrent(ticket)) {
            gateRef.current.cancel(key);
            slot.status = "error";
            setSlotUpdateNonce((n) => n + 1);
          }
        }
      },
      [
        V,
        book,
        handleExternalViewportStep,
        handleExternalWheelPixels,
        onBeforeInternalNavigate,
        onDisplayReady,
        onExternalLink,
        onFootnote,
        onFootnoteClose,
        onImageActivation,
        onInternalLink,
        onInternalNavigationSettled,
        onIssues,
        onPreciseNavigationStatus,
        onSelectionContextMenu,
        preciseTarget,
        props.initialAnchor,
        props.initialPage,
        props.spineIndex,
        server,
        settings,
      ]
    );

    /**
     * 提交一次章节高度测量。
     *
     * 容器已参与布局且 display-ready 后才提交；未就绪的 0 高度继续等待。
     * 真正空章保留一屏留白，已有作者留白则保留实测高度；短正文不撑成整屏。
     *
     * `sameChapterReload` 表示这是“同章换设置”重建后的完成回调：沿用同一 paginator，
     * gate 里已无本次票据，因此不做 finish/置 ready/重放 onDisplayReady，只重测布局。
     */
    const commitChapterMeasurement = useCallback(
      (
        key: string,
        paginator: ChapterPaginator,
        ticket: ChapterLoadTicket,
        sameChapterReload = false
      ): boolean => {
        const slot = slotsRef.current.get(key);
        if (!slot || slot.unmounted) return true;
        // 回调所属实例校验：槽位被重建后旧 paginator 的测量结果不可提交，
        // `isMeasuredForViewport()` 只比较当前 iframe，证明不了事务版本（R4）。
        if (slot.paginator !== paginator) return true;
        if (!sameChapterReload && !gateRef.current.isCurrent(ticket)) return true;
        if (!paginator.isMeasuredForViewport()) return false;
        const height = paginator.getContinuousContentHeight();
        const container = slot.iframe.parentElement;
        const laidOut = container !== null && container.offsetParent !== null;
        // B-151：只有在 display-ready 且容器确实参与布局后，零高度才是 empty；
        // 否则继续按帧重测，不把未布局/未完成的测量写成 0 高度。
        const measurement = classifyChapterMeasurement({
          displayReady: paginator.isDisplayReady,
          viewportLaidOut: laidOut,
          contentHeight: height,
        });
        if (measurement.kind === "pending") return false;

        if (!sameChapterReload) {
          if (!gateRef.current.finish(ticket)) return true;
          slot.status = "ready";
          setSlotUpdateNonce((n) => n + 1);
        }
        // 统一的批量提交入口：新高度、宿主位置与 iframe 投影同帧生效。
        // 必须走最新实现，不能用创建时的闭包旧 V / 旧几何（R4）。
        if (pendingSpotRef.current || reloadingRef.current.size > 0) {
          scheduleLayoutRemeasure(pendingSpotRef.current);
        } else {
          // 真正零内容的章节保留一屏空白；作者已有的留白高度按实测保留。
          const extent = measurement.kind === "empty" ? V : measurement.height;
          commitLayoutBatchRef.current([{ key, height: extent, measured: true }], null);
        }
        void reloadSlotSettingsRef.current(slot);
        if (!sameChapterReload) {
          // 显式导航票据优先：目标章 ready 后先由宿主统一提交 scrollTop/高亮，
          // 再报告 settled；没有待处理导航才走普通 ready 发布。
          const settled = resolvePendingNavigationRef.current?.(key) === true;
          if (!settled && !pendingNavigationFailureRef.current &&
              !pendingNavigationRef.current?.current()) onDisplayReady?.();
          pendingNavigationFailureRef.current = false;
        }
        // 首章就绪后同步一次可见章节状态，否则状态栏会一直停在“加载中…”
        // （滚动模式的状态由 checkVisibleChapter 驱动，而打开书并不会触发滚动）。
        checkVisibleChapterRef.current?.();
        return true;
      },
      [V, onDisplayReady, scheduleLayoutRemeasure]
    );
    commitChapterMeasurementRef.current = commitChapterMeasurement;

    /** 测量未就绪时按帧重测，直到容器可见或超过重试上限。 */
    const scheduleChapterMeasurement = useCallback(
      (key: string, paginator: ChapterPaginator, ticket: ChapterLoadTicket) => {
        if (measuringRef.current.has(key)) return;
        if ((measureRetriesRef.current.get(key) ?? 0) >= MEASURE_RETRY_LIMIT) return;
        measuringRef.current.add(key);
        const attempt = () => {
          measureFrameRef.current.delete(key);
          const current = slotsRef.current.get(key);
          if (!current || current.unmounted || current.paginator !== paginator) {
            measuringRef.current.delete(key);
            return;
          }
          if (!gateRef.current.isCurrent(ticket)) {
            measuringRef.current.delete(key);
            return;
          }
          measureRetriesRef.current.set(key, (measureRetriesRef.current.get(key) ?? 0) + 1);
          // 按帧重试也可能跨过下一次 resize：走最新实现，不用排入时的闭包（R4）。
          if (commitChapterMeasurementRef.current(key, paginator, ticket)) {
            measuringRef.current.delete(key);
            return;
          }
          measureFrameRef.current.set(key, window.requestAnimationFrame(attempt));
        };
        measureFrameRef.current.set(key, window.requestAnimationFrame(attempt));
      },
      []
    );
    scheduleChapterMeasurementRef.current = scheduleChapterMeasurement;

    // 调度当前有界投影窗口内的章节，并回收窗口外的槽位
    useEffect(() => {
      const activeKeys = new Set(projections.map((p) => p.box.key));

      // 回收离开投影窗口的槽位
      for (const [key, slot] of slotsRef.current.entries()) {
        if (!activeKeys.has(key)) {
          slot.unmounted = true;
          gateRef.current.cancel(key);
          slot.paginator.dispose();
          slotsRef.current.delete(key);
          reloadingRef.current.delete(key);
          const frame = measureFrameRef.current.get(key);
          if (frame !== undefined) {
            window.cancelAnimationFrame(frame);
            measureFrameRef.current.delete(key);
          }
          measuringRef.current.delete(key);
          measureRetriesRef.current.delete(key);
        }
      }

      // 可见未知章节优先调度，并发限制为 1
      if (!inFlightLoadRef.current) {
        // 显式/可见章绝对优先：先找真正处于可视区（visible=true）且未加载的章节，再找预读 overscan 章节
        const needed =
          projections.find((p) => p.visible && !slotsRef.current.has(p.box.key)) ??
          projections.find((p) => !slotsRef.current.has(p.box.key));
        if (needed) {
          const item = linearItems[needed.box.index];
          if (item) {
            inFlightLoadRef.current = true;
            void loadChapterSlot(needed.box.key, item.path, item.index).finally(() => {
              inFlightLoadRef.current = false;
              setSlotUpdateNonce((n) => n + 1);
            });
          }
        }
      }
    }, [linearItems, loadChapterSlot, projections, slotUpdateNonce]);

    // 卸载时停止阻尼动画与待执行的设置重载，避免帧循环/定时器泄漏
    useEffect(() => {
      const animator = dampedScrollRef.current;
      const debouncer = settingsReloadDebouncerRef.current;
      return () => {
        animator.stop();
        debouncer?.cancel();
        if (layoutRemeasureFrameRef.current !== null) {
          window.cancelAnimationFrame(layoutRemeasureFrameRef.current);
          layoutRemeasureFrameRef.current = null;
        }
        pendingSpotRef.current = null;
        if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
        for (const frame of measureFrameRef.current.values()) cancelAnimationFrame(frame);
        measureFrameRef.current.clear();
        measuringRef.current.clear();
        measureRetriesRef.current.clear();
        for (const slot of slotsRef.current.values()) {
          slot.unmounted = true;
          slot.paginator.dispose();
        }
        slotsRef.current.clear();
        gateRef.current.reset();
        reloadingRef.current.clear();
        auxPaginatorRef.current?.dispose();
        auxPaginatorRef.current = null;
      };
    }, []);

    /** 每个槽位只重载一次；进行中的设置变化合并成下一轮最新设置。 */
    reloadSlotSettingsRef.current = async (slot: ActiveSlot) => {
      if (slot.unmounted || slot.status !== "ready" || reloadingRef.current.has(slot.key)) return;
      if (sameRenderingSettings(slot.renderSettings, desiredSettingsRef.current)) return;
      dampedScrollRef.current.stop();
      if (!pendingSpotRef.current) {
        pendingSpotRef.current = lastStableSpotRef.current ?? captureReadingSpot();
      }
      reloadingRef.current.add(slot.key);
      try {
        do {
          const target = desiredSettingsRef.current;
          await slot.paginator.reloadWithSettings(target);
          const ready = await slot.paginator.waitForDisplayReady();
          if (slot.unmounted || slotsRef.current.get(slot.key) !== slot) return;
          if (!ready) {
            slot.status = "error";
            break;
          }
          slot.renderSettings = target;
        } while (!sameRenderingSettings(slot.renderSettings, desiredSettingsRef.current));
      } catch {
        if (!slot.unmounted) slot.status = "error";
      } finally {
        if (slotsRef.current.get(slot.key) === slot && !slot.unmounted) {
          reloadingRef.current.delete(slot.key);
          scheduleLayoutRemeasure(pendingSpotRef.current);
          setSlotUpdateNonce((n) => n + 1);
        }
      }
    };

    /**
     * 设置变更 → 重载已挂载章节。
     *
     * 主题/字号/字体等渲染设置是“烘焙”进每章文档 HTML 的（`sanitize` 生成 themeCss
     * 与页面色），因此只改外层 CSS 变量不会影响书页：必须用新设置重新 sanitize 该章。
     * 翻页模式由 `PagedReaderView` 的 `reloadWithSettings` 覆盖；连续滚动的分发发生
     * 在那个 effect 之前，所以这里必须自己做一遍，否则只有新加载的章节会跟随主题。
     *
     * 只重载当前投影窗口内已就绪的槽位：窗口外章节会被回收，重新挂载时本来就带最新设置。
     *
     * 字号/字体改变会改动正在读的正文上方高度，因此重载也必须进入同一内容锚点
     * 事务：重载前保存最新稳定阅读点并停止旧阻尼动画，保留到相关章节测量完成
     * 后用同一 textOffset 恢复（R5）。主题不改几何时该事务自然是零补偿。
     */
    useEffect(() => {
      const previous = settingsIdentityRef.current;
      const current = effectiveReaderSettings(settings, false);
      desiredSettingsRef.current = current;
      if (!previous) {
        settingsIdentityRef.current = current;
        return;
      }
      if (sameRenderingSettings(previous, current)) return;
      settingsIdentityRef.current = current;

      const debouncer = settingsReloadDebouncerRef.current;
      if (!debouncer) return;
      debouncer.schedule(() => {
        const projected = new Set(projectionsRef.current.map((projection) => projection.box.key));
        // 等宽/字体重排期间若仍有旧阻尼在跑，它的目标基于旧几何，会把位置拉回。
        dampedScrollRef.current.stop();
        const stored = lastStableSpotRef.current;
        const spot =
          stored && layoutRef.current.boxFor(stored.key) ? stored : captureReadingSpot();
        if (spot && !pendingSpotRef.current) pendingSpotRef.current = spot;
        for (const [key, slot] of slotsRef.current.entries()) {
          if (projected.has(key)) void reloadSlotSettingsRef.current(slot);
        }
        scheduleLayoutRemeasure(pendingSpotRef.current);
      });
    }, [captureReadingSpot, scheduleLayoutRemeasure, settings]);

    // 响应笔记更新
    useEffect(() => {
      for (const slot of slotsRef.current.values()) {
        slot.paginator.setNotes(notes);
      }
    }, [notes]);

    // 显式导航响应（TOC / 搜索 / 笔记 / 书签 / 历史返回 / 打开书）
    const lastNavigatedNonceRef = useRef<number>(-1);
    useEffect(() => {
      const path = spineItemPath(book, spineIndex);
      if (!path) return;
      const targetKey = `${spineIndex}:${path}`;
      const targetBox = layoutRef.current.boxFor(targetKey);
      if (!targetBox) return;

      const nonceChanged = props.anchorNonce !== lastNavigatedNonceRef.current;
      const needsInitialRestore =
        !initialNavigationHandledRef.current &&
        Boolean(props.initialAnchor || (props.initialPage ?? 0) > 0);
      if (!nonceChanged && !needsInitialRestore) return;
      lastNavigatedNonceRef.current = props.anchorNonce;
      if (needsInitialRestore) initialNavigationHandledRef.current = true;

      const precise =
        props.preciseTarget && props.preciseTarget.chapterPath === path
          ? props.preciseTarget
          : null;
      let target: ContinuousNavigationTarget;
      if (precise) {
        if (precise.kind === "note") {
          // R2：笔记保留 note 身份，只使用 App 给的原始 initialAnchor 只读解析，
          // 不伪装成搜索，也不把失配落到 fallbackPage。
          target = {
            kind: "note",
            requestId: precise.requestId,
            anchor: props.initialAnchor ?? null,
            mediaAnchor: props.initialAnchor?.mediaAnchor ?? null,
            fallbackPage: null,
          };
        } else {
          target = { kind: "search", request: precise };
        }
      } else if (props.anchor) {
        target = { kind: "fragment", fragment: props.anchor };
      } else if (props.initialAnchor) {
        const hasSemanticInitial =
          props.initialAnchor.anchorTextOffset !== null ||
          Boolean(props.initialAnchor.mediaAnchor);
        target = {
          kind: "anchor",
          anchor: props.initialAnchor,
          mediaAnchor: props.initialAnchor.mediaAnchor ?? null,
          fallbackPage: hasSemanticInitial ? null : (props.initialPage ?? null),
          alignment: props.initialAlignment ?? "context",
        };
      } else {
        target = {
          kind: "anchor",
          anchor: null,
          mediaAnchor: null,
          fallbackPage: props.initialPage ?? null,
          alignment: props.initialAlignment ?? "context",
        };
      }

      const el = containerRef.current;
      if (!el) return;
      // 显式导航开始释放旧权属，保留旧稳定 spot 供既有失败保护使用
      readingPositionRef.current = releaseExplicitPosition(readingPositionRef.current);
      // 显式导航必须立刻停止旧阻尼。
      dampedScrollRef.current.stop();
      const manager = pendingNavigationRef.current;
      if (!manager) return;
      const ticket = manager.begin(bookSessionRef.current, targetKey, target);
      pendingNavigationFailureRef.current = false;
      pendingNavigationMetaRef.current = {
        ticket,
        measuredRevision: layoutRevisionRef.current,
      };

      // 目标尚未装载时，只把宿主移到估算章节位置以触发投影加载；这不是
      // 最终提交，不写进度、不发 settled。目标 ready 后再按票据真实解析。
      const slot = slotsRef.current.get(targetKey);
      if (!slot || slot.status !== "ready") {
        const estimateS = layoutRef.current.clampScrollTop(targetBox.top, V);
        if (Math.abs(el.scrollTop - estimateS) > 0.5) {
          el.scrollTop = estimateS;
        }
        syncToScrollTop(el.scrollTop, false);
        return;
      }
      resolvePendingNavigationRef.current?.(targetKey);
    }, [
      book,
      props.anchor,
      props.anchorNonce,
      props.initialAlignment,
      props.initialAnchor,
      props.initialPage,
      props.preciseTarget,
      spineIndex,
      V,
    ]);

    // 挂载各 slot 的 iframe 到对应的 chapter wrapper
    const attachIframe = useCallback((key: string, container: HTMLDivElement | null) => {
      if (!container) return;
      const slot = slotsRef.current.get(key);
      if (!slot) return;
      if (slot.iframe.parentElement !== container) {
        container.innerHTML = "";
        container.appendChild(slot.iframe);
      }
    }, []);

    // 暴露 ReaderHandle 接口
    useImperativeHandle(
      ref,
      () => ({
        nextPage() {
          handleExternalViewportStep(1);
        },
        prevPage() {
          handleExternalViewportStep(-1);
        },
        setPage() {},
        seekContentFraction(
          target: { key: string; spineIndex: number; fraction: number },
          token: ScrubToken,
        ) {
          dampedScrollRef.current.stop();
          for (const slot of slotsRef.current.values()) slot.paginator.closeForNavigation();
          pendingSpotRef.current = null;
          readingPositionRef.current = releaseExplicitPosition(readingPositionRef.current);

          const manager = pendingNavigationRef.current;
          if (!manager) return;

          const navTarget: ContinuousNavigationTarget = {
            kind: "content-fraction",
            fraction: target.fraction,
            token,
          };
          const ticket = manager.begin(bookSessionRef.current, target.key, navTarget);
          pendingNavigationFailureRef.current = false;
          pendingNavigationMetaRef.current = {
            ticket,
            measuredRevision: layoutRevisionRef.current,
          };

          const slot = slotsRef.current.get(target.key);
          if (slot && slot.status === "ready" && slot.paginator.isDisplayReady) {
            resolvePendingNavigation();
            return;
          }

          const box = layoutRef.current.boxFor(target.key);
          const el = containerRef.current;
          if (box && el) {
            const estimatedTop = layoutRef.current.clampScrollTop(
              target.fraction <= 0
                ? box.top
                : box.top + Math.min(box.height, target.fraction * box.height),
              V,
            );
            const accepted = commitContinuousGeometry({
              canvas: canvasRef.current,
              host: el,
              layout: layoutRef.current,
              scrollTop: estimatedTop,
            });
            syncToScrollTop(accepted, false);
          }
        },
        scrollToRatio(ratio: number) {
          const clamped = Math.max(0, Math.min(1, ratio));
          this.seekContentFraction?.(
            { key: linearItems[0]?.key ?? "0:", spineIndex: 0, fraction: clamped },
            { session: bookSessionRef.current, request: -1 },
          );
        },
        diagnose() {
          const loadedKeys = Array.from(slotsRef.current.keys()).join(", ");
          return `ContinuousReaderView: totalHeight=${layoutRef.current.totalHeight} V=${V} scrollTop=${containerRef.current?.scrollTop ?? 0} loaded=[${loadedKeys}]`;
        },
        getReadingAnchor() {
          const activeExplicit =
            readingPositionRef.current &&
            readingPositionRef.current.session === bookSessionRef.current &&
            readingPositionRef.current.source === "explicit"
              ? readingPositionRef.current.value
              : null;
          const spot = activeExplicit ?? captureReadingSpot() ?? lastStableSpotRef.current;
          if (spot) {
            if (spot.text) {
              return {
                path: spot.key.split(":").slice(1).join(":"),
                index: spot.text.index,
                ratio: spot.text.ratio,
                charsRead: spot.text.charsRead,
                totalChars: spot.text.totalChars,
                mediaUnits: spot.text.mediaUnits ?? 0,
                textOffset: spot.text.textOffset,
                textSnippet: spot.text.textSnippet,
                mediaAnchor: null,
              };
            }
            if (spot.media) {
              return {
                path: spot.key.split(":").slice(1).join(":"),
                index: -1,
                ratio: spot.media.ratio,
                charsRead: 0,
                totalChars: 0,
                mediaUnits: 1,
                textOffset: null,
                textSnippet: null,
                mediaAnchor: spot.media,
              };
            }
          }
          const el = containerRef.current;
          const S = el?.scrollTop ?? 0;
          const continuousAnchor = layoutRef.current.anchorAt(S, V, READING_LINE_RATIO * V);
          const slot = continuousAnchor ? slotsRef.current.get(continuousAnchor.key) : null;
          if (slot && slot.status === "ready") {
            const projection = layoutRef.current.project(S, V, overscan, frameBleed).find((p) => p.box.key === continuousAnchor!.key);
            if (projection) {
              const sample = sampleReadingLine(slot, READING_LINE_RATIO * V - projection.frameScreenTop);
              if (sample.fine?.anchor) {
                return {
                  path: slot.path,
                  index: sample.fine.anchor.index,
                  ratio: sample.fine.anchor.ratio,
                  charsRead: sample.fine.anchor.charsRead,
                  totalChars: sample.fine.anchor.totalChars,
                  mediaUnits: sample.fine.anchor.mediaUnits ?? 0,
                  textOffset: sample.fine.anchor.textOffset,
                  textSnippet: sample.fine.anchor.textSnippet,
                  mediaAnchor: null,
                };
              }
              if (sample.media?.anchor) {
                return {
                  path: slot.path,
                  index: -1,
                  ratio: sample.media.anchor.ratio,
                  charsRead: 0,
                  totalChars: 0,
                  mediaUnits: 1,
                  textOffset: null,
                  textSnippet: null,
                  mediaAnchor: sample.media.anchor,
                };
              }
            }
            return slot.paginator.getReadingAnchor() ?? null;
          }
          return null;
        },
        getAnchorText() {
          const activeExplicit =
            readingPositionRef.current &&
            readingPositionRef.current.session === bookSessionRef.current &&
            readingPositionRef.current.source === "explicit"
              ? readingPositionRef.current.value
              : null;
          const spot = activeExplicit ?? captureReadingSpot() ?? lastStableSpotRef.current;
          if (spot?.text?.textSnippet) return spot.text.textSnippet;
          const el = containerRef.current;
          const S = el?.scrollTop ?? 0;
          const continuousAnchor = layoutRef.current.anchorAt(S, V, READING_LINE_RATIO * V);
          const slot = continuousAnchor ? slotsRef.current.get(continuousAnchor.key) : null;
          return slot?.paginator.getAnchorText() ?? null;
        },
        jumpToAnchor(anchorStr) {
          this.navigateWithinCurrentChapter({ fragment: anchorStr });
        },
        navigateWithinCurrentChapter(options: WithinChapterNavigationOptions) {
          const el = containerRef.current;
          if (!el) return false;
          const currentAnchor = layoutRef.current.anchorAt(el.scrollTop, V, READING_LINE_RATIO * V);
          if (!currentAnchor) return false;
          const slot = slotsRef.current.get(currentAnchor.key);
          if (!slot || slot.status !== "ready" || !slot.paginator.isDisplayReady) return false;
          const box = layoutRef.current.boxFor(slot.key);
          if (!box) return false;

          const hasSemanticTextAnchor = Boolean(
            options.readingAnchor &&
              (options.readingAnchor.anchorTextOffset !== null ||
                options.readingAnchor.anchorTextSnippet !== null),
          );
          const semanticTarget = hasSemanticTextAnchor || Boolean(options.mediaAnchor);
          let contentY: number | null = null;
          if (options.toStart) contentY = 0;
          else if (options.fragment !== undefined) {
            contentY = slot.paginator.resolveFragmentContentY(options.fragment);
          } else if (options.readingAnchor) {
            contentY = slot.paginator.resolvePersistedAnchorContentY(options.readingAnchor);
          }
          if (contentY === null && options.mediaAnchor) {
            contentY = slot.paginator.resolveMediaAnchorContentY(options.mediaAnchor);
          }
          if (
            contentY === null &&
            !semanticTarget &&
            options.fallbackPage !== null &&
            options.fallbackPage !== undefined
          ) {
            const pageCount = slot.paginator.pageCount;
            const ratio = pageCount > 1
              ? Math.max(0, Math.min(1, options.fallbackPage / (pageCount - 1)))
              : 0;
            contentY = ratio * box.height;
          }
          if (contentY === null) return false;

          const isReadingLine = options.alignment === "reading-line";
          const desiredInset = options.toStart
            ? 0
            : isReadingLine
              ? continuousReadingLine(V)
              : desiredScreenInset(V);
          const hostS = layoutRef.current.clampScrollTop(box.top + contentY - desiredInset, V);
          const accepted = commitContinuousGeometry({
            canvas: canvasRef.current,
            host: el,
            layout: layoutRef.current,
            scrollTop: hostS,
          });
          // 应用章内状态（fragment hash / 文本锚点字段）；分页器内部的
          // viewer.scrollTop 随后会被 syncToScrollTop 的投影覆盖。
          if (options.toStart) {
            slot.paginator.navigateWithinCurrentChapter({ toStart: true });
          } else if (options.fragment !== undefined) {
            slot.paginator.navigateWithinCurrentChapter({ fragment: options.fragment });
          } else if (options.readingAnchor) {
            slot.paginator.setReadingAnchor(slot.path, options.readingAnchor);
          }
          const screenY = box.top + contentY - accepted;
          const text = options.readingAnchor && options.readingAnchor.anchorTextOffset !== null
            ? {
                index: options.readingAnchor.index,
                ratio: options.readingAnchor.ratio,
                charsRead: options.readingAnchor.anchorTextOffset,
                totalChars: slot.paginator.totalChars,
                mediaUnits: 0,
                textOffset: options.readingAnchor.anchorTextOffset,
                textSnippet: options.readingAnchor.anchorTextSnippet,
              }
            : null;
          const media = options.mediaAnchor ?? null;
          const committedSpot: ReadingSpot = {
            key: slot.key,
            offset: contentY,
            screenY,
            scrollTop: accepted,
            text,
            media,
          };
          lastStableSpotRef.current = committedSpot;
          readingPositionRef.current = commitExplicitPosition(
            bookSessionRef.current,
            slot.key,
            committedSpot,
          );
          syncToScrollTop(accepted, false);
          props.onInternalNavigationSettled();
          checkVisibleChapterRef.current?.();
          return true;
        },
        navigateToSearchTarget(request) {
          const chapterPath = (request as { chapterPath?: string }).chapterPath;
          const el = containerRef.current;
          if (!el) return "unresolved";
          let slot: ActiveSlot | null = null;
          if (chapterPath) {
            slot = Array.from(slotsRef.current.values()).find((candidate) => candidate.path === chapterPath) ?? null;
          } else {
            const currentAnchor = layoutRef.current.anchorAt(el.scrollTop, V, READING_LINE_RATIO * V);
            slot = currentAnchor ? slotsRef.current.get(currentAnchor.key) ?? null : null;
          }
          if (!slot || slot.status !== "ready" || !slot.paginator.isDisplayReady) {
            return "unresolved";
          }
          const box = layoutRef.current.boxFor(slot.key);
          if (!box) return "unresolved";
          const contentY = slot.paginator.resolveSearchTargetContentY(request);
          if (contentY === null) return "unresolved";
          const status = slot.paginator.applySearchTargetHighlight(request);
          if (status !== "located" && status !== "unsupported-highlight") return status;
          const hostS = layoutRef.current.clampScrollTop(
            box.top + contentY - desiredScreenInset(V),
            V,
          );
          const accepted = commitContinuousGeometry({
            canvas: canvasRef.current,
            host: el,
            layout: layoutRef.current,
            scrollTop: hostS,
          });
          syncToScrollTop(accepted, false);
          onInternalNavigationSettledRef.current?.();
          return status;
        },
        getFootnoteMarkerRect() {
          const el = containerRef.current;
          const S = el?.scrollTop ?? 0;
          const continuousAnchor = layoutRef.current.anchorAt(S, V, READING_LINE_RATIO * V);
          if (!continuousAnchor) return null;
          const slot = slotsRef.current.get(continuousAnchor.key);
          if (!slot) return null;
          const r = slot.paginator.getFootnoteMarkerRect();
          if (!r || !el) return null;
          const hostRect = el.getBoundingClientRect();
          const iframeRect = slot.iframe.getBoundingClientRect();
          const dx = iframeRect.left - hostRect.left;
          const dy = iframeRect.top - hostRect.top;
          return {
            left: r.left + dx,
            top: r.top + dy,
            right: r.right + dx,
            bottom: r.bottom + dy,
          };
        },
        dismissFootnote() {
          for (const slot of slotsRef.current.values()) {
            slot.paginator.dismissFootnote();
          }
        },
        pinFootnote() {
          for (const slot of slotsRef.current.values()) {
            slot.paginator.pinFootnote();
          }
        },
        setFootnoteOverlayHover(over) {
          for (const slot of slotsRef.current.values()) {
            slot.paginator.setFootnoteOverlayHover(over);
          }
        },
        clearTextSelection() {
          for (const slot of slotsRef.current.values()) {
            slot.paginator.clearTextSelection();
          }
        },
        scrollToStart() {
          dampedScrollRef.current.stop();
          for (const slot of slotsRef.current.values()) slot.paginator.closeForNavigation();
          const el = containerRef.current;
          if (!el) return;
          el.scrollTop = 0;
          syncToScrollTop(0, false);
        },
        scrollToEnd() {
          dampedScrollRef.current.stop();
          for (const slot of slotsRef.current.values()) slot.paginator.closeForNavigation();
          const el = containerRef.current;
          if (!el) return;
          const target = layoutRef.current.maxScrollTop(V);
          el.scrollTop = target;
          syncToScrollTop(target, false);
        },
        atScrollBoundary(direction) {
          const el = containerRef.current;
          if (!el) return false;
          if (direction === -1) return el.scrollTop <= 2;
          return el.scrollTop >= layoutRef.current.maxScrollTop(V) - 2;
        },
        scrollByViewport(direction) {
          handleExternalViewportStep(direction);
          return true;
        },
        scrollByDelta(deltaY) {
          handleExternalWheelPixels(deltaY);
        },
      }),
      [V, handleExternalViewportStep, handleExternalWheelPixels, props]
    );

    // 若当前是 linear=no 辅助章节，展示单章临时视图
    if (isLinearNoChapter) {
      return (
        <div className="reader" style={{ position: "relative", width: "100%", height: "100%" }}>
          <iframe
            key={`${spineIndex}:${JSON.stringify(settings)}`}
            ref={(node) => {
              if (!node) return;
              const path = spineItemPath(book, spineIndex);
              if (!path) return;
              // 设置变更会让 key 变化并重建 iframe，这里显式销毁上一份 paginator
              auxPaginatorRef.current?.dispose();
              const paginator = new ChapterPaginator(
                node,
                server,
                effectiveReaderSettings(settings, false),
                false,
                props.onPageState,
                props.onIssues,
                false,
                props.onInternalLink,
                props.onBeforeInternalNavigate,
                props.onInternalNavigationSettled,
                () => {},
                () => {},
                props.onFootnote,
                props.onFootnoteClose,
                props.onExternalLink,
                props.onDisplayReady
              );
              auxPaginatorRef.current = paginator;
              void paginator.load(path, {
                settings: effectiveReaderSettings(settings, false),
                hasNextChapter: false,
                hasPrevChapter: false,
                resetPage: true,
              });
            }}
            title="linear=no auxiliary chapter"
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        </div>
      );
    }

    return (
      <div
        ref={containerRef}
        className="reader reader-continuous"
        data-overlay-input={inputPaused ? "true" : undefined}
        onScroll={handleHostScroll}
        onWheel={(e) => {
          if (inputPaused) {
            e.preventDefault();
            return;
          }
          if (e.deltaY !== 0) {
            e.preventDefault();
            const deltaY = continuousWheelPixels(e.deltaY, e.deltaMode, 28, V);
            handleExternalWheelPixels(deltaY);
          }
        }}
        style={{
          // 重排补偿由阅读器自己写入 scrollTop；浏览器 scroll anchoring 若同时
          // 生效会与补偿互相抵消，这里关闭它，也不为每张图加补偿监听。
          overflowAnchor: "none",
          position: "relative",
        }}
      >
        <div
          ref={canvasRef}
          className="continuous-canvas"
          style={{
            position: "relative",
            height: `${layout.totalHeight}px`,
            width: "100%",
          }}
        >
          {projections.map((p) => {
            const slot = slotsRef.current.get(p.box.key);
            const isReady = slot?.status === "ready";
            const isError = slot?.status === "error";
            const item = linearItems[p.box.index];
            const chapterTitle = findChapterTitle(book.toc, item?.path ?? "") ?? `第 ${p.box.index + 1} 章`;

            return (
              <div
                key={p.box.key}
                className="chapter-wrapper"
                {...{ [CHAPTER_KEY_ATTRIBUTE]: p.box.key }}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: `${p.box.top}px`,
                  height: `${p.box.height}px`,
                  overflow: "clip",
                }}
              >
                {!isReady && !isError && (
                  <div className="chapter-placeholder">
                    <span className="chapter-placeholder-title">{chapterTitle}</span>
                    <span className="chapter-placeholder-hint">正在准备…</span>
                  </div>
                )}
                {isError && (
                  <div className="chapter-placeholder">
                    <span className="chapter-placeholder-title">{chapterTitle}</span>
                    <span className="chapter-placeholder-error">章节加载失败</span>
                    <button
                      type="button"
                      className="chapter-retry-btn"
                      onClick={() => {
                        retryCountersRef.current.set(p.box.key, (retryCountersRef.current.get(p.box.key) ?? 0) + 1);
                        slotsRef.current.delete(p.box.key);
                        if (item) {
                          void loadChapterSlot(p.box.key, item.path, item.index);
                        }
                      }}
                    >
                      重试
                    </button>
                  </div>
                )}
                <div
                  ref={(node) => attachIframe(p.box.key, node)}
                  style={{
                    // 承载 iframe 的容器必须始终参与布局。display:none 会让 iframe
                    // 完全退出布局，章节内容高度只能测到 0；而高度测量本身又是
                    // 章节转为 ready 的前提，两者会互锁成永久加载态。
                    // 未就绪时改用 visibility 隐藏：既保证可测量，也不会把未定位好
                    // 的中间状态露给读者（iframe 自身另有显示门保护第一帧）。
                    display: "block",
                    visibility: isReady ? "visible" : "hidden",
                    width: "100%",
                    height: "100%",
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);
