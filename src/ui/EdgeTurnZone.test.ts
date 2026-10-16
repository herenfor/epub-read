import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { EdgeTurnZone } from "./EdgeTurnZone";
import { EdgeTurnFeedback, EdgeTurnFeedbackContext } from "./edgeTurnFeedback";

// The bands only draw feedback; taps are routed by plainTap / the host blank
// handler, which call feedback.hold. These tests drive the shared feedback.
function withFeedback(feedback: EdgeTurnFeedback, ...zones: ReturnType<typeof createElement>[]) {
  return createElement(EdgeTurnFeedbackContext.Provider, { value: feedback }, ...zones);
}

describe("edge turn feedback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds through repeated taps until 400ms after the last one", async () => {
    const dom = createReactDomHarness();
    const feedback = new EdgeTurnFeedback();
    try {
      await dom.render(withFeedback(feedback, createElement(EdgeTurnZone, { direction: 1 })));
      const zone = dom.container.firstElementChild!;
      for (let i = 0; i < 3; i++) {
        await dom.run(() => feedback.hold(1));
        await dom.run(() => { vi.advanceTimersByTime(300); });
        expect(zone.classList.contains("is-holding")).toBe(true);
      }
      await dom.run(() => { vi.advanceTimersByTime(99); });
      expect(zone.classList.contains("is-holding")).toBe(true);
      await dom.run(() => { vi.advanceTimersByTime(1); });
      expect(zone.classList.contains("is-holding")).toBe(false);
    } finally { feedback.dispose(); await dom.dispose(); }
  });

  it("keeps the original deadline across a host gap and keyed replacement", async () => {
    const dom = createReactDomHarness();
    const feedback = new EdgeTurnFeedback();
    try {
      await dom.render(withFeedback(feedback, createElement(EdgeTurnZone, { key: "a", direction: 1 })));
      await dom.run(() => feedback.hold(1));
      await dom.run(() => { vi.advanceTimersByTime(200); });
      await dom.render(withFeedback(feedback));
      await dom.run(() => { vi.advanceTimersByTime(100); });
      await dom.render(withFeedback(feedback, createElement(EdgeTurnZone, { key: "b", direction: 1 })));
      const zone = dom.container.firstElementChild!;
      expect(zone.classList.contains("is-holding")).toBe(true);
      await dom.run(() => { vi.advanceTimersByTime(99); });
      expect(zone.classList.contains("is-holding")).toBe(true);
      await dom.run(() => { vi.advanceTimersByTime(1); });
      expect(zone.classList.contains("is-holding")).toBe(false);
      feedback.hold(1);
      feedback.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { feedback.dispose(); await dom.dispose(); }
  });

  it("is visual only: hidden from assistive tech and no button inside", async () => {
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(EdgeTurnZone, { direction: 1 }));
      const zone = dom.container.firstElementChild!;
      expect(zone.getAttribute("class")).toBe("edge-turn-zone edge-turn-next");
      expect(zone.getAttribute("aria-hidden")).toBe("true");
      expect(zone.getAttribute("style")).toBeNull();
      expect(zone.hasAttribute("data-edge-side")).toBe(false);
      expect(zone.querySelector("button")).toBeNull();
      expect(zone.querySelector(".edge-turn-arrow")).not.toBeNull();
    } finally { await dom.dispose(); }
  });

  it("left band turning forward keeps its side and feedback, while the action is marked on the band", async () => {
    const dom = createReactDomHarness();
    const feedback = new EdgeTurnFeedback();
    try {
      await dom.render(withFeedback(feedback,
        createElement(EdgeTurnZone, { key: "l", side: "left", direction: 1, region: { width: 140, arrowCenter: 22 } }),
        createElement(EdgeTurnZone, { key: "r0", side: "right", direction: 1, region: { width: 0, arrowCenter: 0 } }),
        createElement(EdgeTurnZone, { key: "r", side: "right", direction: 1 })));
      const zones = [...dom.container.querySelectorAll(".edge-turn-zone")];
      // Width 0 turns the band off entirely.
      expect(zones).toHaveLength(2);
      const [left, right] = zones;
      expect(left.classList.contains("edge-turn-left")).toBe(true);
      expect(left.classList.contains("edge-turn-next")).toBe(false);
      expect(left.classList.contains("edge-turn-prev")).toBe(false);
      expect(left.getAttribute("data-edge-action")).toBe("next");
      // A forward band on the left still points left: the glyph marks the edge, not the action.
      expect(left.querySelector("polyline")?.getAttribute("points")).toBe("15 18 9 12 15 6");
      expect((left as HTMLElement).style.width).toBe("140px");
      expect((left as HTMLElement).style.getPropertyValue("--edge-turn-arrow-center")).toBe("22px");
      expect(right.getAttribute("class")).toBe("edge-turn-zone edge-turn-next edge-turn-right");

      // Feedback belongs to the physical side that was tapped.
      await dom.run(() => feedback.hold(-1));
      expect(left.classList.contains("is-holding")).toBe(true);
      expect(right.classList.contains("is-holding")).toBe(false);
      await dom.run(() => { vi.advanceTimersByTime(400); });
      expect(left.classList.contains("is-holding")).toBe(false);
    } finally { feedback.dispose(); await dom.dispose(); }
  });
});
