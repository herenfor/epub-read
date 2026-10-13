import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createReactDomHarness } from "../test/reactDomHarness";
import {
  nextPanelWarmStage,
  PanelPaintWarmup,
  PANEL_WARM_DELAY_MS,
  PANEL_WARM_HOLD_MS,
  usePanelPaintWarmup,
  type PanelWarmStage,
} from "./panelPaintWarmup";

const FRAME = 16;

describe("panel paint warm-up", () => {
  it("picks the first stage not yet drawn", () => {
    expect(nextPanelWarmStage(["aa", "toc"], new Set<PanelWarmStage>())).toBe("aa");
    expect(nextPanelWarmStage(["aa", "toc"], new Set<PanelWarmStage>(["aa"]))).toBe("toc");
    expect(nextPanelWarmStage(["aa", "toc"], new Set<PanelWarmStage>(["aa", "toc"]))).toBeNull();
  });

  it("draws one stage at a time while idle, restarts an interrupted stage, and never repeats a finished one", async () => {
    vi.useFakeTimers();
    const dom = createReactDomHarness();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), FRAME) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    let api!: ReturnType<typeof usePanelPaintWarmup>;
    const stages: PanelWarmStage[] = ["display", "fonts"];
    const Probe = (props: { ready: boolean }) => { api = usePanelPaintWarmup(props.ready, [...stages]); return null; };
    const advance = (ms: number) => dom.run(() => { vi.advanceTimersByTime(ms); });
    try {
      await dom.render(createElement(Probe, { ready: true }));
      expect(api.stage).toBeNull();
      await advance(PANEL_WARM_DELAY_MS);
      expect(api.stage).toBe("display");

      // Reading input mid-stage: the stage ends unfinished and waits for quiet again.
      await dom.run(() => api.interrupt());
      expect(api.stage).toBeNull();
      await advance(PANEL_WARM_DELAY_MS - 1);
      expect(api.stage).toBeNull();
      await advance(1);
      expect(api.stage).toBe("display");

      await advance(2 * FRAME + PANEL_WARM_HOLD_MS);
      expect(api.stage).toBeNull();
      await advance(PANEL_WARM_DELAY_MS);
      expect(api.stage).toBe("fonts");

      // Leaving the idle state (a panel opens) ends the stage too.
      await dom.render(createElement(Probe, { ready: false }));
      expect(api.stage).toBeNull();
      await advance(10 * PANEL_WARM_DELAY_MS);
      expect(api.stage).toBeNull();

      await dom.render(createElement(Probe, { ready: true }));
      await advance(PANEL_WARM_DELAY_MS);
      expect(api.stage).toBe("fonts");
      await advance(2 * FRAME + PANEL_WARM_HOLD_MS);
      expect(api.stage).toBeNull();

      // Drawn stages are not drawn again in this run.
      await advance(10 * PANEL_WARM_DELAY_MS);
      expect(api.stage).toBeNull();
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
