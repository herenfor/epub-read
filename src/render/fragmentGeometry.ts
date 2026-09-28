/**
 * 横向 LTR 普通流的片段几何。
 *
 * 输入都来自同一个 iframe 的 client 坐标系。双栏正文中，父元素的
 * `getClientRects()` 会按物理栏返回多个片段；只用 Y 重叠会在左右栏同高时
 * 选错栏。这里同时用点所在物理栏和矩形二维包含关系选中唯一片段。
 *
 * 仅用于 horizontal-tb / LTR / 无 transform / 非跨栏 union 的普通流。
 * 绝对定位、float、Writing Mode 或 transform 的坐标空间由调用方保留原路径，
 * 不套用本模块。
 */

import type { SpreadGeometry } from "./pagedSpread";

export interface FragmentRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface FragmentSpace {
  readonly geometry: Pick<SpreadGeometry, "columnWidth" | "columnStep">;
  readonly originClientX: number;
  readonly scrollLeft: number;
}

function isValidSpace(space: FragmentSpace): boolean {
  return (
    Number.isFinite(space.originClientX) &&
    Number.isFinite(space.scrollLeft) &&
    Number.isFinite(space.geometry.columnWidth) &&
    Number.isFinite(space.geometry.columnStep) &&
    space.geometry.columnWidth > 0 &&
    space.geometry.columnStep > 0
  );
}

/** point 必须来自目标可见文字/媒体的实际片段，不能取父盒 union 中心。 */
export function columnAtPoint(
  point: Readonly<{ x: number; y: number }>,
  space: FragmentSpace,
): number | null {
  if (!isValidSpace(space) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const x = point.x - space.originClientX + space.scrollLeft;
  if (x < 0) return null;
  const column = Math.floor(x / space.geometry.columnStep);
  const within = x - column * space.geometry.columnStep;
  // 栏间隙不属于正文，不吸附到相邻栏。
  return within < space.geometry.columnWidth ? column : null;
}

/**
 * 从同一个父元素的 `getClientRects()` 中选目标所在的真实片段。
 *
 * 旧的“只看 y 重叠”会命中同高度左栏，再把右栏正常装饰当溢出。无唯一命中
 * 返回 null，由调用方保持作者排版，不回退到 `getBoundingClientRect()` union。
 * epsilon 只容纳布局小数误差，不用于移动或裁掉正文。
 */
export function containingFragmentAtPoint(
  fragments: readonly FragmentRect[],
  point: Readonly<{ x: number; y: number }>,
  space: FragmentSpace,
  epsilon = 0.5,
): number | null {
  if (!isValidSpace(space) || !Number.isFinite(epsilon) || epsilon < 0) return null;
  const column = columnAtPoint(point, space);
  if (column === null) return null;
  const columnLeft = space.originClientX - space.scrollLeft + column * space.geometry.columnStep;
  const columnRight = columnLeft + space.geometry.columnWidth;
  let match: number | null = null;
  for (let i = 0; i < fragments.length; i++) {
    const rect = fragments[i];
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.right) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.bottom) ||
      rect.right <= rect.left ||
      rect.bottom <= rect.top
    ) {
      continue;
    }
    // 此门只面向正常栏内父片段；绝对定位/跨栏元素另走明确语义，不能猜。
    if (rect.left < columnLeft - epsilon || rect.right > columnRight + epsilon) continue;
    if (
      point.x < rect.left - epsilon ||
      point.x > rect.right + epsilon ||
      point.y < rect.top - epsilon ||
      point.y > rect.bottom + epsilon
    ) {
      continue;
    }
    if (match !== null) return null;
    match = i;
  }
  return match;
}
