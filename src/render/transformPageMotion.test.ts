import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TransformPageMotion } from "./transformPageMotion";

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
    get scrollWidth() { return options.scrollWidth?.() ?? 1000; },
    get clientWidth() { return Number.parseFloat(style.get("width")?.value ?? "100"); },
    animations: [] as Array<{ cancelled: boolean; finishCalled: boolean; resolve: () => void }>,
    animate(_frames: Keyframe[]) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const finished = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
      const record = {
        cancelled: false,
        finishCalled: false,
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
