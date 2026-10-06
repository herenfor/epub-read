import { describe, expect, it } from "vitest";
import {
  PageMotionSession,
  settlePlan,
  settleProgress,
  type InterruptResult,
  type MotionSample,
  type PageMotionDriver,
  type SettlePlan,
} from "./pageMotion";

/** 可控驱动：动画不自动完成，测试显式 finish/推进位置。 */
class FakeDriver implements PageMotionDriver {
  position: number;
  supported = true;
  animations: Array<{ to: number; plan: SettlePlan; done: () => void; live: boolean }> = [];
  constructor(start: number) { this.position = start; }
  read(): MotionSample { return { position: this.position }; }
  interrupt(): InterruptResult {
    const sample = this.read();
    if (!this.supported) return { kind: "unsupported", sample };
    for (const a of this.animations) a.live = false;
    return { kind: "held", sample };
  }
  write(position: number): void { this.position = position; }
  animateTo(position: number, plan: SettlePlan, done: () => void): void {
    this.animations.push({ to: position, plan, done, live: true });
  }
  dispose(): void {}
  /** 让最近一段动画走到 fraction 处（中途）。 */
  advance(fraction: number): void {
    const a = this.animations.at(-1)!;
    this.position += (a.to - this.position) * fraction;
  }
  finish(index = this.animations.length - 1): void {
    const a = this.animations[index];
    this.position = a.to;
    a.done();
  }
}

const offsets = [0, 100, 200, 300];

function session(start = 100) {
  const driver = new FakeDriver(start);
  const commits: number[] = [];
  const mismatches: number[] = [];
  const s = new PageMotionSession(driver, offsets, Math.round(start / 100),
    (page) => commits.push(page), (sample) => mismatches.push(sample.position));
  return { driver, s, commits, mismatches };
}

describe("page motion session", () => {
  it("A→B 半途反向回到 A；独立输入继续累计，同一输入 ID 只消费一次", () => {
    const { driver, s, commits } = session(100);
    expect(s.turn(1, 1)).toMatchObject({ kind: "moving", targetPage: 2 });
    driver.advance(0.4); // 140
    expect(s.turn(2, -1)).toMatchObject({ kind: "moving", targetPage: 1 }); // 回 A，不是 A 的上一页
    expect(driver.animations.at(-1)!.to).toBe(100);
    expect(s.turn(2, -1)).toEqual({ kind: "duplicate" }); // 同一操作派生的第二个回调
    // 返回途中再反向一次：第二个独立输入 → A 的上一页
    expect(s.turn(3, -1)).toMatchObject({ kind: "moving", targetPage: 0 });
    // A→B→C 未完成时反向一次 → B
    driver.finish();
    expect(commits).toEqual([0]);
    s.turn(4, 1);
    s.turn(5, 1);
    expect(s.turn(6, -1)).toMatchObject({ kind: "moving", targetPage: 1 });
  });

  it("去目标页途中同向再拖：以目标页为起点续到下一屏；反向拖以最近屏为起点", () => {
    const { driver, s } = session(100);
    s.turn(1, 1); // → 2
    driver.advance(0.3); // 130，最近屏仍是 1
    expect(s.beginDrag(1)).toMatchObject({ kind: "dragging", originPage: 2 });
    const { s: s2, driver: d2 } = session(100);
    s2.turn(1, 1);
    d2.advance(0.3);
    expect(s2.beginDrag(-1)).toMatchObject({ kind: "dragging", originPage: 1 });
  });

  it("旧动画/旧拖动完成不能提交新目标", () => {
    const { driver, s, commits } = session(100);
    s.turn(1, 1); // → 2
    const stale = 0;
    driver.advance(0.5);
    s.turn(2, -1); // → 1，旧动画失效
    driver.finish(stale); // 旧回调迟到
    expect(commits).toEqual([]);
    driver.finish(); // 当前动画落定
    expect(commits).toEqual([1]);

    const drag = s.beginDrag();
    expect(drag.kind).toBe("dragging");
    const ticket = drag.kind === "dragging" ? drag.ticket : -1;
    s.turn(3, 1); // 按钮取代拖动
    expect(s.releaseDrag(ticket, 0, null)).toBeNull(); // 旧 touchend 无效
    s.drag(ticket, 0);
    expect(driver.position).not.toBe(0);
  });

  it("unsupported 保留旧执行权、不开第二条动画；外部落定后复用待执行目标", () => {
    const { driver, s, commits } = session(100);
    const external = s.observeExternal(1, 2); // 原生已接手的一次横滑
    driver.supported = false;
    expect(s.turn(1, 1)).toMatchObject({ kind: "unsupported", targetPage: 3 });
    expect(driver.animations).toHaveLength(0);
    expect(s.state).toMatchObject({ kind: "external", ticket: external });
    // 期限到不算证明：仍按着或未静止都不提交
    s.externalSettled(external, false, true);
    expect(commits).toEqual([]);
    driver.position = 200;
    s.externalSettled(external, true, true);
    expect(commits).toEqual([2]);
    driver.supported = true;
    expect(s.resumeDeferred()).toMatchObject({ kind: "moving", targetPage: 3 });
    expect(driver.animations).toHaveLength(1);
  });

  it("收尾曲线：接上松手速度、指数减速并恰好落定；点按用默认常数", () => {
    const fast = settlePlan(300, 3); // 300px 剩余，3px/ms 同向
    expect(fast.tauMs).toBe(100);
    expect(settleProgress(fast, 1)).toBeCloseTo(1, 6);
    expect(settleProgress(fast, 0.2)).toBeGreaterThan(0.5); // 前段快、尾段长
    expect(settlePlan(300, -3).tauMs).toBe(90); // 反向速度不接
    expect(settlePlan(0.2, null).durationMs).toBe(0);
    expect(settlePlan(5000, null).durationMs).toBe(700);
  });

  it("手势尾段接续原速度、单调落定且终速为零；点按保持指数曲线", () => {
    const plan = settlePlan(-166.5, -166.5 / 135);
    expect(plan).toMatchObject({ curve: "finite-drift", durationMs: 540, tauMs: 135 });
    const epsilon = 0.00001;
    const slope = (t: number) => (settleProgress(plan, t + epsilon) - settleProgress(plan, t)) / epsilon;
    expect(166.5 * slope(0) / plan.durationMs).toBeCloseTo(166.5 / 135, 3);
    expect(slope(0.5 - epsilon)).toBeCloseTo(slope(0.5), 3);
    expect(slope(1 - epsilon)).toBeLessThan(0.0001);
    expect(settleProgress(plan, 1)).toBe(1);
    let previous = 0;
    for (let i = 1; i <= 100; i++) {
      const progress = settleProgress(plan, i / 100);
      expect(progress).toBeGreaterThanOrEqual(previous);
      expect(progress).toBeLessThanOrEqual(1);
      previous = progress;
    }
    expect(settlePlan(166.5, null).curve).toBeUndefined();
    expect(settlePlan(166.5, -1).curve).toBeUndefined();
  });
});
