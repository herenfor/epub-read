import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { ImageViewRequest } from "../render/imageActivation";
import { CloseIcon, MinusIcon, PlusIcon, RotateCcwIcon } from "./readerIcons";
import {
  MIN_IMAGE_SCALE,
  clampImagePan,
  clampScale,
  computeFitScale,
  isAtFit,
  maxScaleForFit,
  nextDoubleTapScale,
  originalSizeScale,
  pointerDistance,
  pointerMidpoint,
  toViewerPoint,
  wheelZoomFactor,
  zoomAt,
  type ImageTransform,
  type Point,
} from "./imageViewerGeometry";
import "./imageViewer.css";

export interface ImageViewerProps {
  image: ImageViewRequest | null;
  onClose(): void;
  onFollowLink?(image: ImageViewRequest): void;
}

interface ViewportSize {
  width: number;
  height: number;
}

type Gesture =
  | { kind: "pan"; pointerId: number; start: ImageTransform; startPoint: Point }
  | { kind: "pinch"; start: ImageTransform; startDistance: number; startMidpoint: Point };

/** 小于该位移的按压算点击，避免把点按误判成拖动。 */
const CLICK_DRAG_TOLERANCE = 4;
const BUTTON_ZOOM_STEP = 1.25;
const FIT_STATE_EPSILON = 0.01;

/**
 * 正文图片浮层：全屏遮罩 + 单张图片的缩放/拖动查看。
 *
 * 只消费已由 `imageRequestFromTarget` 识别好的请求，不解析资源、不持有 Book/ResourceServer，
 * 也不自行打开链接：有 linkHref 且父级提供 onFollowLink 时显示“打开链接”，交回原链接路由。
 * 打开/关闭只影响本浮层，不触碰书页图片尺寸与阅读位置。
 */
export function ImageViewer({ image, onClose, onFollowLink }: ImageViewerProps) {
  const open = image !== null;
  const overlayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const gestureRef = useRef<Gesture | null>(null);
  const draggedRef = useRef(false);
  const transformRef = useRef<ImageTransform>({ scale: MIN_IMAGE_SCALE, x: 0, y: 0 });

  const [size, setSize] = useState<ViewportSize>({ width: 0, height: 0 });
  const [transform, setTransform] = useState<ImageTransform>(transformRef.current);

  // 回调放 ref，避免父级内联函数让焦点/键盘 effect 每次渲染重跑。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onFollowLinkRef = useRef(onFollowLink);
  onFollowLinkRef.current = onFollowLink;

  const naturalWidth = image?.naturalWidth ?? 0;
  const naturalHeight = image?.naturalHeight ?? 0;
  const fitScale = computeFitScale(naturalWidth, naturalHeight, size.width, size.height);
  const maxScale = maxScaleForFit(fitScale);
  const baseWidth = Math.max(1, naturalWidth * fitScale);
  const baseHeight = Math.max(1, naturalHeight * fitScale);
  const atFit = isAtFit(transform.scale);
  const atMax = transform.scale >= maxScale - FIT_STATE_EPSILON;

  const commitTransform = useCallback(
    (next: ImageTransform) => {
      const settled = clampImagePan(next, baseWidth, baseHeight, size.width, size.height);
      transformRef.current = settled;
      setTransform(settled);
    },
    [baseWidth, baseHeight, size.width, size.height],
  );

  const readViewportRect = useCallback(() => {
    const stage = stageRef.current;
    const rect = stage && typeof stage.getBoundingClientRect === "function" ? stage.getBoundingClientRect() : null;
    if (rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)) {
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
    return { left: 0, top: 0, width: size.width, height: size.height };
  }, [size.width, size.height]);

  // 每次打开/换图都回到适配居中，并清空未完成的手势。
  useEffect(() => {
    pointersRef.current.clear();
    gestureRef.current = null;
    draggedRef.current = false;
    transformRef.current = { scale: MIN_IMAGE_SCALE, x: 0, y: 0 };
    setTransform(transformRef.current);
  }, [open, image?.src, image?.chapterPath]);

  // 尺寸/横竖屏变化：保留有效缩放比例，重新约束平移。
  useEffect(() => {
    const current = transformRef.current;
    const scale = clampScale(current.scale, MIN_IMAGE_SCALE, maxScale);
    const settled = clampImagePan({ ...current, scale }, baseWidth, baseHeight, size.width, size.height);
    transformRef.current = settled;
    setTransform(settled);
  }, [baseWidth, baseHeight, maxScale, size.width, size.height]);

  // 打开时焦点进入弹层，关闭时回到原焦点；Esc 关闭，Tab 不跑到背景。
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
      if (event.key !== "Tab") return;
      const root = overlayRef.current;
      if (!root || typeof root.querySelectorAll !== "function") return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"),
      );
      if (focusables.length === 0) return;
      event.preventDefault();
      const active = doc.activeElement as HTMLElement | null;
      const index = active ? focusables.indexOf(active) : -1;
      const next = event.shiftKey
        ? index <= 0
          ? focusables.length - 1
          : index - 1
        : index === -1 || index >= focusables.length - 1
          ? 0
          : index + 1;
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

  // 测量浮层可用区（已扣控制条与 safe-area 的 stage 自身尺寸）。
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = typeof stage.getBoundingClientRect === "function" ? stage.getBoundingClientRect() : null;
      const width = rect && Number.isFinite(rect.width) && rect.width > 0 ? rect.width : 0;
      const height = rect && Number.isFinite(rect.height) && rect.height > 0 ? rect.height : 0;
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
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
      const current = transformRef.current;
      const nextScale = clampScale(current.scale * factor, MIN_IMAGE_SCALE, maxScale);
      commitTransform(zoomAt(current, focus, focus, nextScale));
    };
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => overlay.removeEventListener("wheel", onWheel);
  }, [open, readViewportRect, commitTransform, maxScale]);

  const beginGesture = useCallback(() => {
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
      return;
    }
    if (points.length === 1) {
      const [pointerId, startPoint] = points[0];
      gestureRef.current = { kind: "pan", pointerId, start: transformRef.current, startPoint };
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
    beginGesture();
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
    pointersRef.current.delete(event.pointerId);
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

  /** 背景关闭；拖动结束的 click 被抑制，点击图片/控件不关闭。 */
  const handleOverlayClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    const target = event.target as Element | null;
    if (
      target &&
      typeof target.closest === "function" &&
      target.closest("img, button, a, .image-viewer-controls")
    ) {
      return;
    }
    onCloseRef.current();
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const focus = toViewerPoint(event.clientX, event.clientY, readViewportRect());
    const current = transformRef.current;
    const nextScale = nextDoubleTapScale(current.scale, maxScale);
    commitTransform(zoomAt(current, focus, focus, nextScale));
  };

  const zoomAroundCenter = (factor: number) => {
    const current = transformRef.current;
    const nextScale = clampScale(current.scale * factor, MIN_IMAGE_SCALE, maxScale);
    commitTransform(zoomAt(current, { x: 0, y: 0 }, { x: 0, y: 0 }, nextScale));
  };

  const resetToFit = () => {
    commitTransform({ scale: MIN_IMAGE_SCALE, x: 0, y: 0 });
  };

  const useOriginalSize = () => {
    const current = transformRef.current;
    const nextScale = originalSizeScale(fitScale, maxScale);
    commitTransform(zoomAt(current, { x: 0, y: 0 }, { x: 0, y: 0 }, nextScale));
  };

  if (!image) return null;

  return (
    <div
      ref={overlayRef}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="图片查看"
      onClick={handleOverlayClick}
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
        <img
          className="image-viewer-image"
          src={image.src}
          alt={image.alt}
          draggable={false}
          style={{
            width: baseWidth,
            height: baseHeight,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        />
      </div>
      <div className="image-viewer-controls" role="group" aria-label="图片查看控件">
        {image.linkHref && onFollowLinkRef.current ? (
          <button
            type="button"
            className="image-viewer-btn image-viewer-link"
            onClick={() => onFollowLinkRef.current?.(image)}
            title="打开链接"
          >
            打开链接
          </button>
        ) : null}
        <button
          type="button"
          className="image-viewer-btn"
          onClick={() => zoomAroundCenter(1 / BUTTON_ZOOM_STEP)}
          disabled={atFit}
          title="缩小"
          aria-label="缩小"
        >
          <MinusIcon size={16} />
        </button>
        <span className="image-viewer-scale">{Math.round(transform.scale * 100)}%</span>
        <button
          type="button"
          className="image-viewer-btn"
          onClick={() => zoomAroundCenter(BUTTON_ZOOM_STEP)}
          disabled={atMax}
          title="放大"
          aria-label="放大"
        >
          <PlusIcon size={16} />
        </button>
        <button
          type="button"
          className="image-viewer-btn"
          onClick={resetToFit}
          disabled={atFit}
          title="适配窗口"
          aria-label="适配窗口"
        >
          <RotateCcwIcon size={16} />
        </button>
        <button
          type="button"
          className="image-viewer-btn image-viewer-original"
          onClick={useOriginalSize}
          title="原始大小"
          aria-label="原始大小"
        >
          1:1
        </button>
        <button
          ref={closeButtonRef}
          type="button"
          className="image-viewer-btn image-viewer-close"
          onClick={() => onCloseRef.current()}
          title="关闭"
          aria-label="关闭"
        >
          <CloseIcon size={16} />
        </button>
      </div>
    </div>
  );
}
