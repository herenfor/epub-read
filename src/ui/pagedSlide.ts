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

/** 松手续接时初速度的上限（归一化斜率）；三次 Hermite 在斜率 ≤3 时单调不过冲。 */
const RELEASE_MAX_SLOPE = 2.5;
/** 手指几乎停住时仍以平均速度的一半起步，避免松手后先“停一下”。 */
const RELEASE_MIN_SLOPE = 0.5;

/**
 * 松手后的续接动画：以手指离手速度为起始速度、到达终点速度为 0 的三次 Hermite
 * 曲线。easeOutCubic 的起始速度是平均速度的 3 倍，慢拖松手时第一帧会跳出几十
 * 像素，看上去像掉帧；这里让速度从手指处连续衔接。
 *
 * velocityPxPerMs 为 scrollLeft 方向的离手速度（与 remainingPx 同号才算顺向）。
 */
export function releaseSlidePlan(
  remainingPx: number,
  spanPx: number,
  velocityPxPerMs: number,
): { durationMs: number; ease: (t: number) => number } {
  const durationMs = slideDurationMs(remainingPx, spanPx);
  const distance = Math.abs(remainingPx);
  const along = Math.sign(remainingPx) * velocityPxPerMs;
  if (!(durationMs > 0) || !(distance > 0) || !(along > 0)) {
    return { durationMs, ease: hermiteEase(RELEASE_MIN_SLOPE) };
  }
  // 快速一划：缩短时长使起始斜率不超过上限，速度仍与手指一致。
  let duration = durationMs;
  if ((along * duration) / distance > RELEASE_MAX_SLOPE) {
    duration = Math.max(SLIDE_MIN_MS, (RELEASE_MAX_SLOPE * distance) / along);
  }
  const slope = Math.max(RELEASE_MIN_SLOPE, Math.min(RELEASE_MAX_SLOPE, (along * duration) / distance));
  return { durationMs: Math.round(duration), ease: hermiteEase(slope) };
}

/** 起点斜率 m、终点斜率 0 的归一化三次 Hermite：p(0)=0, p(1)=1。 */
export function hermiteEase(m: number): (t: number) => number {
  return (t: number): number => {
    const s = Math.max(0, Math.min(1, t));
    const s2 = s * s;
    const s3 = s2 * s;
    return m * (s3 - 2 * s2 + s) + (3 * s2 - 2 * s3);
  };
}

/** 由最近的拖动采样估计离手速度（px/ms）；手指停住超过 idleMs 视为 0。 */
export function releaseVelocity(
  samples: ReadonlyArray<{ t: number; x: number }>,
  now: number,
  windowMs = 80,
  idleMs = 60,
): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (now - last.t > idleMs) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
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
  ease: (t: number) => number = easeOutCubic,
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
    apply(from + (to - from) * ease(t));
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
