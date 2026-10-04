import { describe, expect, it } from "vitest";
import { animateValue, dragScrollLeft, hermiteEase, releaseSlidePlan, releaseVelocity, slideDurationMs, SLIDE_FULL_MS, type AnimationClock } from "./pagedSlide";

function manualClock() {
  let time = 0;
  let next = 1;
  const queue = new Map<number, () => void>();
  const clock: AnimationClock = {
    now: () => time,
    request: (callback) => {
      const handle = next++;
      queue.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      queue.delete(handle);
    },
  };
  const tick = (ms: number): void => {
    time += ms;
    const callbacks = [...queue.values()];
    queue.clear();
    callbacks.forEach((callback) => callback());
  };
  return { clock, tick, pending: () => queue.size };
}

describe("dragScrollLeft", () => {
  it("follows the finger 1:1 toward the next page and clamps to one page", () => {
    const frame = { from: 1000, to: 2000 };
    expect(dragScrollLeft(frame, -300)).toBe(1300);
    expect(dragScrollLeft(frame, -1500)).toBe(2000);
    // 反向拖动停在当前页，不露出上一页
    expect(dragScrollLeft(frame, 200)).toBe(1000);
  });

  it("maps a rightward drag to the previous page", () => {
    const frame = { from: 1000, to: 0 };
    expect(dragScrollLeft(frame, 250)).toBe(750);
    expect(dragScrollLeft(frame, -40)).toBe(1000);
  });
});

describe("slideDurationMs", () => {
  it("uses the full duration for a whole page and shortens near the end", () => {
    expect(slideDurationMs(1000, 1000)).toBe(SLIDE_FULL_MS);
    expect(slideDurationMs(250, 1000)).toBeLessThan(SLIDE_FULL_MS);
    expect(slideDurationMs(1, 1000)).toBeGreaterThanOrEqual(90);
    expect(slideDurationMs(0, 1000)).toBe(0);
  });
});

describe("animateValue", () => {
  it("eases to the target and completes once", () => {
    const { clock, tick } = manualClock();
    const values: number[] = [];
    let done = 0;
    const animation = animateValue(0, 100, 200, (v) => values.push(v), () => done++, clock);
    tick(100);
    expect(values.at(-1)).toBeGreaterThan(50);
    expect(animation.active).toBe(true);
    tick(150);
    expect(values.at(-1)).toBe(100);
    expect(done).toBe(1);
    expect(animation.active).toBe(false);
  });

  it("finish jumps to the target immediately; cancel never completes", () => {
    const first = manualClock();
    let done = 0;
    let last = -1;
    animateValue(0, 100, 200, (v) => (last = v), () => done++, first.clock).finish();
    expect(last).toBe(100);
    expect(done).toBe(1);
    expect(first.pending()).toBe(0);

    const second = manualClock();
    const cancelled = animateValue(0, 100, 200, () => {}, () => done++, second.clock);
    cancelled.cancel();
    second.tick(500);
    expect(done).toBe(1);
  });
});

describe("release continuation", () => {
  it("starts at the finger's speed instead of jumping ahead on the first frame", () => {
    // 平板：拖了 250px 后慢速松手，剩余 950px。
    const slow = releaseSlidePlan(950, 1200, 1.2);
    const firstFrame = 950 * slow.ease(8.3 / slow.durationMs);
    expect(firstFrame).toBeLessThan(25);
    // 旧曲线 easeOutCubic 在同一帧会跳出约 90px。
    expect(950 * (1 - (1 - 8.3 / slideDurationMs(950, 1200)) ** 3)).toBeGreaterThan(80);
  });

  it("matches a fast fling and shortens the animation without overshooting", () => {
    const plan = releaseSlidePlan(600, 1200, 12);
    expect(plan.durationMs).toBeLessThan(slideDurationMs(600, 1200));
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const v = plan.ease(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(plan.ease(1)).toBeCloseTo(1);
  });

  it("ignores movement away from the target and a finger that stopped", () => {
    expect(releaseSlidePlan(-500, 1200, 3).durationMs).toBe(slideDurationMs(-500, 1200));
    expect(hermiteEase(0.5)(0)).toBe(0);
    expect(releaseVelocity([{ t: 0, x: 0 }, { t: 16, x: 32 }], 20)).toBeCloseTo(2);
    expect(releaseVelocity([{ t: 0, x: 0 }, { t: 16, x: 32 }], 200)).toBe(0);
    expect(releaseVelocity([{ t: 0, x: 0 }], 5)).toBe(0);
  });
});
