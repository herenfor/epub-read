import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TransformPageMotion } from "./transformPageMotion";
import { desktopSettlePlan } from "./pageMotion";

/** 只解析 matrix(a,b,c,d,e,f) 的 e（m41）；测试环境没有 DOMMatrix。 */
class FakeMatrix {
  m41: number;
  constructor(value: string) {
    this.m41 = Number(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.e]+)/.exec(value)?.[1] ?? 0);
  }
}

function fakeViewer(options: { scrollWidth?: () => number } = {}) {
  const events: string[] = [];
  const style = new Map<string, { value: string; priority: string }>();
  let presentedX: number | null = null;
  let scrollLeft = 0;
  const viewer = {
    events,
    style: {
      getPropertyValue: (name: string) => style.get(name)?.value ?? "",
      getPropertyPriority: (name: string) => style.get(name)?.priority ?? "",
      setProperty: (name: string, value: string, priority = "") => {
        events.push(`set ${name}=${value}`);
        style.set(name, { value, priority });
      },
      removeProperty: (name: string) => { events.push(`remove ${name}`); style.delete(name); },
    },
    get scrollLeft() { return scrollLeft; },
    set scrollLeft(value: number) { events.push(`scrollLeft=${value}`); scrollLeft = value; },
    // 浏览器 scrollWidth 至少等于 clientWidth；短章扩成 5 屏会虚增宽度。
    get scrollWidth() { return Math.max(options.scrollWidth?.() ?? 1000, viewer.clientWidth); },
    get clientWidth() { return Number.parseFloat(style.get("width")?.value ?? "100"); },
    animations: [] as Array<{ cancelled: boolean; finishCalled: boolean; resolve: () => void;
      frames: Keyframe[]; options?: KeyframeAnimationOptions }>,
    animate(frames: Keyframe[], options?: KeyframeAnimationOptions) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const finished = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
      const record = {
        cancelled: false,
        finishCalled: false,
        frames, options,
        resolve: () => resolve(),
        finished,
        cancel() { events.push("cancel"); record.cancelled = true; reject(new Error("AbortError")); },
        finish() { record.finishCalled = true; },
      };
      viewer.animations.push(record);
      return record as unknown as Animation;
    },
    present(x: number | null) { presentedX = x; },
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({
          transform: presentedX === null
            ? (style.get("transform")?.value.replace(/translateX\(([-\d.e]+)px\)/, "matrix(1, 0, 0, 1, $1, 0)") ?? "none")
            : `matrix(1, 0, 0, 1, ${presentedX}, 0)`,
        }),
      },
    },
  };
  style.set("width", { value: "100px", priority: "" });
  scrollLeft = 300;
  return viewer;
}

const layout = { offsets: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900], step: 100, columnsPerScreen: 1 };

beforeAll(() => { (globalThis as Record<string, unknown>).DOMMatrixReadOnly = FakeMatrix; });
afterAll(() => { delete (globalThis as Record<string, unknown>).DOMMatrixReadOnly; });

describe("transform page motion driver", () => {
  it.each([2, 4, 10])("RTL %i-screen motion interrupts at its displayed position and restores a negative scroll origin", async screens => {
    const viewer = fakeViewer({ scrollWidth: () => screens * 100 });
    viewer.scrollLeft = 0;
    const faults: unknown[] = [];
    const driver = new TransformPageMotion(viewer as unknown as HTMLElement, {
      offsets: Array.from({ length: screens }, (_, i) => i * 100), step: 100,
      columnsPerScreen: 2, progression: "rtl",
    }, 0, e => faults.push(e));
    let done = 0;
    driver.animateTo(100, desktopSettlePlan(100, 100), () => done++);
    const old = viewer.animations[0];
    const mid = Math.floor(Math.min(5, screens) / 2);
    viewer.present(-(-viewer.scrollLeft + mid * 100 - 40));
    expect(driver.interrupt().sample.position).toBe(40);
    viewer.present(null);
    driver.animateTo(0, desktopSettlePlan(-40, 100), () => done++);
    old.resolve();
    await Promise.resolve();
    expect(done).toBe(0);
    driver.settleTo(100);
    expect(viewer.scrollLeft).toBe(-100);
    expect(driver.read().position).toBe(100);
    expect(viewer.style.getPropertyValue("width")).toBe("100px");
    expect(faults).toEqual([]);
  });
  it("a burst beyond the bounded window commits its full target without showing clipped content", () => {
    const viewer = fakeViewer();
    const driver = new TransformPageMotion(viewer as unknown as HTMLElement, layout, 300, () => {});
    driver.write(300);
    let completed = 0;
    driver.animateTo(900, desktopSettlePlan(600, 100), () => completed++);
    expect(viewer.animations).toHaveLength(0);
    expect(viewer.scrollLeft).toBe(900);
    expect(driver.active).toBe(false);
    expect(completed).toBe(1);
  });

  it("a disposed faulting driver cannot move to its old target after the fallback takes over", () => {
    const viewer = fakeViewer({ scrollWidth: () =>
      Number(viewer.style.getPropertyValue("column-count") || 1) > 1 ? 2000 : 1000 });
    const driver = new TransformPageMotion(viewer as unknown as HTMLElement, layout, 300,
      () => driver.dispose());
    let completed = 0;
    driver.animateTo(400, desktopSettlePlan(100, 100), () => completed++);
    expect(viewer.scrollLeft).toBe(300);
    expect(viewer.animations).toHaveLength(0);
    expect(completed).toBe(0);
  });
  it("single-page column gap is not counted as a trailing gap when expanding the window", () => {
    const gap = 20;
    const viewer = fakeViewer({ scrollWidth: () => {
      const columns = Number(viewer.style.getPropertyValue("column-count") || 1);
      const columnWidth = (viewer.clientWidth - (columns - 1) * gap) / columns;
      return 10 * columnWidth + 9 * gap;
    } });
    const faults: unknown[] = [];
    const driver = new TransformPageMotion(viewer as unknown as HTMLElement, {
      offsets: Array.from({ length: 10 }, (_, page) => page * 120), step: 120, columnsPerScreen: 1,
    }, 300, error => faults.push(error));
    driver.write(360);
    expect(viewer.clientWidth).toBe(580);
    expect(viewer.scrollWidth).toBe(1180);
    expect(driver.read().position).toBe(360);
    expect(faults).toEqual([]);
    driver.settleTo(360);
    expect(viewer.clientWidth).toBe(100);
    expect(viewer.scrollWidth).toBe(1180);
    expect(viewer.scrollLeft).toBe(360);
  });
  it("desktop hands two endpoints and the unchanged cubic timing to the browser", async () => {
    const viewer = fakeViewer();
    const faults: unknown[] = [];
    const driver = new TransformPageMotion(viewer as unknown as HTMLElement, layout, 300,
      error => faults.push(error));
    const done = () => driver.holdSettledAt(400);
    driver.animateTo(400, desktopSettlePlan(100, 100), done);
    const animation = viewer.animations[0];
    expect(animation.frames).toHaveLength(2);
    expect(animation.options).toMatchObject({ duration: 280,
      easing: "cubic-bezier(0.3333333333, 1, 0.6666666667, 1)" });
    animation.resolve();
    await Promise.resolve();
    expect(driver.read().position).toBe(400);
    expect(faults).toEqual([]);
  });
  it.each([1, 2, 3, 4].flatMap(screens => [1, 2].map(columns => ({ screens, columns }))))(
    "$screens 屏短章、每屏 $columns 栏：准备/动画/中断读数不虚增章宽，退出恢复原几何",
    async ({ screens, columns }) => {
      const viewer = fakeViewer({ scrollWidth: () => screens * 100 });
      viewer.scrollLeft = 0;
      viewer.style.setProperty("column-count", String(columns));
      const faults: unknown[] = [];
      const driver = new TransformPageMotion(viewer as unknown as HTMLElement, {
        offsets: Array.from({ length: screens }, (_, i) => i * 100), step: 100, columnsPerScreen: columns,
      }, 0, e => faults.push(e));
      driver.write(0);
      expect(faults).toEqual([]);
      expect(viewer.scrollWidth).toBe(screens * 100);
      expect(driver.active).toBe(true);
      const target = (screens - 1) * 100;
      if (screens > 1) {
        driver.animateTo(target, { durationMs: 300, tauMs: 90 }, () => driver.holdSettledAt(target));
        expect(viewer.animations).toHaveLength(1);
        // 从正在呈现的 matrix 反算视觉坐标，覆盖偶数窗口与双栏。
        viewer.present(Math.floor(screens / 2) * 100 - target + 25);
        expect(driver.read().position).toBe(target - 25);
        viewer.present(null);
        viewer.animations[0].resolve();
        await Promise.resolve();
        expect(driver.read().position).toBe(target);
      }
      driver.settleTo(target);
      expect(viewer.scrollLeft).toBe(target);
      expect(viewer.style.getPropertyValue("width")).toBe("100px");
      expect(viewer.style.getPropertyValue("column-count")).toBe(String(columns));
      expect(driver.active).toBe(false);
      expect(faults).toEqual([]);
    },
  );

  it("中断：先写同位置底层样式再 cancel，不 finish 到旧目标；落定恢复原几何并停在真实落点", async () => {
    const viewer = fakeViewer();
    const faults: unknown[] = [];
    const driver = new TransformPageMotion(viewer as unknown as HTMLElement, layout, 300, (e) => faults.push(e));
    let done = 0;
    driver.animateTo(400, { durationMs: 300, tauMs: 90 }, () => { done++; });
    expect(driver.active).toBe(true);
    const windowStart = viewer.scrollLeft;
    // 合成层正在呈现 340 处：translateX = start + 2×100 − 340
    viewer.present(windowStart + 200 - 340);
    viewer.events.length = 0;
    const held = driver.interrupt();
    expect(held).toEqual({ kind: "held", sample: { position: 340 } });
    expect(viewer.events).toEqual([`set transform=translateX(${windowStart + 200 - 340}px)`, "cancel"]);
    expect(viewer.animations[0].finishCalled).toBe(false);
    await Promise.resolve();
    expect(done).toBe(0); // 被取消的一轮绝不 done
    expect(faults).toEqual([]); // 取消产生的拒绝被吞掉

    viewer.present(null);
    expect(driver.read().position).toBe(340);
    driver.settleTo(300);
    expect(driver.active).toBe(false);
    expect(viewer.style.getPropertyValue("width")).toBe("100px");
    expect(viewer.style.getPropertyValue("transform")).toBe("");
    expect(viewer.style.getPropertyValue("column-count")).toBe("");
    expect(viewer.scrollLeft).toBe(300);
  });

  it("落定保留窗口：下一次翻页不重写栏几何，显式退出仍恢复实际页", async () => {
    const viewer = fakeViewer();
    const driver = new TransformPageMotion(viewer as unknown as HTMLElement, layout, 300, () => {});
    driver.animateTo(400, { durationMs: 300, tauMs: 90 }, () => driver.holdSettledAt(400));
    viewer.animations[0].resolve();
    await Promise.resolve();
    expect(driver.read().position).toBe(400);
    expect(driver.active).toBe(true);
    viewer.events.length = 0;
    driver.animateTo(500, { durationMs: 300, tauMs: 90 }, () => driver.holdSettledAt(500));
    viewer.animations[1].resolve();
    await Promise.resolve();
    expect(viewer.events.filter(e => /(?:width|column-count|margin-left)=/.test(e))).toEqual([]);
    expect(driver.read().position).toBe(500);
    driver.settleTo(driver.read().position);
    expect(viewer.scrollLeft).toBe(500);
    expect(viewer.style.getPropertyValue("width")).toBe("100px");
    expect(driver.active).toBe(false);
  });

  it("进入窗口改变了整章宽度（栏位被动）：恢复原几何、报故障并直接落到目标", () => {
    let width = 1000;
    const viewer = fakeViewer({ scrollWidth: () => width });
    const originalSet = viewer.style.setProperty;
    viewer.style.setProperty = (name: string, value: string, priority?: string) => {
      if (name === "column-count") width = 1200;
      originalSet(name, value, priority);
    };
    const faults: unknown[] = [];
    const driver = new TransformPageMotion(viewer as unknown as HTMLElement, layout, 300, (e) => faults.push(e));
    let done = 0;
    driver.animateTo(400, { durationMs: 300, tauMs: 90 }, () => { done++; });
    expect(faults).toHaveLength(1);
    expect(done).toBe(1);
    expect(viewer.animations).toHaveLength(0);
    expect(viewer.style.getPropertyValue("width")).toBe("100px");
    expect(driver.read().position).toBe(400);
  });
});
