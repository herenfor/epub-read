/**
 * 统一连续阅读位置与书签阅读线对齐（Zen UI）
 *
 * 规范与拓扑参见 docs/tasks/active/bookmark-scroll-position-handoff.md
 */

export const CONTINUOUS_READING_LINE_RATIO = 0.2;

export function continuousReadingLine(viewportHeight: number): number {
  return viewportHeight * CONTINUOUS_READING_LINE_RATIO;
}

/**
 * 计算书签在连续滚动视图中的落点几何（以阅读线对齐）。
 * 输入均来自已提交 layout 与目标章只读解析；不接受未测量的伪成功。
 */
export function bookmarkLanding(input: {
  chapterTop: number;
  contentY: number;
  viewportHeight: number;
  maxScrollTop: number;
}): { scrollTop: number; screenY: number } {
  const documentY = input.chapterTop + input.contentY;
  const scrollTop = Math.max(
    0,
    Math.min(input.maxScrollTop, documentY - continuousReadingLine(input.viewportHeight)),
  );
  // 书首/书尾夹紧后必须保留实际 screenY，不能假设仍在 20% 处。
  return { scrollTop, screenY: documentY - scrollTop };
}

/** T 在产品中使用完整 ReadingSpot，含解析后的文本/媒体身份与真实几何。 */
export type ReadingPositionSnapshot<T> = Readonly<{
  session: number;
  chapterKey: string;
  source: "sampled" | "explicit";
  value: T;
}>;

/** 仅在现有 ticket 校验及宿主几何提交成功以后调用。 */
export function commitExplicitPosition<T>(
  session: number,
  chapterKey: string,
  value: T,
): ReadingPositionSnapshot<T> {
  return { session, chapterKey, source: "explicit", value };
}

/**
 * 同会话显式目标不能被 RAF、菜单展开、React 重渲染触发的重新命中覆盖。
 * 真正用户位移必须先 releaseExplicitPosition，再接受采样。
 */
export function acceptPositionSample<T>(
  previous: ReadingPositionSnapshot<T> | null,
  sample: ReadingPositionSnapshot<T>,
): ReadingPositionSnapshot<T> {
  return previous?.session === sample.session && previous.source === "explicit"
    ? previous
    : { ...sample, source: "sampled" };
}

/**
 * 仅解除权属，保留旧 spot 供既有重排/失败保护使用。
 * 调用点：真实用户位移、新显式导航开始；切书/卸载直接清整个 ref。
 */
export function releaseExplicitPosition<T>(
  previous: ReadingPositionSnapshot<T> | null,
): ReadingPositionSnapshot<T> | null {
  return previous ? { ...previous, source: "sampled" } : null;
}

/**
 * 字号/窗口/图片迟加载重排成功后，使用同一内容身份更新几何，保留权属。
 * 无法解析原内容时不调用：按宿主既有 unresolved 路径处理，不能锁住旧红色。
 */
export function rebasePosition<T>(
  previous: ReadingPositionSnapshot<T>,
  rebasedValue: T,
): ReadingPositionSnapshot<T> {
  return { ...previous, value: rebasedValue };
}
