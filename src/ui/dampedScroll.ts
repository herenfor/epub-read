/**
 * 宿主滚动阻尼动画（B-134 手感）算法层：纯函数 + 一个只做时序编排的调度器。
 *
 * 连续滚动模式下，`iframe` 内的滚轮/按键由 `ExternalScrollAdapter` 转交给宿主，
 * 旧分页器里的 `scrollByDelta` 阻尼因此完全不可达。这里把同一套手感提到宿主上：
 * 快速衰减常数（约 25ms）让每一格滚轮都在 4~6 帧内到位，零启动迟滞、无慢速拖尾，
 * 连续拨轮只累加目标而不叠加动画。
 *
 * 算法与 DOM 分离，便于单测锁定曲线；调度器只负责 rAF 编排与目标钳制。
 */

/** 衰减时间常数：60Hz 下单帧完成约 48.7% 步长，4~6 帧覆盖超过 96% 位移。 */
const DECAY_TIME_CONSTANT_MS = 25;
/** 首帧无历史时间戳时的假定帧长。 */
const FIRST_FRAME_DELTA_MS = 16.7;
/** 单帧最大可信帧长，避免后台标签页恢复时一次跳跃过大。 */
const MAX_FRAME_DELTA_MS = 32;
/** 残余位移小于该值时直接吸附停定，避免亚像素漂移。 */
const SETTLE_EPSILON_PX = 1;
/** 最小推进步长：保证极慢输入也能收敛而不是无限等待。 */
const MIN_STEP_PX = 1.2;

export interface DampedScrollInput {
  /** 当前滚动位置。 */
  readonly current: number;
  /** 阻尼目标位置。 */
  readonly target: number;
  /** 上一帧到本帧的毫秒数；首帧传 null 使用假定帧长。 */
  readonly deltaMs: number | null;
}

export interface DampedScrollResult {
  /** 本帧应写入的滚动位置。 */
  readonly position: number;
  /** 是否已收敛到位（到位后应停止动画）。 */
  readonly settled: boolean;
}

function clampFrameDelta(deltaMs: number | null): number {
  if (deltaMs === null || !Number.isFinite(deltaMs)) return FIRST_FRAME_DELTA_MS;
  return Math.min(MAX_FRAME_DELTA_MS, Math.max(1, deltaMs));
}

/** 本帧的指数衰减步长；不越过目标，也不会反向。 */
export function dampedScrollStep(input: DampedScrollInput): DampedScrollResult {
  const { current, target } = input;
  if (!Number.isFinite(current) || !Number.isFinite(target)) {
    return { position: current, settled: true };
  }
  const distance = target - current;
  if (Math.abs(distance) < SETTLE_EPSILON_PX) {
    return { position: target, settled: true };
  }

  const decay = 1 - Math.exp(-clampFrameDelta(input.deltaMs) / DECAY_TIME_CONSTANT_MS);
  const raw = distance * decay;
  const step = Math.abs(raw) < MIN_STEP_PX ? Math.sign(distance) * MIN_STEP_PX : raw;
  if (Math.abs(step) >= Math.abs(distance)) {
    return { position: target, settled: true };
  }
  return { position: current + step, settled: false };
}

/** 滚轮目标累加：同向从尚未到达的目标续加，反向从当前画面立即回转，并钳制在有效范围内。 */
export function accumulateWheelTarget(
  current: number,
  pending: number | null,
  delta: number,
  maxScrollTop: number
): number {
  const max = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : 0;
  const hasPending = pending !== null && Number.isFinite(pending);
  const remaining = hasPending ? (pending as number) - current : 0;
  const reversing = remaining * delta < 0;
  const base = !hasPending || reversing ? current : (pending as number);
  return Math.max(0, Math.min(max, base + delta));
}

/** requestAnimationFrame/取消的最小接口，便于在无 DOM 环境下替换。 */
export interface FrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

/**
 * 阻尼滚动调度器：只做目标累加、rAF 编排与最大滚动位置钳制。
 * 收敛后立即停止，不保留任何常驻帧循环。
 */
export class DampedScrollAnimator {
  private frame: number | null = null;
  private target: number | null = null;
  private lastTime: number | null = null;

  constructor(private readonly scheduler: FrameScheduler) {}

  /** 追加一格滚轮位移；目标按像素累加，正在动画时只更新目标。 */
  addDelta(
    delta: number,
    read: () => { current: number; maxScrollTop: number },
    apply: (position: number) => void
  ): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    const { current, maxScrollTop } = read();
    const next = accumulateWheelTarget(current, this.target, delta, maxScrollTop);
    if (next === current && this.target === null) return;
    this.target = next;
    this.start(read, apply);
  }

  /** 立即停止动画并清空目标（例如跳转到指定位置前的兜底）。 */
  stop(): void {
    if (this.frame !== null) {
      this.scheduler.cancel(this.frame);
      this.frame = null;
    }
    this.target = null;
    this.lastTime = null;
  }

  private start(
    read: () => { current: number; maxScrollTop: number },
    apply: (position: number) => void
  ): void {
    if (this.frame !== null) return;
    this.lastTime = null;
    const step = (now: number): void => {
      this.frame = null;
      if (this.target === null) return;
      const { current, maxScrollTop } = read();
      const target = Math.max(0, Math.min(Math.max(0, maxScrollTop), this.target));
      const result = dampedScrollStep({ current, target, deltaMs: this.lastTime === null ? null : now - this.lastTime });
      this.lastTime = now;
      apply(result.position);
      if (result.settled) {
        this.target = null;
        this.lastTime = null;
        return;
      }
      this.frame = this.scheduler.request(step);
    };
    this.frame = this.scheduler.request(step);
  }
}
