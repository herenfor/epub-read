/**
 * 连续阅读的几何提交顺序（R1）。
 *
 * 布局表算出新的占位高度后，React 的 `setLayout` 只是排队渲染：若在 React
 * 真正写进 DOM 之前就写宿主 `scrollTop`，浏览器仍按**旧**的 canvas 高度钳制，
 * 合法的新位置会被截断，而稍后 canvas 变高也不会补回丢失的位移（典型场景：
 * 当前位置靠近书尾、所读文字上方又有内容增高）。
 *
 * 因此这里把“新几何 → 宿主滚动位置”做成一个显式顺序的同步事务：先写 canvas
 * 总高与每个存活 wrapper 的 top/height，再写 scrollTop。React 随后的渲染会用
 * 同一份布局值覆盖，写的是相同结果，不会回退。
 */

/** 章节 wrapper 上标记布局 key 的属性；DOM 与布局表的唯一映射依据。 */
export const CHAPTER_KEY_ATTRIBUTE = "data-chapter-key";

export interface ContinuousGeometryCanvas {
  style: { height: string };
  children: ArrayLike<unknown>;
}

interface GeometryChild {
  getAttribute(name: string): string | null;
  style: { top: string; height: string } | null;
}

export interface ContinuousGeometryHost {
  scrollTop: number;
}

export interface ContinuousLayoutLike {
  readonly totalHeight: number;
  boxFor(key: string): { top: number; height: number } | null;
}

/**
 * 只写几何，不碰滚动位置。canvas 显式高度是整本书的可滚动范围，
 * wrapper 是绝对定位的章节占位；两者都必须在改 scrollTop 之前落盘。
 */
export function applyContinuousGeometry(
  canvas: ContinuousGeometryCanvas | null,
  layout: ContinuousLayoutLike
): void {
  if (!canvas) return;
  const height = `${layout.totalHeight}px`;
  if (canvas.style.height !== height) canvas.style.height = height;
  const children = canvas.children;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i] as GeometryChild | null;
    if (!child || typeof child.getAttribute !== "function") continue;
    const style = child.style;
    if (!style) continue;
    const key = child.getAttribute(CHAPTER_KEY_ATTRIBUTE);
    if (!key) continue;
    const box = layout.boxFor(key);
    if (!box) continue;
    const top = `${box.top}px`;
    const boxHeight = `${box.height}px`;
    if (style.top !== top) style.top = top;
    if (style.height !== boxHeight) style.height = boxHeight;
  }
}

/**
 * 一个同步提交事务：先几何、后滚动位置，返回浏览器实际接受的位置。
 * 返回值必须是读回来的值：书顶/书尾的合法钳制只能由新范围决定。
 */
export function commitContinuousGeometry(options: {
  canvas: ContinuousGeometryCanvas | null;
  host: ContinuousGeometryHost | null;
  layout: ContinuousLayoutLike;
  scrollTop: number;
}): number {
  applyContinuousGeometry(options.canvas, options.layout);
  const host = options.host;
  if (!host) return options.scrollTop;
  if (Math.abs(host.scrollTop - options.scrollTop) > 0.5) host.scrollTop = options.scrollTop;
  return host.scrollTop;
}
