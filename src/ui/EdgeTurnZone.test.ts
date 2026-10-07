import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { EdgeTurnZone } from "./EdgeTurnZone";

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

  it("pointer preparation gives feedback but only click submits one turn", async () => {
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
      expect(zone.classList.contains("is-holding")).toBe(true);
      await dom.click(zone);
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
});
