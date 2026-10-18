import { describe, expect, it, vi } from "vitest";
import { ChapterSeam } from "./chapterSeam";

/** Two iframe stand-ins: inline transform plus a manually finished WAAPI animation. */
function fakeElement() {
  const styles = new Map<string, string>();
  const runs: Array<{ finish(): void; cancelled: boolean }> = [];
  const element = {
    style: {
      setProperty: (name: string, value: string) => { styles.set(name, value); },
      removeProperty: (name: string) => { styles.delete(name); },
    },
    ownerDocument: { defaultView: { getComputedStyle: () => ({ transform: "none" }) } },
    animate: () => {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const finished = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
      finished.catch(() => {});
      const run = { cancelled: false, finish: () => resolve(), cancel: () => { run.cancelled = true; reject(new Error("cancelled")); } };
      runs.push(run);
      return { finished, cancel: run.cancel };
    },
  };
  return { element: element as unknown as HTMLElement, transform: () => styles.get("transform") ?? null, runs };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function seam(direction: 1 | -1, progression: "ltr" | "rtl" = "ltr") {
  const current = fakeElement();
  const neighbor = fakeElement();
  const onSettled = vi.fn();
  const instance = new ChapterSeam({
    direction, current: current.element, neighbor: neighbor.element, width: 800, progression,
    touch: true, onSettled, onFault: vi.fn(),
  });
  const finishAll = async () => {
    for (const run of [...current.runs, ...neighbor.runs]) if (!run.cancelled) run.finish();
    await flush();
  };
  return { instance, current, neighbor, onSettled, finishAll };
}

describe("ChapterSeam", () => {
  it("places the next chapter one screen beside the chapter edge and follows the finger 1:1", () => {
    const { instance, current, neighbor } = seam(1);
    expect(current.transform()).toBe("translate3d(0px, 0, 0)");
    expect(neighbor.transform()).toBe("translate3d(800px, 0, 0)");
    const ticket = instance.beginDrag(1)!;
    instance.drag(ticket, -300);
    expect(current.transform()).toBe("translate3d(-300px, 0, 0)");
    expect(neighbor.transform()).toBe("translate3d(500px, 0, 0)");
    // One gesture crosses at most the one seam.
    instance.drag(ticket, -1200);
    expect(neighbor.transform()).toBe("translate3d(0px, 0, 0)");
  });

  it("mirrors the neighbour to the left for right-to-left books", () => {
    const { current, neighbor } = seam(1, "rtl");
    expect(current.transform()).toBe("translate3d(0px, 0, 0)");
    expect(neighbor.transform()).toBe("translate3d(-800px, 0, 0)");
  });

  it("lands on the neighbour after a forward release and keeps both leaves in their final place", async () => {
    const { instance, current, neighbor, onSettled, finishAll } = seam(1);
    const ticket = instance.beginDrag(1)!;
    instance.drag(ticket, -500);
    expect(instance.release(ticket, 1, 1.2)).toBe(true);
    expect(current.runs).toHaveLength(1);
    expect(neighbor.runs).toHaveLength(1);
    await finishAll();
    expect(onSettled).toHaveBeenCalledWith(true);
    // Held until the host promotes the cached chapter; only then disposed.
    expect(neighbor.transform()).toBe("translate3d(0px, 0, 0)");
    expect(current.transform()).toBe("translate3d(-800px, 0, 0)");
    instance.dispose();
    expect(current.transform()).toBeNull();
    expect(neighbor.transform()).toBeNull();
  });

  it("springs back to the current chapter when the drag is not taken", async () => {
    const { instance, onSettled, finishAll } = seam(1);
    const ticket = instance.beginDrag(1)!;
    instance.drag(ticket, -200);
    expect(instance.release(ticket, 0, null)).toBe(true);
    await finishAll();
    expect(onSettled).toHaveBeenCalledWith(false);
  });

  it("turns by command, reverses on an opposite command and reports a second same-way turn as beyond", async () => {
    const { instance, onSettled, finishAll } = seam(1);
    expect(instance.turn(1, 1)).toBe("moving");
    expect(instance.turn(2, 1)).toBe("beyond");
    expect(instance.turn(2, 1)).toBe("duplicate");
    expect(instance.turn(3, -1)).toBe("moving");
    await finishAll();
    expect(onSettled).toHaveBeenLastCalledWith(false);
  });

  it("cancels a half-built pair of animations and reports the fault instead of settling", () => {
    const current = fakeElement();
    const neighbor = fakeElement();
    (neighbor.element as unknown as { animate: () => never }).animate = () => { throw new Error("no animations"); };
    const onSettled = vi.fn();
    let instance: ChapterSeam | null = null;
    // The host releases ownership on a fault, as ReaderView's cancel path does.
    const onFault = vi.fn(() => instance?.dispose());
    instance = new ChapterSeam({ direction: 1, current: current.element, neighbor: neighbor.element, width: 800,
      progression: "ltr", touch: true, onSettled, onFault });
    expect(instance.turn(1, 1)).toBe("moving");
    expect(current.runs).toHaveLength(1);
    expect(current.runs[0].cancelled).toBe(true);
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
    expect(current.transform()).toBeNull();
  });

  it("brings the previous chapter in from its last screen when turning back", async () => {
    const { instance, current, neighbor, onSettled, finishAll } = seam(-1);
    expect(current.transform()).toBe("translate3d(0px, 0, 0)");
    expect(neighbor.transform()).toBe("translate3d(-800px, 0, 0)");
    expect(instance.turn(1, -1)).toBe("moving");
    await finishAll();
    expect(onSettled).toHaveBeenCalledWith(true);
    expect(neighbor.transform()).toBe("translate3d(0px, 0, 0)");
    expect(current.transform()).toBe("translate3d(800px, 0, 0)");
  });

  it("moves a prepared track like pages in one chapter: later commands retarget, one landing at the end", async () => {
    const screens = [fakeElement(), fakeElement(), fakeElement(), fakeElement()];
    const onSettled = vi.fn();
    // Reading order: previous group, current, next, the one after.
    const instance = new ChapterSeam({ direction: 1, current: screens[1].element, neighbor: screens[2].element,
      track: screens.map((screen) => screen.element), width: 800, progression: "rtl", touch: true, onSettled, onFault: vi.fn() });
    expect(screens.map((screen) => screen.transform())).toEqual([
      "translate3d(800px, 0, 0)", "translate3d(0px, 0, 0)", "translate3d(-800px, 0, 0)", "translate3d(-1600px, 0, 0)"]);
    expect(instance.turn(1, 1)).toBe("moving");
    expect(instance.turn(2, 1)).toBe("moving");
    expect(instance.turn(3, 1)).toBe("beyond");
    for (const screen of screens) for (const run of screen.runs) if (!run.cancelled) run.finish();
    await flush();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(true);
    expect(instance.settledScreen).toBe(3);
    expect(screens[3].transform()).toBe("translate3d(0px, 0, 0)");
  });

  it("reports no landed screen when a track returns to where it started", async () => {
    const screens = [fakeElement(), fakeElement(), fakeElement()];
    const onSettled = vi.fn();
    const instance = new ChapterSeam({ direction: -1, current: screens[1].element, neighbor: screens[0].element,
      track: screens.map((screen) => screen.element), width: 800, progression: "ltr", touch: true, onSettled, onFault: vi.fn() });
    instance.turn(1, -1);
    instance.turn(2, 1);
    for (const screen of screens) for (const run of screen.runs) if (!run.cancelled) run.finish();
    await flush();
    expect(onSettled).toHaveBeenCalledWith(false);
    expect(instance.settledScreen).toBeNull();
  });
});
