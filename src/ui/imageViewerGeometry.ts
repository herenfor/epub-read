/**
 * 图片浮层缩放/平移的纯几何核心（由 docs 草稿的 zoomAt/clampImagePan 迁入）。
 *
 * 坐标约定：所有 Point 都是相对浮层可用视口中心的偏移；基准图像尺寸是自然尺寸乘
 * fitScale 后的适配尺寸。屏幕位置 screen = translation + scale * imagePoint，
 * transform-origin 为图像中心。这里只做数学，不读 DOM、不写样式。
 */

export interface Point {
  x: number;
  y: number;
}

export interface ImageTransform {
  scale: number;
  x: number;
  y: number;
}

export const MIN_IMAGE_SCALE = 1;
/** 相对缩放下限为适配（1），上限至少 4 倍，并保证 1/fitScale 的“原始大小”可达。 */
export const MAX_IMAGE_SCALE_FLOOR = 4;
/** 双击在适配与 2 倍之间切换，2 倍超过上限时取上限。 */
export const DOUBLE_TAP_SCALE = 2;

const FIT_EPSILON = 0.01;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** 适配比例 = min(viewW/naturalW, viewH/naturalH, 1)；测量无效时退回 1（不放大）。 */
export function computeFitScale(
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (!isPositiveFinite(naturalWidth) || !isPositiveFinite(naturalHeight)) return MIN_IMAGE_SCALE;
  if (!isPositiveFinite(viewportWidth) || !isPositiveFinite(viewportHeight)) return MIN_IMAGE_SCALE;
  const fit = Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight, MIN_IMAGE_SCALE);
  return isPositiveFinite(fit) ? fit : MIN_IMAGE_SCALE;
}

export function maxScaleForFit(fitScale: number): number {
  const original = isPositiveFinite(fitScale) ? 1 / fitScale : MAX_IMAGE_SCALE_FLOOR;
  return Math.max(MAX_IMAGE_SCALE_FLOOR, original);
}

/** “原始大小”对应的相对缩放。 */
export function originalSizeScale(fitScale: number, maxScale: number): number {
  return clampScale(1 / (isPositiveFinite(fitScale) ? fitScale : MIN_IMAGE_SCALE), MIN_IMAGE_SCALE, maxScale);
}

export function clampScale(scale: number, minScale: number, maxScale: number): number {
  const lo = isPositiveFinite(minScale) ? minScale : MIN_IMAGE_SCALE;
  const hi = isPositiveFinite(maxScale) && maxScale >= lo ? maxScale : lo;
  if (!Number.isFinite(scale)) return lo;
  return Math.min(hi, Math.max(lo, scale));
}

export function isAtFit(scale: number): boolean {
  return !Number.isFinite(scale) || scale <= MIN_IMAGE_SCALE + FIT_EPSILON;
}

/** 客户区坐标 → 以浮层可用区中心为原点的坐标。 */
export function toViewerPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): Point {
  return {
    x: clientX - (rect.left + rect.width / 2),
    y: clientY - (rect.top + rect.height / 2),
  };
}

/**
 * 保持 previousFocus 下的图像点落在 nextFocus：先求出手指/鼠标下的 imagePoint，
 * 再按新比例算 translation。双指中点移动因此会同时平移图片，而不是只缩放。
 */
export function zoomAt(
  previous: ImageTransform,
  previousFocus: Point,
  nextFocus: Point,
  nextScale: number,
): ImageTransform {
  const scale = isPositiveFinite(previous.scale) ? previous.scale : MIN_IMAGE_SCALE;
  const imageX = (previousFocus.x - previous.x) / scale;
  const imageY = (previousFocus.y - previous.y) / scale;
  return {
    scale: nextScale,
    x: nextFocus.x - imageX * nextScale,
    y: nextFocus.y - imageY * nextScale,
  };
}

/**
 * 限制平移：放大后最多把图像边缘拖到视口边缘，不能完全拖出窗口；
 * 缩回适配（baseWidth*scale <= viewportWidth）时该轴居中为 0。
 */
export function clampImagePan(
  t: ImageTransform,
  baseWidth: number,
  baseHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): ImageTransform {
  const scale = isPositiveFinite(t.scale) ? t.scale : MIN_IMAGE_SCALE;
  const width = isPositiveFinite(baseWidth) ? baseWidth : 0;
  const height = isPositiveFinite(baseHeight) ? baseHeight : 0;
  const viewWidth = isPositiveFinite(viewportWidth) ? viewportWidth : 0;
  const viewHeight = isPositiveFinite(viewportHeight) ? viewportHeight : 0;
  const maxX = Math.max(0, (width * scale - viewWidth) / 2);
  const maxY = Math.max(0, (height * scale - viewHeight) / 2);
  const x = Number.isFinite(t.x) ? Math.min(maxX, Math.max(-maxX, t.x)) : 0;
  const y = Number.isFinite(t.y) ? Math.min(maxY, Math.max(-maxY, t.y)) : 0;
  // 归一化 -0，避免等价居中值在比较/序列化时出现两种表示。
  return { scale, x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

/** 双击目标比例：适配时到 2 倍，否则回到适配。 */
export function nextDoubleTapScale(currentScale: number, maxScale: number): number {
  const target = isAtFit(currentScale) ? DOUBLE_TAP_SCALE : MIN_IMAGE_SCALE;
  return clampScale(target, MIN_IMAGE_SCALE, maxScale);
}

/** 滚轮增量 → 缩放因子（向上滚放大）；限制单次步进，避免触控板跳变。 */
export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const factor = Math.exp(-deltaY * 0.0015);
  return Math.min(2, Math.max(0.5, factor));
}

export function pointerDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pointerMidpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
