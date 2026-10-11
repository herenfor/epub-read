import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { EdgeTurnZone } from "./EdgeTurnZone";
import { EdgeTurnFeedbackContext, useEdgeTurnFeedbackOwner } from "./edgeTurnFeedback";

function FeedbackOwner({ hostKey, shown = true }: { hostKey: string; shown?: boolean }) {
  const feedback = useEdgeTurnFeedbackOwner();
  return createElement(EdgeTurnFeedbackContext.Provider, { value: feedback }, shown
    ? createElement(EdgeTurnZone, { key: hostKey, direction: 1, onTurn: () => {} })
    : null);
}

describe("edge turn feedback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds through repeated clicks until 400ms after the last click", async () => {
    const dom = createReactDomHarness();
    const turn = vi.fn();
    try {
      await dom.render(createElement(EdgeTurnZone, { direction: 1, onTurn: turn }));
      const zone = dom.container.firstElementChild!;
      for (let i = 0; i < 3; i++) {
        await dom.click(zone);
        await dom.run(() => { vi.advanceTimersByTime(300); });
        expect(zone.classList.contains("is-holding")).toBe(true);
      }
      await dom.run(() => { vi.advanceTimersByTime(99); });
      expect(zone.classList.contains("is-holding")).toBe(true);
      await dom.run(() => { vi.advanceTimersByTime(1); });
      expect(zone.classList.contains("is-holding")).toBe(false);
      expect(turn).toHaveBeenCalledTimes(3);
    } finally { await dom.dispose(); }
  });

  it("interrupts fading and accepts fully hidden clicks without blocking turns", async () => {
    const dom = createReactDomHarness();
    const turn = vi.fn();
    try {
      await dom.render(createElement(EdgeTurnZone, { direction: -1, onTurn: turn }));
      const zone = dom.container.firstElementChild!;
      await dom.click(zone);
      await dom.run(() => { vi.advanceTimersByTime(550); });
      expect(zone.classList.contains("is-holding")).toBe(false);
      await dom.click(zone);
      expect(zone.classList.contains("is-holding")).toBe(true);
      await dom.run(() => { vi.advanceTimersByTime(399); });
      expect(zone.classList.contains("is-holding")).toBe(true);
      await dom.run(() => { vi.advanceTimersByTime(1000); });
      await dom.click(zone);
      expect(zone.classList.contains("is-holding")).toBe(true);
      expect(turn).toHaveBeenCalledTimes(3);
    } finally { await dom.dispose(); }
  });

  it("pointer preparation does not show feedback; only click submits one turn", async () => {
    const dom = createReactDomHarness();
    const prepare = vi.fn();
    const turn = vi.fn();
    const outerClick = vi.fn();
    try {
      await dom.render(createElement("div", { onClick: outerClick },
        createElement(EdgeTurnZone, { direction: 1, onPrepare: prepare, onTurn: turn })));
      const zone = dom.container.querySelector(".edge-turn-zone")!;
      await dom.dispatch(zone, new window.Event("pointerdown", { bubbles: true }));
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(turn).not.toHaveBeenCalled();
      expect(zone.classList.contains("is-holding")).toBe(false);
      await dom.run(() => { vi.advanceTimersByTime(500); });
      expect(zone.classList.contains("is-holding")).toBe(false);
      await dom.click(zone);
      expect(zone.classList.contains("is-holding")).toBe(true);
      expect(turn).toHaveBeenCalledTimes(1);
      expect(outerClick).not.toHaveBeenCalled();
    } finally { await dom.dispose(); }
  });

  it("clears the pending exit on unmount", async () => {
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(EdgeTurnZone, { direction: 1, onTurn: () => {} }));
      await dom.click(dom.container.firstElementChild!);
      expect(vi.getTimerCount()).toBe(1);
      await dom.render(null);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await dom.dispose(); }
  });

  it("retains the timer when a host disappears but clears it with the owner", async () => {
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(FeedbackOwner, { hostKey: "a" }));
      await dom.click(dom.container.firstElementChild!);
      await dom.render(createElement(FeedbackOwner, { hostKey: "a", shown: false }));
      expect(vi.getTimerCount()).toBe(1);
      await dom.render(null);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await dom.dispose(); }
  });

  it("keeps the original deadline across a host gap and keyed replacement", async () => {
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(FeedbackOwner, { hostKey: "a" }));
      await dom.click(dom.container.firstElementChild!);
      await dom.run(() => { vi.advanceTimersByTime(200); });
      await dom.render(createElement(FeedbackOwner, { hostKey: "a", shown: false }));
      await dom.run(() => { vi.advanceTimersByTime(100); });
      await dom.render(createElement(FeedbackOwner, { hostKey: "b" }));
      const zone = dom.container.firstElementChild!;
      expect(zone.classList.contains("is-holding")).toBe(true);
      await dom.run(() => { vi.advanceTimersByTime(99); });
      expect(zone.classList.contains("is-holding")).toBe(true);
      await dom.run(() => { vi.advanceTimersByTime(1); });
      expect(zone.classList.contains("is-holding")).toBe(false);
    } finally { await dom.dispose(); }
  });

  it("keeps the original markup for calls without a side or region", async () => {
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(EdgeTurnZone, { direction: 1, onTurn: () => {} }));
      const zone = dom.container.firstElementChild!;
      expect(zone.getAttribute("class")).toBe("edge-turn-zone edge-turn-next");
      expect(zone.getAttribute("style")).toBeNull();
      expect(zone.hasAttribute("data-edge-side")).toBe(false);
    } finally { await dom.dispose(); }
  });

  it("left band turning forward keeps its side and feedback, while label and arrow show the action", async () => {
    const dom = createReactDomHarness();
    const turn = vi.fn();
    function Bands() {
      const feedback = useEdgeTurnFeedbackOwner();
      return createElement(EdgeTurnFeedbackContext.Provider, { value: feedback },
        createElement(EdgeTurnZone, { side: "left", direction: 1, onTurn: turn, region: { width: 140, arrowCenter: 22 } }),
        createElement(EdgeTurnZone, { side: "right", direction: 1, onTurn: turn, region: { width: 0, arrowCenter: 0 } }),
        createElement(EdgeTurnZone, { side: "right", direction: 1, onTurn: turn }));
    }
    try {
      await dom.render(createElement(Bands));
      const zones = [...dom.container.querySelectorAll(".edge-turn-zone")];
      // Width 0 turns the band off entirely.
      expect(zones).toHaveLength(2);
      const [left, right] = zones;
      expect(left.classList.contains("edge-turn-left")).toBe(true);
      expect(left.classList.contains("edge-turn-next")).toBe(false);
      expect(left.classList.contains("edge-turn-prev")).toBe(false);
      expect(left.getAttribute("data-edge-action")).toBe("next");
      expect(left.getAttribute("title")).toBe("下一页");
      expect(left.querySelector("polyline")?.getAttribute("points")).toBe("9 18 15 12 9 6");
      expect((left as HTMLElement).style.width).toBe("140px");
      expect((left as HTMLElement).style.getPropertyValue("--edge-turn-arrow-center")).toBe("22px");
      expect(right.getAttribute("class")).toBe("edge-turn-zone edge-turn-next edge-turn-right");

      await dom.click(left);
      expect(turn).toHaveBeenCalledWith(1);
      expect(left.classList.contains("is-holding")).toBe(true);
      expect(right.classList.contains("is-holding")).toBe(false);
      await dom.run(() => { vi.advanceTimersByTime(400); });
      expect(left.classList.contains("is-holding")).toBe(false);
    } finally { await dom.dispose(); }
  });

  it("does not reveal the arrow when the mouse passes through the edge", async () => {
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(EdgeTurnZone, { direction: 1, onTurn: () => {} }));
      const zone = dom.container.firstElementChild!;
      // React synthesizes pointerenter from bubbling pointerover.
      await dom.dispatch(zone, Object.assign(new window.Event("pointerover", { bubbles: true }), {
        pointerType: "mouse", relatedTarget: null,
      }));
      expect(zone.classList.contains("is-holding")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await dom.dispose(); }
  });
});
