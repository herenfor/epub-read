import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createReactDomHarness } from "../test/reactDomHarness";
import {
  nextPanelWarmBatch,
  PanelPaintWarmup,
  panelWarmHold,
  PANEL_WARM_IDLE_DELAY_MS,
  PANEL_WARM_IDLE_GAP_MS,
  usePanelPaintWarmup,
  type PanelWarmBatch,
  type PanelWarmStage,
} from "./panelPaintWarmup";

const FRAME = 16;

describe("panel paint warm-up", () => {
  it("holds a batch longer the more panels it draws", () => {
    expect(panelWarmHold(["fonts"])).toBe(150);
    expect(panelWarmHold(["aa", "toc", "search", "reading", "display", "more"])).toBe(300);
  });

  it("picks the first batch with a stage not yet drawn", () => {
    const batches: PanelWarmBatch[] = [["aa", "toc"], ["aa-detailed"]];
    expect(nextPanelWarmBatch(batches, new Set<PanelWarmStage>())).toEqual(["aa", "toc"]);
    expect(nextPanelWarmBatch(batches, new Set<PanelWarmStage>(["aa", "toc"]))).toEqual(["aa-detailed"]);
    expect(nextPanelWarmBatch(batches, new Set<PanelWarmStage>(["aa", "toc", "aa-detailed"]))).toBeNull();
  });

  it("draws veil batches back to back holding the veil, then idle batches on quiet reading, never twice in a run", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), FRAME) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    let api!: ReturnType<typeof usePanelPaintWarmup>;
    const veil: PanelWarmBatch[] = [["search"]];
    const idle: PanelWarmBatch[] = [["reading"], ["fonts"]];
    const Probe = (props: { ready: boolean }) => { api = usePanelPaintWarmup(props.ready, veil.map((b) => [...b]), idle.map((b) => [...b])); return null; };
    const advance = (ms: number) => dom.run(() => { vi.advanceTimersByTime(ms); });
    const drawn = () => (["search", "reading", "fonts"] as const).filter((s) => api.warming(s));
    const hold = (batch: PanelWarmBatch) => 2 * FRAME + panelWarmHold(batch);
    try {
      await dom.render(createElement(Probe, { ready: false }));
      expect(api.pending).toBe(false);

      // Veil batch: holds the veil and ignores reading input.
      await dom.render(createElement(Probe, { ready: true }));
      expect(drawn()).toEqual(["search"]);
      expect(api.pending).toBe(true);
      await dom.run(() => api.interrupt());
      expect(drawn()).toEqual(["search"]);
      // Not ready any more (a panel opened): the batch ends and the veil is not held.
      await dom.render(createElement(Probe, { ready: false }));
      expect(drawn()).toEqual([]);
      expect(api.pending).toBe(false);
      await dom.render(createElement(Probe, { ready: true }));
      await advance(hold(veil[0]));
      expect(drawn()).toEqual([]);
      expect(api.pending).toBe(false);

      // Idle batches wait for quiet reading (after the next tick); input mid-batch defers it.
      await advance(PANEL_WARM_IDLE_DELAY_MS + 1);
      expect(drawn()).toEqual(["reading"]);
      await dom.run(() => api.interrupt());
      expect(drawn()).toEqual([]);
      await advance(PANEL_WARM_IDLE_DELAY_MS - 1);
      expect(drawn()).toEqual([]);
      await advance(1);
      expect(drawn()).toEqual(["reading"]);
      await advance(hold(idle[0]));
      expect(drawn()).toEqual([]);
      await advance(PANEL_WARM_IDLE_GAP_MS);
      expect(drawn()).toEqual(["fonts"]);
      await advance(hold(idle[1]));
      expect(drawn()).toEqual([]);

      // Drawn batches are not drawn again in this run.
      await dom.render(createElement(Probe, { ready: false }));
      await dom.render(createElement(Probe, { ready: true }));
      await advance(5000);
      expect(drawn()).toEqual([]);
      expect(api.pending).toBe(false);
    } finally {
      await dom.dispose();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("hosts a warm-up instance inert and hidden from assistive tech, and adds nothing when inactive", async () => {
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(PanelPaintWarmup, { active: true, children: createElement("input", { id: "probe" }) }));
      const host = dom.container.querySelector(".panel-paint-warmup");
      expect(host?.hasAttribute("inert")).toBe(true);
      expect(host?.getAttribute("aria-hidden")).toBe("true");
      await dom.render(createElement(PanelPaintWarmup, { active: false, children: createElement("input", { id: "probe" }) }));
      expect(dom.container.querySelector(".panel-paint-warmup")).toBeNull();
      expect(dom.container.querySelector("#probe")?.parentElement).toBe(dom.container);
    } finally {
      await dom.dispose();
    }
  });
});
