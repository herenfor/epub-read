import { describe, expect, it } from "vitest";
import { ReadingWarmupPlan } from "./readerWarmup";

describe("ReadingWarmupPlan", () => {
  it("prefers next, prev, next2, prev2 and allows evicted neighbors back in", () => {
    const plan = new ReadingWarmupPlan();
    plan.reset([0, 1, 2, 3, 4, 5]);
    const first = plan.take(2, new Set([2]), false, false);
    expect(first?.chapter).toBe(3);
    plan.finish(first!, true);

    // 3 仍是 resident 时跳过去；2 的另一侧与两步邻居按优先级继续。
    const second = plan.take(2, new Set([2, 3]), false, false);
    expect(second?.chapter).toBe(1);
    plan.finish(second!, true);

    // 已 display-ready 的 3 即使曾被标记 done，只要 DOM 被淘汰仍要重新预热。
    const again = plan.take(2, new Set([2, 1]), false, false);
    expect(again?.chapter).toBe(3);
  });

  it("runs one background ticket at a time and interrupt does not mark it done", () => {
    const plan = new ReadingWarmupPlan();
    plan.reset([0, 1, 2]);
    const ticket = plan.take(0, new Set([0]), false, false);
    expect(ticket?.chapter).toBe(1);
    expect(plan.take(0, new Set([0]), false, false)).toBeNull();
    expect(plan.interrupt()).toEqual(ticket);
    // 取消不算完成，所以同一章会重新入队。
    const retry = plan.take(0, new Set([0]), false, false);
    expect(retry?.chapter).toBe(1);
    expect(plan.finish(retry!, false)).toBe(true);
    // 失败章不在同一 epoch 内反复重试。
    expect(plan.take(0, new Set([0]), false, false)?.chapter).toBe(2);
  });

  it("does not issue work while input or foreground is pending", () => {
    const plan = new ReadingWarmupPlan();
    plan.reset([0, 1]);
    expect(plan.take(0, new Set([0]), true, false)).toBeNull();
    expect(plan.take(0, new Set([0]), false, true)).toBeNull();
  });
});
