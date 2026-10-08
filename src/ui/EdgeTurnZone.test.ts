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
