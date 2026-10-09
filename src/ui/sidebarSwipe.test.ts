import { describe, expect, it, vi } from "vitest";
import { createSidebarNavigationMemory, SidebarSwipeMotion } from "./sidebarSwipe";

function setup(index = 0) {
  let position = index * 360;
  const completions: Array<() => void> = [];
  const onSelect = vi.fn();
  const stop = vi.fn();
  const driver = { read: () => position, stop, write: (next: number) => { position = next; },
    animate: (_next: number, done: () => void) => { completions.push(done); } };
  const motion = new SidebarSwipeMotion(driver, 360, index, onSelect);
  return { motion, driver, completions, onSelect, stop, position: () => position };
}

describe("sidebar swipe interruption", () => {
  it("new drag starts at the animated visual position, and stale finish cannot overwrite it", () => {
    const s = setup();
    s.motion.select(1);
    s.driver.write(120); // animation is only one third of the way across
    const gesture = s.motion.begin();
    s.motion.move(gesture, 30);
    s.completions[0]();
    expect(s.position()).toBe(90);
    s.motion.end(gesture, 100);
    expect(s.motion.index).toBe(0);
    s.completions[1]();
    expect(s.position()).toBe(0);
  });

  it("tab click invalidates a drag; its later touchend cannot commit another switch", () => {
    const s = setup();
    const gesture = s.motion.begin();
    s.motion.move(gesture, -120);
    s.motion.select(2);
    s.motion.move(gesture, 200);
    s.motion.end(gesture, 200);
    expect(s.motion.index).toBe(2);
    expect(s.onSelect).toHaveBeenCalledTimes(1);
    s.completions[0]();
    expect(s.position()).toBe(720);
  });

  it.each([0, 2])("outward drag at edge %s is bounded and rebounds to the same tab", index => {
    const s = setup(index);
    const dx = index === 0 ? 10000 : -10000;
    const gesture = s.motion.begin();
    s.motion.move(gesture, dx);
    expect(Math.abs(s.position() - index * 360)).toBeLessThan(360 * 0.16);
    expect(s.position()).not.toBe(index * 360);
    s.motion.end(gesture, dx);
    expect(s.motion.index).toBe(index);
    expect(s.onSelect).not.toHaveBeenCalled();
    s.completions[0]();
    expect(s.position()).toBe(index * 360);
  });

  it("drag out then back cancels the switch; a new gesture still works", () => {
    const s = setup(1);
    const first = s.motion.begin();
    s.motion.move(first, -160);
    s.motion.move(first, -5);
    s.motion.end(first, -5);
    expect(s.motion.index).toBe(1);
    const second = s.motion.begin();
    s.motion.move(second, -100);
    s.motion.end(second, -100);
    expect(s.motion.index).toBe(2);
    s.completions[0]();
    expect(s.position()).toBe(465);
    s.completions[1]();
    expect(s.position()).toBe(720);
  });

  it("cancel, resize and disposal invalidate pending motion without locking future input", () => {
    const s = setup(1);
    const first = s.motion.begin();
    s.motion.move(first, -170);
    s.motion.end(first, -170, true);
    expect(s.motion.index).toBe(1);
    s.motion.resize(400);
    s.completions[0]();
    expect(s.position()).toBe(400);
    s.motion.select(0);
    s.driver.write(180);
    s.motion.dispose();
    s.completions[1]();
    expect(s.position()).toBe(180);
  });

  it("two forward inputs during one animation advance twice; reverse interrupts immediately", () => {
    const s = setup();
    const first = s.motion.begin(); s.motion.move(first, -100); s.motion.end(first, -100);
    s.driver.write(70);
    const second = s.motion.begin(); s.motion.move(second, -100); s.motion.end(second, -100);
    expect(s.motion.index).toBe(2);
    s.driver.write(140);
    const third = s.motion.begin(); s.motion.move(third, 100); s.motion.end(third, 100);
    expect(s.motion.index).toBe(1);
    s.completions[0](); s.completions[1]();
    expect(s.position()).toBe(40);
    s.completions[2]();
    expect(s.position()).toBe(360);
  });

  it("an external tab update animates without echoing the user's command", () => {
    const s = setup();
    s.motion.select(2, false, false);
    expect(s.motion.index).toBe(2);
    expect(s.onSelect).not.toHaveBeenCalled();
    s.completions[0]();
    expect(s.position()).toBe(720);
  });

  it("each book and each pane own their offsets; UI memory has no portable save fields", () => {
    const a = createSidebarNavigationMemory(), b = createSidebarNavigationMemory();
    a.scrollTop.toc = 480;
    a.scrollTop.bookmarks = 140;
    expect(a.scrollTop.notes).toBeUndefined();
    expect(b.scrollTop).toEqual({});
    expect(a).toEqual({ scrollTop: { toc: 480, bookmarks: 140 } });
  });
});
