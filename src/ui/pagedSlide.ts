/**
 * 分页“滑动”翻页：拖动映射、时长与一个可中断的 rAF 数值动画。
 *
 * 几何端点来自 ChapterPaginator.pagedSlideFrame()；本模块只做纯计算与
 * 帧调度，不读写分页状态。页码提交仍由调用方在结束时 setPage() 完成。
 */
export interface SlideFrame {
  /** 当前页 scrollLeft */
  from: number;
  /** 同章相邻页 scrollLeft（下一页大于 from，上一页小于 from） */
  to: number;
}

/** 完整翻过一页的时长；剩余距离越短越快，下限保证仍可见。 */
export const SLIDE_FULL_MS = 280;
const SLIDE_MIN_MS = 90;

/**
 * 手指位移 dx（向左为负 = 下一页）映射为视觉 scrollLeft，1:1 跟手并限制在
 * 当前页与相邻页之间；反方向拖动停在当前页，不越界露出其他页。
 */
export function dragScrollLeft(frame: SlideFrame, dx: number): number {
  const low = Math.min(frame.from, frame.to);
  const high = Math.max(frame.from, frame.to);
  return Math.max(low, Math.min(high, frame.from - dx));
}

export function slideDurationMs(remainingPx: number, spanPx: number): number {
  if (!(spanPx > 0)) return 0;
  const ratio = Math.max(0, Math.min(1, Math.abs(remainingPx) / spanPx));
  if (ratio === 0) return 0;
  return Math.round(Math.max(SLIDE_MIN_MS, SLIDE_FULL_MS * Math.sqrt(ratio)));
}

/** 减速收尾，与 --ease-emphasized 同一手感。 */
export function easeOutCubic(t: number): number {
  const x = 1 - Math.max(0, Math.min(1, t));
  return 1 - x * x * x;
}

export interface ValueAnimation {
  /** 立即跳到终点并执行完成回调（连续翻页/外部跳转前落位）。 */
  finish(): void;
  /** 停止且不执行完成回调。 */
  cancel(): void;
  readonly active: boolean;
}

export interface AnimationClock {
  now(): number;
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const hasAnimationFrame = (): boolean =>
  typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";

const defaultClock: AnimationClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  request: (callback) => hasAnimationFrame()
    ? window.requestAnimationFrame(() => callback())
    : (setTimeout(callback, 16) as unknown as number),
  cancel: (handle) => {
    if (hasAnimationFrame()) window.cancelAnimationFrame(handle);
    else clearTimeout(handle);
  },
};

export function animateValue(
  from: number,
  to: number,
  durationMs: number,
  apply: (value: number) => void,
  done: () => void,
  clock: AnimationClock = defaultClock,
): ValueAnimation {
  let active = true;
  let handle: number | null = null;
  const complete = (): void => {
    if (!active) return;
    active = false;
    if (handle !== null) clock.cancel(handle);
    handle = null;
    apply(to);
    done();
  };
  const animation: ValueAnimation = {
    finish: complete,
    cancel: () => {
      if (!active) return;
      active = false;
      if (handle !== null) clock.cancel(handle);
      handle = null;
    },
    get active() {
      return active;
    },
  };
  if (!(durationMs > 0) || from === to) {
    complete();
    return animation;
  }
  const start = clock.now();
  const step = (): void => {
    handle = null;
    if (!active) return;
    const t = (clock.now() - start) / durationMs;
    if (t >= 1) {
      complete();
      return;
    }
    apply(from + (to - from) * easeOutCubic(t));
    handle = clock.request(step);
  };
  handle = clock.request(step);
  return animation;
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
