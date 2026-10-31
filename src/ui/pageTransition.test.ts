import { afterEach, describe, expect, it, vi } from "vitest";
import { runPageTransition } from "./pageTransition";

afterEach(() => { vi.unstubAllGlobals(); });

function stubDocument(startViewTransition?: (update: () => void) => unknown, reduced = false) {
  const documentElement = { dataset: {} as Record<string, string> };
  vi.stubGlobal("document", { documentElement, startViewTransition });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
  return documentElement;
}

describe("full-screen page transition", () => {
  it("runs the update at once without view transitions or when the system wants no motion", async () => {
    stubDocument();
    const update = vi.fn();
    await runPageTransition("back", update);
    expect(update).toHaveBeenCalledTimes(1);

    const start = vi.fn();
    const root = stubDocument(start, true);
    await runPageTransition("back", update);
    expect(update).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    expect(root.dataset.pageTransition).toBeUndefined();
  });

  it("marks the direction for the snapshot styles and clears it when the animation ends", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const root = stubDocument((update) => {
      update();
      return { finished, updateCallbackDone: Promise.resolve() };
    });
    const update = vi.fn();
    await runPageTransition("back", update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(root.dataset.pageTransition).toBe("back");
    finish();
    await finished;
    await Promise.resolve();
    expect(root.dataset.pageTransition).toBeUndefined();
  });
});
