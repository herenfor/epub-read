import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { installPagedSwipe } from "../render/pagedSwipe";
import { ChapterSeam } from "./chapterSeam";
import { SeamGestureInput } from "./seamGestureInput";

function setup() {
  const runs: Array<() => void> = [];
  const styles = new Map<string, string>();
  const element = () => ({
    style: { setProperty: (key: string, value: string) => styles.set(key, value), removeProperty: () => {} },
    ownerDocument: { defaultView: { getComputedStyle: () => ({ transform: "none" }) } },
    animate: () => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      runs.push(finish);
      return { finished, cancel() {} };
    },
  }) as unknown as HTMLElement;
  const settled = vi.fn();
  const seam = new ChapterSeam({ direction: 1, current: element(), neighbor: element(), width: 800,
    progression: "ltr", touch: true, onSettled: settled, onFault: (error) => { throw error; } });
  let live: { seam: ChapterSeam; landed: boolean; pending: 1 | -1 | null } | null = { seam, landed: false, pending: null };
  const pending = vi.fn((direction: 1 | -1 | null) => { if (live) live.pending = direction; });
  const previewCurrent = vi.fn();
  const turnCurrent = vi.fn();
  const input = new SeamGestureInput({ live: () => live, progression: () => "ltr", pending, previewCurrent, turnCurrent });
  const finish = async () => { runs.forEach(run => run()); await Promise.resolve(); await Promise.resolve(); };
  return { input, seam, settled, pending, previewCurrent, turnCurrent, finish, styles,
    land: () => { live!.landed = true; },
    promote: () => { seam.dispose(); live = null; input.promoted(); },
  };
}

describe("continuous seam input", () => {
  it("shares commands across leaves, queues one extra turn and lets a reverse catch replace it", async () => {
    const h = setup();
    expect(h.input.turn(1)).toBe("moving");
    expect(h.input.turn(1)).toBe("moving");
    expect(h.pending).toHaveBeenLastCalledWith(1);
    h.input.preview(100); // New finger catches the moving reader, instead of a disabled incoming leaf.
    expect(h.pending).toHaveBeenLastCalledWith(null);
    h.input.preview(null);
    h.input.turn(-1);
    await h.finish();
    expect(h.settled).toHaveBeenLastCalledWith(false);
    expect(h.turnCurrent).not.toHaveBeenCalled();
  });

  it("keeps a surface gesture alive when the reader is promoted between touchstart and touchmove", async () => {
    const h = setup();
    const { document } = parseHTML('<html><body><div id="input"></div></body></html>');
    const surface = document.getElementById("input")!;
    Object.defineProperty(Object.getPrototypeOf(surface.style), "getPropertyPriority", { value: () => "", configurable: true });
    const cleanup = installPagedSwipe(surface, {
      shouldIgnore: () => false, onNext: () => h.input.turn(1), onPrev: () => h.input.turn(-1),
      onPreview: dx => h.input.preview(dx),
    });
    const touch = (type: string, x: number) => {
      const event = new document.defaultView!.Event(type, { bubbles: true, cancelable: true });
      const point = { screenX: x, screenY: 100 };
      Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [point] }, changedTouches: { value: [point] } });
      surface.dispatchEvent(event);
    };
    h.input.turn(1);
    touch("touchstart", 400);
    await h.finish();
    h.land();
    h.promote();
    touch("touchmove", 320);
    touch("touchend", 300);
    expect(h.previewCurrent).toHaveBeenCalledWith(-80);
    expect(h.turnCurrent).toHaveBeenCalledExactlyOnceWith(1);
    cleanup();
  });

  it("carries a handoff preview and cancels an unclaimed release without reviving the old seam", async () => {
    const h = setup();
    h.input.preview(-70);
    h.input.preview(null); // microtask spring-back is pending
    h.input.cancel();
    h.land();
    h.input.preview(90);
    h.promote();
    await Promise.resolve();
    expect(h.previewCurrent).toHaveBeenLastCalledWith(90);
    expect(h.settled).not.toHaveBeenCalled();
    expect(h.turnCurrent).not.toHaveBeenCalled();
  });

  it("withdraws a reserved turn on the opposite command instead of reversing the motion (A→B→C, back = B)", async () => {
    const h = setup();
    expect(h.input.turn(1)).toBe("moving");
    expect(h.input.turn(1)).toBe("moving");
    expect(h.pending).toHaveBeenLastCalledWith(1);
    expect(h.input.turn(-1)).toBe("moving");
    expect(h.pending).toHaveBeenLastCalledWith(null);
    await h.finish();
    expect(h.settled).toHaveBeenLastCalledWith(true);
    // A further opposite command now really reverses toward the current screen.
    h.land();
    h.input.turn(1);
    expect(h.pending).toHaveBeenLastCalledWith(1);
    h.input.turn(-1);
    expect(h.pending).toHaveBeenLastCalledWith(null);
  });
});
