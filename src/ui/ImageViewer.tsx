import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { ImageViewRequest } from "../render/imageActivation";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  MinusIcon,
  PlusIcon,
  RotateLeftIcon,
  RotateRightIcon,
} from "./readerIcons";
import type { ReaderVisualPreferences } from "../render/visual/readerVisualPreferences";
import { DEFAULT_VISUAL_PREFERENCES } from "../render/visual/readerVisualPreferences";
import { attachReaderPaint } from "../render/visual/readerVisualPaint";
import type { ReaderPaintHandle } from "../render/visual/readerVisualPreferences";
import {
  MIN_IMAGE_SCALE,
  clampImagePan,
  clampScale,
  computeFitScale,
  displayPercent,
  fitOrActualTargetScale,
  isAtFit,
  maxScaleForFit,
  nextDoubleTapScale,
  normalizeQuarterTurns,
  pointerDistance,
  pointerMidpoint,
  rotatedSize,
  swipeDirection,
  toViewerPoint,
  wheelZoomFactor,
  zoomAt,
  type ImageTransform,
  type Point,
} from "./imageViewerGeometry";
import "./imageViewer.css";
import { useUiText } from "./localization/UiLanguageProvider";

export interface ImageViewerProps {
  image: ImageViewRequest | null;
  onClose(): void;
  onFollowLink?(image: ImageViewRequest): void;
  visualPreferences?: ReaderVisualPreferences;
  compareOriginal?: boolean;
  onCompareOriginalChange?(next: boolean): void;
}

interface ViewportSize {
  width: number;
  height: number;
}

type Gesture =
  | { kind: "pan"; pointerId: number; start: ImageTransform; startPoint: Point; swipe: boolean }
  | { kind: "pinch"; start: ImageTransform; startDistance: number; startMidpoint: Point };

type Edge = "prev" | "next" | null;

/** 小于该位移的按压算点击，避免把点按误判成拖动。 */
const CLICK_DRAG_TOLERANCE = 4;
const BUTTON_ZOOM_STEP = 1.25;
const FIT_STATE_EPSILON = 0.01;
/** 桌面鼠标静止多久后隐去控件。 */
export const CHROME_IDLE_MS = 2500;
/** 触屏单击要等这么久确认不是双击，再切换控件。 */
export const TAP_TOGGLE_DELAY_MS = 280;
/** 指针离左右边缘这么近时显示翻图箭头。 */
const EDGE_REVEAL_DISTANCE = 96;
/** 首/末张继续横滑时的阻尼。 */
const SWIPE_EDGE_RESISTANCE = 0.3;

function prefersCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function isFocusVisible(element: Element): boolean {
  try {
    return typeof element.matches === "function" && element.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * 正文图片浮层：不透明深色全屏 + 本章图片的缩放/拖动/旋转/前后翻看。
 *
 * 只消费已由 `imageRequestFromTarget` 识别好的请求（含本章图集），不解析资源、不持有 Book/ResourceServer，
 * 也不自行打开链接：有 linkHref 且父级提供 onFollowLink 时显示“打开链接”，交回原链接路由。
 * 打开/关闭/翻看只影响本浮层，不触碰书页图片尺寸与阅读位置；旋转不保存。
 */
export function ImageViewer({
  image,
  onClose,
  onFollowLink,
  visualPreferences = DEFAULT_VISUAL_PREFERENCES,
  compareOriginal = false,
  onCompareOriginalChange,
}: ImageViewerProps) {
  const { t } = useUiText();
  const open = image !== null;
  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const paintSurfaceRef = useRef<HTMLDivElement>(null);
  const visualOverlayRef = useRef<HTMLDivElement>(null);
  const paintHandleRef = useRef<ReaderPaintHandle | null>(null);
  const visualPreferencesRef = useRef(visualPreferences);
  visualPreferencesRef.current = visualPreferences;
  const compareOriginalRef = useRef(compareOriginal);
  compareOriginalRef.current = compareOriginal;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const gestureRef = useRef<Gesture | null>(null);
  const draggedRef = useRef(false);
  const lastPointerTypeRef = useRef<string>("");
  const transformRef = useRef<ImageTransform>({ scale: MIN_IMAGE_SCALE, x: 0, y: 0 });
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerOverControlRef = useRef(false);

  const [size, setSize] = useState<ViewportSize>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<ImageTransform>(transformRef.current);
  const [quarterTurns, setQuarterTurns] = useState(0);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [nearEdge, setNearEdge] = useState<Edge>(null);

  // 图集：请求带合法 gallery 时按本章列表翻看，否则只有这一张。序号跟着请求对象走，换请求即回到其起始序号。
  const gallery = image?.gallery;
  const validGallery = Boolean(
    gallery && gallery.items.length > 1 && gallery.index >= 0 && gallery.index < gallery.items.length,
  );
  const total = validGallery && gallery ? gallery.items.length : image ? 1 : 0;
  const startIndex = validGallery && gallery ? gallery.index : 0;
  const [selection, setSelection] = useState<{ source: ImageViewRequest | null; index: number }>({
    source: image,
    index: startIndex,
  });
  const index = selection.source === image ? selection.index : startIndex;
  const current = useMemo<ImageViewRequest | null>(() => {
    if (!image) return null;
    if (!validGallery || !gallery) return image;
    const item = gallery.items[index];
    return item ? { ...item, chapterPath: image.chapterPath } : image;
  }, [image, gallery, validGallery, index]);

  // 回调放 ref，避免父级内联函数让焦点/键盘 effect 每次渲染重跑。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onFollowLinkRef = useRef(onFollowLink);
  onFollowLinkRef.current = onFollowLink;

  useEffect(() => {
    if (!open) return;
    const surface = paintSurfaceRef.current;
    const host = visualOverlayRef.current;
    if (!surface || !host) return;
    const handle = attachReaderPaint(surface, host, visualPreferencesRef.current, null);
    paintHandleRef.current = handle;
    handle.update(visualPreferencesRef.current, compareOriginalRef.current);
    return () => {
      handle.dispose();
      if (paintHandleRef.current === handle) paintHandleRef.current = null;
      onCompareOriginalChange?.(false);
    };
  }, [open, current?.src]);

  useEffect(() => {
    paintHandleRef.current?.update(visualPreferences, compareOriginal);
  }, [visualPreferences, compareOriginal]);

  const naturalWidth = current?.naturalWidth ?? 0;
  const naturalHeight = current?.naturalHeight ?? 0;
  // 适配与平移边界都按旋转后的宽高算；img 自身仍是未旋转的宽高，由 CSS rotate 转过去。
  const rotated = rotatedSize(naturalWidth, naturalHeight, quarterTurns);
  const fitScale = computeFitScale(rotated.width, rotated.height, size.width, size.height);
  const maxScale = maxScaleForFit(fitScale);
  const baseWidth = Math.max(1, naturalWidth * fitScale);
  const baseHeight = Math.max(1, naturalHeight * fitScale);
  const boundsWidth = Math.max(1, rotated.width * fitScale);
  const boundsHeight = Math.max(1, rotated.height * fitScale);
  const atFit = isAtFit(transform.scale);
  const atMax = transform.scale >= maxScale - FIT_STATE_EPSILON;
  const hasPrev = index > 0;
  const hasNext = index < total - 1;

  const commitTransform = useCallback(
    (next: ImageTransform) => {
      const settled = clampImagePan(next, boundsWidth, boundsHeight, size.width, size.height);
      transformRef.current = settled;
      setTransform(settled);
    },
    [boundsWidth, boundsHeight, size.width, size.height],
  );

  const readViewportRect = useCallback(() => {
    const stage = stageRef.current;
    const rect = stage && typeof stage.getBoundingClientRect === "function" ? stage.getBoundingClientRect() : null;
    if (rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)) {
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
    return { left: 0, top: 0, width: size.width, height: size.height };
  }, [size.width, size.height]);

  const resetView = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current = null;
    draggedRef.current = false;
    transformRef.current = { scale: MIN_IMAGE_SCALE, x: 0, y: 0 };
    setTransform(transformRef.current);
    setQuarterTurns(0);
    setSwipeOffset(0);
  }, []);

  // 每次打开/换图都回到适配居中、旋转归零，并清空未完成的手势。
  useEffect(() => {
    resetView();
  }, [open, image, index, resetView]);

  // 尺寸/横竖屏/旋转变化：保留有效缩放比例，重新约束平移。
  useEffect(() => {
    const now = transformRef.current;
    const scale = clampScale(now.scale, MIN_IMAGE_SCALE, maxScale);
    const settled = clampImagePan({ ...now, scale }, boundsWidth, boundsHeight, size.width, size.height);
    transformRef.current = settled;
    setTransform(settled);
  }, [boundsWidth, boundsHeight, maxScale, size.width, size.height]);

  const goTo = useCallback(
    (next: number) => {
      if (!image || next < 0 || next >= total || next === index) return;
      setSelection({ source: image, index: next });
    },
    [image, total, index],
  );
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const indexRef = useRef(index);
  indexRef.current = index;

  const rotate = useCallback((delta: number) => {
    setQuarterTurns((turns) => normalizeQuarterTurns(turns + delta));
    // 旋转后回到适配；边界由上面的尺寸 effect 按新宽高重算。
    transformRef.current = { scale: MIN_IMAGE_SCALE, x: 0, y: 0 };
    setTransform(transformRef.current);
  }, []);
  const rotateRef = useRef(rotate);
  rotateRef.current = rotate;

  // ---- 控件显隐 ----
  const scheduleIdleHide = useCallback(() => {
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
    // 触屏不靠计时隐藏，只靠单击图片切换。
    const pointerType = lastPointerTypeRef.current;
    if (pointerType === "touch" || (!pointerType && prefersCoarsePointer())) return;
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      // 按住原图对比、指针停在控件上、键盘焦点在控件上时不隐去。
      if (compareOriginalRef.current || pointerOverControlRef.current) return;
      const doc = typeof document === "undefined" ? null : document;
      const active = doc?.activeElement as Element | null | undefined;
      const root = overlayRef.current;
      if (active && root && typeof root.contains === "function" && root.contains(active) && isFocusVisible(active)) {
        return;
      }
      setChromeVisible(false);
      setNearEdge(null);
    }, CHROME_IDLE_MS);
  }, []);
  const revealChrome = useCallback(() => {
    setChromeVisible(true);
    scheduleIdleHide();
  }, [scheduleIdleHide]);
  const revealChromeRef = useRef(revealChrome);
  revealChromeRef.current = revealChrome;

  useEffect(() => {
    if (!open) return;
    setChromeVisible(true);
    scheduleIdleHide();
    return () => {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
      if (tapTimerRef.current !== null) clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    };
  }, [open, scheduleIdleHide]);

  // 打开时焦点进入弹层，关闭时回到原焦点；Esc 关闭，Tab 不跑到背景；
  // 方向键/翻页键归浮层，不在背后翻书页。
  useEffect(() => {
    if (!open) return;
    const doc = typeof document === "undefined" ? null : document;
    const previous = (doc?.activeElement as HTMLElement | null) ?? null;
    restoreFocusRef.current = previous && typeof previous.focus === "function" ? previous : null;
    closeButtonRef.current?.focus?.();
    if (!doc) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (plain && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        event.stopPropagation();
        goToRef.current(indexRef.current + (event.key === "ArrowRight" ? 1 : -1));
        return;
      }
      if (plain && (event.key === "r" || event.key === "R")) {
        event.preventDefault();
        event.stopPropagation();
        rotateRef.current(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === "PageUp" || event.key === "PageDown" || event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // 空格保留按钮的默认激活，只拦住书页翻页。
      if (event.key === " ") {
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;
      revealChromeRef.current();
      const root = overlayRef.current;
      if (!root || typeof root.querySelectorAll !== "function") return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"),
      );
      if (focusables.length === 0) return;
      event.preventDefault();
      const active = doc.activeElement as HTMLElement | null;
      const position = active ? focusables.indexOf(active) : -1;
      const next = event.shiftKey
        ? position <= 0
          ? focusables.length - 1
          : position - 1
        : position === -1 || position >= focusables.length - 1
          ? 0
          : position + 1;
      focusables[next]?.focus?.();
    };

    doc.addEventListener("keydown", onKeyDown);
    return () => {
      doc.removeEventListener("keydown", onKeyDown);
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target && typeof target.focus === "function" && target.isConnected !== false) target.focus();
    };
  }, [open]);

  // 测量浮层可用区（stage 自身尺寸，已扣 safe-area 与桌面顶/底栏留白）。
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = typeof stage.getBoundingClientRect === "function" ? stage.getBoundingClientRect() : null;
      const width = rect && Number.isFinite(rect.width) && rect.width > 0 ? rect.width : 0;
      const height = rect && Number.isFinite(rect.height) && rect.height > 0 ? rect.height : 0;
      setSize((now) => (now.width === width && now.height === height ? now : { width, height }));
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(stage);
    if (typeof window !== "undefined") window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      if (typeof window !== "undefined") window.removeEventListener("resize", measure);
    };
  }, [open]);

  // 滚轮要用非 passive 原生监听才能阻止翻页/滚动；以指针为中心缩放。
  useEffect(() => {
    if (!open) return;
    const overlay = overlayRef.current;
    if (!overlay || typeof overlay.addEventListener !== "function") return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY === 0) return;
      const focus = toViewerPoint(event.clientX, event.clientY, readViewportRect());
      const factor = wheelZoomFactor(event.deltaY);
      const now = transformRef.current;
      const nextScale = clampScale(now.scale * factor, MIN_IMAGE_SCALE, maxScale);
      commitTransform(zoomAt(now, focus, focus, nextScale));
    };
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", onWheel);
  }, [open, readViewportRect, commitTransform, maxScale]);

  const beginGesture = useCallback((swipe = false) => {
    const points = Array.from(pointersRef.current.entries());
    if (points.length >= 2) {
      const [first, second] = points;
      const distance = pointerDistance(first[1], second[1]);
      gestureRef.current = {
        kind: "pinch",
        start: transformRef.current,
        startDistance: distance > 0 ? distance : 1,
        startMidpoint: pointerMidpoint(first[1], second[1]),
      };
      setSwipeOffset(0);
      return;
    }
    if (points.length === 1) {
      const [pointerId, startPoint] = points[0];
      gestureRef.current = { kind: "pan", pointerId, start: transformRef.current, startPoint, swipe };
      return;
    }
    gestureRef.current = null;
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    if (typeof element.setPointerCapture === "function") {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        /* 指针已失效时忽略，本节仍按集合继续跟踪 */
      }
    }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    draggedRef.current = false;
    // 触屏在适配态单指横滑 = 换图；放大后单指拖动仍是平移。
    const swipe =
      event.pointerType === "touch" &&
      pointersRef.current.size === 1 &&
      total > 1 &&
      isAtFit(transformRef.current.scale);
    beginGesture(swipe);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.kind === "pan") {
      const point = pointers.get(gesture.pointerId);
      if (!point) return;
      const dx = point.x - gesture.startPoint.x;
      const dy = point.y - gesture.startPoint.y;
      if (Math.abs(dx) > CLICK_DRAG_TOLERANCE || Math.abs(dy) > CLICK_DRAG_TOLERANCE) draggedRef.current = true;
      if (gesture.swipe) {
        const blocked = (dx > 0 && indexRef.current <= 0) || (dx < 0 && indexRef.current >= total - 1);
        setSwipeOffset(blocked ? dx * SWIPE_EDGE_RESISTANCE : dx);
        return;
      }
      commitTransform({ scale: gesture.start.scale, x: gesture.start.x + dx, y: gesture.start.y + dy });
      return;
    }

    const entries = Array.from(pointers.values());
    if (entries.length < 2) return;
    const distance = pointerDistance(entries[0], entries[1]);
    const midpoint = pointerMidpoint(entries[0], entries[1]);
    draggedRef.current = true;
    const rect = readViewportRect();
    const nextScale = clampScale(
      gesture.start.scale * (distance / gesture.startDistance),
      MIN_IMAGE_SCALE,
      maxScale,
    );
    commitTransform(
      zoomAt(
        gesture.start,
        toViewerPoint(gesture.startMidpoint.x, gesture.startMidpoint.y, rect),
        toViewerPoint(midpoint.x, midpoint.y, rect),
        nextScale,
      ),
    );
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    const gesture = gestureRef.current;
    if (pointers.has(event.pointerId) && gesture?.kind === "pan" && gesture.swipe && gesture.pointerId === event.pointerId) {
      const point = pointers.get(event.pointerId)!;
      const dx = (Number.isFinite(event.clientX) ? event.clientX : point.x) - gesture.startPoint.x;
      const dy = (Number.isFinite(event.clientY) ? event.clientY : point.y) - gesture.startPoint.y;
      setSwipeOffset(0);
      const direction = event.type === "pointercancel" ? 0 : swipeDirection(dx, dy);
      if (direction !== 0) goToRef.current(indexRef.current + direction);
    }
    pointers.delete(event.pointerId);
    const element = event.currentTarget;
    if (
      typeof element.releasePointerCapture === "function" &&
      typeof element.hasPointerCapture === "function" &&
      element.hasPointerCapture(event.pointerId)
    ) {
      try {
        element.releasePointerCapture(event.pointerId);
      } catch {
        /* 捕获已释放 */
      }
    }
    beginGesture();
  };

  /** 触屏单击图片切换控件；等过双击窗口再切，第二下点击说明是双击，交给 dblclick。 */
  const handleImageTap = () => {
    if (tapTimerRef.current !== null) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
      return;
    }
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null;
      setChromeVisible((visible) => !visible);
    }, TAP_TOGGLE_DELAY_MS);
  };

  /** 背景关闭；拖动结束的 click 被抑制，点击图片/控件不关闭。 */
  const handleOverlayClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    const target = event.target as Element | null;
    if (target && typeof target.closest === "function" && target.closest("button, a, .image-viewer-chrome")) return;
    if (target && typeof target.closest === "function" && target.closest("img")) {
      if (lastPointerTypeRef.current === "touch") handleImageTap();
      return;
    }
    onCloseRef.current();
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (tapTimerRef.current !== null) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
    const focus = toViewerPoint(event.clientX, event.clientY, readViewportRect());
    const now = transformRef.current;
    const nextScale = nextDoubleTapScale(now.scale, maxScale);
    commitTransform(zoomAt(now, focus, focus, nextScale));
  };

  /** 桌面鼠标移动：唤回控件、重新计时，并按离左右边缘的距离显示翻图箭头。 */
  const handleOverlayPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const target = event.target as Element | null;
    pointerOverControlRef.current = Boolean(
      target && typeof target.closest === "function" && target.closest("button"),
    );
    revealChrome();
    const root = overlayRef.current;
    const rect = root && typeof root.getBoundingClientRect === "function" ? root.getBoundingClientRect() : null;
    let edge: Edge = null;
    if (rect && rect.width > 0 && total > 1) {
      const x = event.clientX - rect.left;
      if (x <= EDGE_REVEAL_DISTANCE) edge = "prev";
      else if (x >= rect.width - EDGE_REVEAL_DISTANCE) edge = "next";
    }
    setNearEdge((now) => (now === edge ? now : edge));
  };

  const handleOverlayPointerLeave = () => {
    pointerOverControlRef.current = false;
    setNearEdge(null);
  };

  const zoomAroundCenter = (factor: number) => {
    const now = transformRef.current;
    const nextScale = clampScale(now.scale * factor, MIN_IMAGE_SCALE, maxScale);
    commitTransform(zoomAt(now, { x: 0, y: 0 }, { x: 0, y: 0 }, nextScale));
  };

  /** 百分比：适配 ↔ 原始大小（1:1）。 */
  const toggleFitOrActual = () => {
    const now = transformRef.current;
    const nextScale = fitOrActualTargetScale(now.scale, fitScale, maxScale);
    if (isAtFit(nextScale)) {
      commitTransform({ scale: MIN_IMAGE_SCALE, x: 0, y: 0 });
      return;
    }
    commitTransform(zoomAt(now, { x: 0, y: 0 }, { x: 0, y: 0 }, nextScale));
  };

  if (!image || !current) return null;

  const percent = displayPercent(fitScale, transform.scale);
  const rootClass = [
    "image-viewer",
    chromeVisible ? "" : "is-chrome-hidden",
    atFit ? "is-fit" : "is-zoomed",
    swipeOffset !== 0 ? "is-swiping" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const showLink = Boolean(current.linkHref && onFollowLinkRef.current);

  return (
    <div
      ref={overlayRef}
      className={rootClass}
      role="dialog"
      aria-modal="true"
      aria-label={t("imageViewer.dialog")}
      onClick={handleOverlayClick}
      onPointerDownCapture={(event) => {
        lastPointerTypeRef.current = event.pointerType ?? "";
      }}
      onPointerMove={handleOverlayPointerMove}
      onPointerLeave={handleOverlayPointerLeave}
      onFocus={() => revealChrome()}
    >
      <div
        ref={stageRef}
        className="image-viewer-stage"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
        onDoubleClick={handleDoubleClick}
      >
        <div ref={paintSurfaceRef} className="image-viewer-paint-surface">
          <img
            className="image-viewer-image"
            src={current.src}
            alt={current.alt}
            draggable={false}
            style={{
              width: baseWidth,
              height: baseHeight,
              transform: `translate(${transform.x + swipeOffset}px, ${transform.y}px) rotate(${quarterTurns * 90}deg) scale(${transform.scale})`,
            }}
          />
        </div>
        <div
          ref={visualOverlayRef}
          className="image-viewer-visual-overlay"
          aria-hidden="true"
        />
      </div>
      <div className="image-viewer-chrome" role="group" aria-label={t("imageViewer.controls")}>
        <div className="image-viewer-topbar">
          <div className="image-viewer-topbar-start">
            {showLink ? (
              <button
                type="button"
                className="image-viewer-btn is-text image-viewer-link"
                onClick={() => onFollowLinkRef.current?.(current)}
                title={t("imageViewer.openLink")}
              >
                {t("imageViewer.openLink")}
              </button>
            ) : null}
            {onCompareOriginalChange ? (
              <button
                type="button"
                className={`image-viewer-btn is-text image-viewer-compare${compareOriginal ? " is-active" : ""}`}
                aria-pressed={compareOriginal}
                title={t("imageViewer.compare.tip")}
                onPointerDown={(event) => {
                  event.preventDefault();
                  onCompareOriginalChange(true);
                }}
                onPointerUp={() => onCompareOriginalChange(false)}
                onPointerCancel={() => onCompareOriginalChange(false)}
                onPointerLeave={() => onCompareOriginalChange(false)}
                onBlur={() => onCompareOriginalChange(false)}
                onContextMenu={(event) => event.preventDefault()}
              >
                {t("imageViewer.compare")}
              </button>
            ) : null}
          </div>
          {total > 1 ? (
            <span
              className="image-viewer-counter"
              role="status"
              aria-label={t("imageViewer.counter", { current: index + 1, total })}
            >
              {index + 1} / {total}
            </span>
          ) : (
            <span />
          )}
          <div className="image-viewer-topbar-end">
            <button
              type="button"
              className="image-viewer-btn image-viewer-rotate-left"
              onClick={() => rotate(-1)}
              title={`${t("imageViewer.rotateLeft")} (Shift+R)`}
              aria-label={t("imageViewer.rotateLeft")}
            >
              <RotateLeftIcon size={18} />
            </button>
            <button
              type="button"
              className="image-viewer-btn image-viewer-rotate-right"
              onClick={() => rotate(1)}
              title={`${t("imageViewer.rotateRight")} (R)`}
              aria-label={t("imageViewer.rotateRight")}
            >
              <RotateRightIcon size={18} />
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className="image-viewer-btn image-viewer-close"
              onClick={() => onCloseRef.current()}
              title={`${t("imageViewer.close")} (Esc)`}
              aria-label={t("imageViewer.close")}
            >
              <CloseIcon size={18} />
            </button>
          </div>
        </div>
        {total > 1 && hasPrev ? (
          <button
            type="button"
            className={`image-viewer-edge is-prev${nearEdge === "prev" ? " is-near" : ""}`}
            onClick={() => goTo(index - 1)}
            title={`${t("imageViewer.previous")} (←)`}
            aria-label={t("imageViewer.previous")}
          >
            <ArrowLeftIcon size={20} />
          </button>
        ) : null}
        {total > 1 && hasNext ? (
          <button
            type="button"
            className={`image-viewer-edge is-next${nearEdge === "next" ? " is-near" : ""}`}
            onClick={() => goTo(index + 1)}
            title={`${t("imageViewer.next")} (→)`}
            aria-label={t("imageViewer.next")}
          >
            <ChevronRightIcon size={20} />
          </button>
        ) : null}
        <div className="image-viewer-zoom">
          <button
            type="button"
            className="image-viewer-btn image-viewer-zoom-step"
            onClick={() => zoomAroundCenter(1 / BUTTON_ZOOM_STEP)}
            disabled={atFit}
            title={t("imageViewer.zoomOut")}
            aria-label={t("imageViewer.zoomOut")}
          >
            <MinusIcon size={16} />
          </button>
          <button
            type="button"
            className="image-viewer-percent"
            onClick={toggleFitOrActual}
            title={t("imageViewer.zoomToggle", { percent })}
            aria-label={t("imageViewer.zoomToggle", { percent })}
          >
            {percent}%
          </button>
          <button
            type="button"
            className="image-viewer-btn image-viewer-zoom-step"
            onClick={() => zoomAroundCenter(BUTTON_ZOOM_STEP)}
            disabled={atMax}
            title={t("imageViewer.zoomIn")}
            aria-label={t("imageViewer.zoomIn")}
          >
            <PlusIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
