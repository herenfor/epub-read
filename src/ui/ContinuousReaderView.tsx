import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
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
} from "../render/paginator";
import type { ResourceServer } from "../render/resources";
import type { ReaderSettings } from "../render/settings";
import {
  ContinuousChapterLayout,
  ChapterLoadGate,
  type ChapterExtent,
  type ChapterProjection,
  type ChapterLoadTicket,
  type ContinuousAnchor,
} from "./continuousChapterLayout";
import { CHAPTER_KEY_ATTRIBUTE, commitContinuousGeometry } from "./continuousGeometryCommit";
import { canCommitContinuousChapterHeight } from "./continuousChapterGeometry";
import { DampedScrollAnimator } from "./dampedScroll";
import { createSettingsReloadDebouncer } from "./settingsReload";
import { effectiveReaderSettings, sameRenderingSettings, type ReaderHandle } from "./ReaderView";

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
  onPreciseNavigationStatus?(status: {
    requestId: number;
    status: PreciseNavigationStatus;
    exact: boolean;
  }): void;
  initialAnchor?: {
    index: number;
    ratio: number;
    anchorTextOffset: number | null;
    anchorTextSnippet: string | null;
  } | null;
  initialPage?: number | null;
  /** 视口上方约 20% 阅读线采样观察到的章节变化；只更新状态，不触发重载 */
  onVisibleChapterChange?(index: number, anchor: ReadingAnchor | null): void;
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
}

/** 测量未就绪（容器尚未布局）时的按帧重测上限，避免极端情况下无限重试。 */
const MEASURE_RETRY_LIMIT = 180;

/** 视口上方 20% 是连续阅读的“阅读线”，锚点采样与状态展示共用同一位置。 */
const READING_LINE_RATIO = 0.2;

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

    const containerRef = useRef<HTMLDivElement>(null);
    /** 显式总高的 canvas：几何提交必须先于宿主 scrollTop，见 commitContinuousGeometry。 */
    const canvasRef = useRef<HTMLDivElement>(null);
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
          return path ? { ...item, index: originalIndex, path } : null;
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

    const [layout, setLayout] = useState(() => new ContinuousChapterLayout(initialExtents));
    const layoutRef = useRef(layout);
    layoutRef.current = layout;

    // 监听换书/线性 spine 变化重新初始化 layout（尺寸变化走重排事务）
    useEffect(() => {
      const estimate = viewportHeightRef.current > 0 ? viewportHeightRef.current : 600;
      const extents = linearItems.map((item) => ({
        key: `${item.index}:${item.path}`,
        height: estimate,
        measured: false,
      }));
      const next = new ContinuousChapterLayout(extents);
      layoutRef.current = next;
      setLayout(next);
      pendingSpotRef.current = null;
      lastStableSpotRef.current = null;
    }, [book, linearItems]);

    const gateRef = useRef(new ChapterLoadGate());
    const slotsRef = useRef(new Map<string, ActiveSlot>());
    const retryCountersRef = useRef(new Map<string, number>());
    const [, setSlotUpdateNonce] = useState(0);

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
    const overscan = settings.preloadNextChapter === true ? 1.5 * V : 0.5 * V;
    const [currentScrollTop, setCurrentScrollTop] = useState(0);
    const scrollTopRef = useRef(0);

    const projections = useMemo(() => {
      return layout.project(scrollTopRef.current, V, overscan);
    }, [layout, V, overscan, currentScrollTop]);
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
          if (glyphY !== null) {
            return {
              key,
              offset: glyphY,
              screenY: projection.box.top + glyphY - clampTop,
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
      const el = containerRef.current;
      if (!el) return;
      const S = el.scrollTop;
      const readingLineY = READING_LINE_RATIO * V;
      const anchor = layoutRef.current.anchorAt(S, V, readingLineY);
      if (!anchor) return;
      const slot = slotsRef.current.get(anchor.key);
      if (slot && slot.status === "ready") {
        // 用当前布局表现算投影：React state 里的 projections 可能落后一帧，
        // 会让“上次稳定锚点”的章内坐标失真。
        const p = layoutRef.current
          .project(S, V, overscan)
          .find((item) => item.box.key === anchor.key);
        const frameScreenTop = p ? p.frameScreenTop : 0;
        const sample = sampleReadingLine(slot, readingLineY - frameScreenTop);
        // 保存“上次稳定”的阅读位置：重排与图片晚加载补偿都只能用这个
        // 稳定锚点，不能在已变化的几何里重新挑一个“当前内容”。
        // 事务进行中的采样同样属于“已变化、未提交”，必须丢弃而不是覆盖保存点。
        if (!pendingSpotRef.current && reloadingRef.current.size === 0 && slot.paginator.isMeasuredForViewport()) {
          lastStableSpotRef.current = buildReadingSpot(
            anchor.key,
            slot,
            p,
            S,
            sample,
            { offset: anchor.offset, screenY: anchor.screenY }
          );

        }
        if (sample.fine) {
          if (lastVisibleKeyRef.current !== anchor.key) {
            lastVisibleKeyRef.current = anchor.key;
            onVisibleChapterChange?.(slot.spineIndex, sample.fine.anchor);
          }
          onPageState?.({
            status: "ready",
            pageCount: 1,
            currentPage: 0,
            empty: false,
            mode: "scroll",
            scrollProgress: sample.fine.anchor.ratio,
          });
        }
      }
    }, [V, buildReadingSpot, onPageState, onVisibleChapterChange, overscan, sampleReadingLine]);
    checkVisibleChapterRef.current = checkVisibleChapter;

    /** 把宿主已确定的最新滚动位置同步到投影与章节状态。 */
    const syncToScrollTop = useCallback(
      (S: number, userScroll = false) => {
        // 用户在等待重排时仍可滚动：移动保存点的屏幕位置，不用尚未提交的
        // 新 DOM 重新命中另一段文字。程序化补偿不再次累计这段位移。
        if (userScroll) {
          const saved = pendingSpotRef.current ? pendingSpotRef : lastStableSpotRef;
          const spot = saved.current;
          if (spot) {
            saved.current = {
              ...spot,
              screenY: spot.screenY - (S - spot.scrollTop),
              scrollTop: S,
            };
          }
        }
        scrollTopRef.current = S;
        const currentProjections = layoutRef.current.project(S, V, overscan);
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
      [V, checkVisibleChapter, overscan, syncProjectionDoms]
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
        .project(S, V, overscan)
        .find((p) => p.box.key === base.key);
      const fallback = { offset: base.offset, screenY: base.screenY };
      if (!slot || slot.status !== "ready" || !projection) {
        return pixelSpot(base.key, fallback.offset, fallback.screenY, S);
      }
      const sample = sampleReadingLine(slot, READING_LINE_RATIO * V - projection.frameScreenTop);
      return buildReadingSpot(base.key, slot, projection, S, sample, fallback);
    }, [V, buildReadingSpot, overscan, sampleReadingLine]);

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
          const measuredHere = updates.some((update) => update.key === effective!.key);
          const slot = measuredHere ? slotsRef.current.get(effective.key) : undefined;
          if (slot && effective.text) {
            // 同一文本位置在新几何里的字形坐标：宽度变化导致换行时，
            // 旧像素位置不足以保持同一行文字（R2）。
            const resolved = slot.paginator.resolveAnchorContentY(effective.text);
            if (resolved !== null) offset = resolved;
          } else if (slot && effective.media) {
            // 纯图片页：用图内比例在缩放后的实际图高上重建（R3）。
            const resolved = slot.paginator.resolveMediaAnchorContentY(effective.media);
            if (resolved !== null) offset = resolved;
          }
          anchor = { key: effective.key, offset, screenY: effective.screenY };
        }
        const { layout: newLayout, scrollTop: newS } = layoutRef.current.withMeasurements(
          updates,
          anchor,
          V,
          currentS
        );
        layoutRef.current = newLayout;
        setLayout(newLayout);
        // 先几何、后位置：同步写 DOM，不依赖 React 已渲染。
        const accepted = commitContinuousGeometry({
          canvas: canvasRef.current,
          host: el,
          layout: newLayout,
          scrollTop: newS,
        });
        if (el) {
          // 只改原生 scrollTop 不够：React 状态/ref 与 iframe 投影必须同步，
          // 否则下一次渲染会用旧位置覆盖补偿结果。
          syncToScrollTop(accepted);
        }
        setSlotUpdateNonce((n) => n + 1);
      },
      [V, syncToScrollTop]
    );
    commitLayoutBatchRef.current = commitLayoutBatch;

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
            if (!canCommitContinuousChapterHeight({ height, laidOut })) {
              pending = true;
              continue;
            }
            updates.push({ key, height, measured: true });
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
      // 旧阻尼目标基于旧几何，补偿后会把位置拉回
      dampedScrollRef.current.stop();
      scheduleLayoutRemeasure(lastStableSpotRef.current ?? captureReadingSpot());
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
        slot.iframe.style.height = `${V}px`;
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
        iframe.style.height = `${currentV}px`;
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
          }
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

        try {
          await paginator.load(path, {
            settings: effectiveSettings,
            hasNextChapter: nextLinearIndex(book, spineIdx, 1) >= 0,
            hasPrevChapter: nextLinearIndex(book, spineIdx, -1) >= 0,
            resetPage: true,
            preciseNavigation:
              preciseTarget && preciseTarget.chapterPath === path
                ? {
                    requestId: preciseTarget.requestId,
                    kind: preciseTarget.kind,
                    textHits: preciseTarget.textHits,
                  }
                : null,
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
        server,
        settings,
      ]
    );

    /**
     * 提交一次章节高度测量。
     *
     * 只有测量到正高度、且承载 iframe 的容器确实参与布局时才提交：包裹层在
     * 章节就绪前是 display:none，此间 iframe 不布局，测量必然是 0；把 0 当作
     * “已测量”写进布局会让整本书总高塌成 0，投影窗口随即清空，iframe 再也
     * 挂载不上，阅读器永久停在加载态。测不准就保留估算高度，交给
     * scheduleChapterMeasurement 在下一帧重测。
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
        if (!canCommitContinuousChapterHeight({ height, laidOut })) return false;

        if (!sameChapterReload) {
          if (!gateRef.current.finish(ticket)) return true;
          slot.status = "ready";
        }
        // 统一的批量提交入口：新高度、宿主位置与 iframe 投影同帧生效。
        // 必须走最新实现，不能用创建时的闭包旧 V / 旧几何（R4）。
        if (pendingSpotRef.current || reloadingRef.current.size > 0) {
          scheduleLayoutRemeasure(pendingSpotRef.current);
        } else {
          commitLayoutBatchRef.current([{ key, height, measured: true }], null);
        }
        void reloadSlotSettingsRef.current(slot);
        if (!sameChapterReload) {
          onDisplayReady?.();
        }
        // 首章就绪后同步一次可见章节状态，否则状态栏会一直停在“加载中…”
        // （滚动模式的状态由 checkVisibleChapter 驱动，而打开书并不会触发滚动）。
        checkVisibleChapterRef.current?.();
        return true;
      },
      [onDisplayReady, scheduleLayoutRemeasure]
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
        // 先找真正处于可视区（visible=true）且未加载的章节
        const needed = projections.find((p) => !slotsRef.current.has(p.box.key));
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
    }, [linearItems, loadChapterSlot, projections]);

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
      const currentNonce = props.anchorNonce;
      if (currentNonce === lastNavigatedNonceRef.current) return;
      lastNavigatedNonceRef.current = currentNonce;

      const path = spineItemPath(book, spineIndex);
      if (!path) return;
      const targetKey = `${spineIndex}:${path}`;
      const targetBox = layoutRef.current.boxes.find((b) => b.key === targetKey);
      if (!targetBox) return;

      const el = containerRef.current;
      if (!el) return;
      // 显式导航（目录/搜索/笔记/书签/历史）必须即刻到位，不允许残余阻尼动画抢位置
      dampedScrollRef.current.stop();

      // 如果目标章节已测量就绪且带有 anchor
      if (props.anchor) {
        const slot = slotsRef.current.get(targetKey);
        const doc = slot?.iframe?.contentDocument;
        const anchorEl = doc?.getElementById(props.anchor);
        if (anchorEl) {
          const targetTop = anchorEl.getBoundingClientRect().top - (slot?.iframe?.getBoundingClientRect().top ?? 0);
          const desiredS = layoutRef.current.clampScrollTop(targetBox.top + targetTop - 0.1 * V, V);
          el.scrollTop = desiredS;
          props.onInternalNavigationSettled();
          return;
        }
      }

      // 默认按章节起点对齐
      const desiredS = layoutRef.current.clampScrollTop(targetBox.top, V);
      el.scrollTop = desiredS;
    }, [book, props, spineIndex, V]);

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
        diagnose() {
          const loadedKeys = Array.from(slotsRef.current.keys()).join(", ");
          return `ContinuousReaderView: totalHeight=${layoutRef.current.totalHeight} V=${V} scrollTop=${containerRef.current?.scrollTop ?? 0} loaded=[${loadedKeys}]`;
        },
        getReadingAnchor() {
          const el = containerRef.current;
          const S = el?.scrollTop ?? 0;
          const continuousAnchor = layoutRef.current.anchorAt(S, V, READING_LINE_RATIO * V);
          if (!continuousAnchor) return null;
          const slot = slotsRef.current.get(continuousAnchor.key);
          return slot?.paginator.getReadingAnchor() ?? null;
        },
        getAnchorText() {
          const el = containerRef.current;
          const S = el?.scrollTop ?? 0;
          const continuousAnchor = layoutRef.current.anchorAt(S, V, READING_LINE_RATIO * V);
          if (!continuousAnchor) return null;
          const slot = slotsRef.current.get(continuousAnchor.key);
          return slot?.paginator.getAnchorText() ?? null;
        },
        jumpToAnchor(anchorStr) {
          const el = containerRef.current;
          if (!el) return;
          for (const slot of slotsRef.current.values()) {
            const doc = slot.iframe?.contentDocument;
            const target = doc?.getElementById(anchorStr);
            if (target) {
              const box = layoutRef.current.boxes.find((b) => b.key === slot.key);
              if (box) {
                const targetTop = target.getBoundingClientRect().top - slot.iframe.getBoundingClientRect().top;
                el.scrollTop = layoutRef.current.clampScrollTop(box.top + targetTop - 0.1 * V, V);
                return;
              }
            }
          }
        },
        navigateWithinCurrentChapter(options: WithinChapterNavigationOptions) {
          const el = containerRef.current;
          const S = el?.scrollTop ?? 0;
          const continuousAnchor = layoutRef.current.anchorAt(S, V, READING_LINE_RATIO * V);
          if (!continuousAnchor) return false;
          const slot = slotsRef.current.get(continuousAnchor.key);
          if (!slot) return false;
          const navigated = slot.paginator.navigateWithinCurrentChapter(options);
          if (navigated) props.onInternalNavigationSettled();
          return navigated;
        },
        navigateToSearchTarget(request) {
          for (const slot of slotsRef.current.values()) {
            const status = slot.paginator.navigateToSearchTarget(request);
            if (status === "located") return status;
          }
          return "unresolved";
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
          if (containerRef.current) containerRef.current.scrollTop = 0;
        },
        scrollToEnd() {
          dampedScrollRef.current.stop();
          if (containerRef.current) {
            containerRef.current.scrollTop = layoutRef.current.maxScrollTop(V);
          }
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
          }
        }}
        style={{
          // 重排补偿由阅读器自己写入 scrollTop；浏览器 scroll anchoring 若同时
          // 生效会与补偿互相抵消，这里关闭它，也不为每张图加补偿监听。
          overflowAnchor: "none",
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
