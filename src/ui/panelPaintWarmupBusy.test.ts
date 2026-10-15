import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { createReactDomHarness } from "../test/reactDomHarness";
import { panelWarmHold, PANEL_WARM_IDLE_DELAY_MS, usePanelPaintWarmup, type PanelWarmBatch } from "./panelPaintWarmup";

const FRAME = 16;

it("Q5: holds after-veil batches while reading is busy and draws once it is quiet", async () => {
  vi.useFakeTimers();
  const dom = createReactDomHarness();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), FRAME) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  let api!: ReturnType<typeof usePanelPaintWarmup>;
  let busy = true;
  const idle: PanelWarmBatch[] = [["display"]];
  const Probe = () => { api = usePanelPaintWarmup(true, [], idle, () => busy); return null; };
  const advance = (ms: number) => dom.run(() => { vi.advanceTimersByTime(ms); });
  try {
    await dom.render(createElement(Probe));
    // Several quiet periods pass while a turn is in flight: nothing is drawn.
    await advance(PANEL_WARM_IDLE_DELAY_MS * 4);
    expect(api.warming("display")).toBe(false);
    busy = false;
    await advance(PANEL_WARM_IDLE_DELAY_MS);
    expect(api.warming("display")).toBe(true);
    await advance(2 * FRAME + panelWarmHold(idle[0]));
    expect(api.warming("display")).toBe(false);
  } finally {
    try { await dom.dispose(); } finally { vi.useRealTimers(); }
  }
});
