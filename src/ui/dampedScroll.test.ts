import { describe, expect, it } from "vitest";
import {
  accumulateWheelTarget,
  dampedScrollStep,
  DampedScrollAnimator,
  type FrameScheduler,
} from "./dampedScroll";

describe("dampedScrollStep", () => {
  it("按指数衰减推进，单帧完成约 48.7% 位移且不越过目标", () => {
    // dt = 16.7ms, τ = 25ms -> decay = 1 - e^(-16.7/25) ≈ 0.48727
    const expected = 360 * (1 - Math.exp(-16.7 / 25));
    const first = dampedScrollStep({ current: 0, target: 360, deltaMs: 16.7 });
    expect(first.settled).toBe(false);
    expect(first.position).toBeCloseTo(expected, 6);

    const second = dampedScrollStep({ current: first.position, target: 360, deltaMs: 16.7 });
    expect(second.position).toBeGreaterThan(first.position);
    expect(second.position).toBeLessThan(360);
  });

  it("4~6 帧内覆盖超过 96% 位移，无慢速拖尾", () => {
    let position = 0;
    const target = 360;
    let frames = 0;
    while (position < target * 0.96 && frames < 12) {
      position = dampedScrollStep({ current: position, target, deltaMs: 16.7 }).position;
      frames += 1;
    }
    expect(frames).toBeGreaterThanOrEqual(4);
    expect(frames).toBeLessThanOrEqual(6);
  });

  it("残余小于 1px 时吸附停定，不产生亚像素漂移", () => {
    const result = dampedScrollStep({ current: 359.5, target: 360, deltaMs: 16.7 });
    expect(result.settled).toBe(true);
    expect(result.position).toBe(360);
  });

  it("首帧按假定帧长推进，极小位移也走最小步长收敛", () => {
    const tiny = dampedScrollStep({ current: 0, target: 1.5, deltaMs: null });
    expect(tiny.position).toBeGreaterThan(0);
    expect(tiny.position).toBeLessThanOrEqual(1.5);
  });

  it("反向目标立即回转，不会继续向旧方向滑行", () => {
    const result = dampedScrollStep({ current: 100, target: 0, deltaMs: 16.7 });
    expect(result.position).toBeLessThan(100);
    expect(result.settled).toBe(false);
  });

  it("帧长异常或过长时被钳制，后台恢复不会一帧跳跃过大", () => {
    const capped = dampedScrollStep({ current: 0, target: 100000, deltaMs: 5000 });
    const normal = dampedScrollStep({ current: 0, target: 100000, deltaMs: 32 });
    expect(capped.position).toBeCloseTo(normal.position, 5);
  });

  it("当前与目标非法数值时直接停定", () => {
    expect(dampedScrollStep({ current: Number.NaN, target: 10, deltaMs: 16.7 }).settled).toBe(true);
    expect(dampedScrollStep({ current: 0, target: Number.NaN, deltaMs: 16.7 }).settled).toBe(true);
  });
});

describe("accumulateWheelTarget", () => {
  it("同向连续滚轮从尚未到达的目标续加", () => {
    expect(accumulateWheelTarget(0, 300, 60, 10000)).toBe(360);
  });

  it("反向输入从当前画面立即回转，不先抵消未完成的目标", () => {
    expect(accumulateWheelTarget(100, 300, -40, 10000)).toBe(60);
  });

  it("钳制在 [0, maxScrollTop] 内", () => {
    expect(accumulateWheelTarget(0, null, -120, 10000)).toBe(0);
    expect(accumulateWheelTarget(9900, null, 300, 10000)).toBe(10000);
  });

  it("目标非法或缺失时以当前位置为基准", () => {
    expect(accumulateWheelTarget(50, null, 25, 10000)).toBe(75);
    expect(accumulateWheelTarget(50, Number.NaN, 25, 10000)).toBe(75);
  });
});

/** 手动推进 rAF 的测试调度器，不依赖真实计时器。 */
class ManualScheduler implements FrameScheduler {
  private next = 1;
  private callbacks = new Map<number, (now: number) => void>();
  now = 0;

  request(callback: (now: number) => void): number {
    const handle = this.next++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.callbacks.delete(handle);
  }

  /** 推进一帧；frameMs 为本次经过的毫秒数。返回是否还有待执行帧。 */
  tick(frameMs: number): boolean {
    this.now += frameMs;
    const pending = Array.from(this.callbacks.entries());
    this.callbacks.clear();
    for (const [, callback] of pending) callback(this.now);
    return this.callbacks.size > 0;
  }
}

describe("DampedScrollAnimator", () => {
  it("收敛后停止帧循环，不保留常驻 rAF", () => {
    const scheduler = new ManualScheduler();
    const animator = new DampedScrollAnimator(scheduler);
    let position = 0;
    animator.addDelta(
      360,
      () => ({ current: position, maxScrollTop: 10000 }),
      (next) => {
        position = next;
      }
    );

    let frames = 0;
    while (scheduler.tick(16.7) && frames < 30) frames += 1;
    expect(position).toBe(360);
    expect(scheduler.tick(16.7)).toBe(false);
  });

  it("连续拨轮只累加目标，单条动画一次到位", () => {
    const scheduler = new ManualScheduler();
    const animator = new DampedScrollAnimator(scheduler);
    let position = 0;
    const read = () => ({ current: position, maxScrollTop: 10000 });
    const apply = (next: number) => {
      position = next;
    };

    animator.addDelta(120, read, apply);
    animator.addDelta(120, read, apply);
    animator.addDelta(120, read, apply);

    let frames = 0;
    while (scheduler.tick(16.7) && frames < 30) frames += 1;
    expect(position).toBe(360);
  });

  it("stop() 立即取消未完成的动画，交由调用方接管位置", () => {
    const scheduler = new ManualScheduler();
    const animator = new DampedScrollAnimator(scheduler);
    let position = 0;
    const read = () => ({ current: position, maxScrollTop: 10000 });
    const apply = (next: number) => {
      position = next;
    };

    animator.addDelta(5000, read, apply);
    scheduler.tick(16.7);
    const mid = position;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(5000);

    animator.stop();
    position = 1234;
    scheduler.tick(16.7);
    expect(position).toBe(1234);
  });

  it("内容变短时目标被钳制到新的最大滚动位置", () => {
    const scheduler = new ManualScheduler();
    const animator = new DampedScrollAnimator(scheduler);
    let position = 0;
    let maxScrollTop = 10000;
    animator.addDelta(
      5000,
      () => ({ current: position, maxScrollTop }),
      (next) => {
        position = next;
      }
    );

    scheduler.tick(16.7);
    maxScrollTop = 800;
    let frames = 0;
    while (scheduler.tick(16.7) && frames < 40) frames += 1;
    expect(position).toBe(800);
  });
});
