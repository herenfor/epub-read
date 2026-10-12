import { describe, expect, it } from "vitest";
import { SheetMotion, type SheetDriver, type SheetSettle } from "./sheetMotion";

/** Records every write; animations and layout commits complete only when the test says so. */
function fakeDriver(start = 0, collapsed = 200) {
  let offset = start;
  const log: string[] = [];
  const animations: Array<{ from: number; to: number; done: () => void }> = [];
  const layouts: Array<{ expanded: boolean; ready: (offset: number) => void }> = [];
  const driver: SheetDriver = {
    readOffset: () => offset,
    hold(next) { offset = next; log.push(`hold ${next}`); },
    animate(from, to, _kind: SheetSettle, done) { log.push(`animate ${from}→${to}`); animations.push({ from, to, done: () => { offset = to; done(); } }); },
    rest() { offset = 0; log.push("rest"); },
    collapsedOffset: () => collapsed,
    commitLayout(expanded, ready) { log.push(`layout ${expanded ? "expanded" : "collapsed"}`); layouts.push({ expanded, ready }); },
    dismiss(from) { log.push(`dismiss from ${from}`); },
    release() { log.push("release"); },
  };
  return { driver, log, animations, layouts, setOffset: (next: number) => { offset = next; } };
}

describe("sheet motion: one owner, every phase starts from the frame on screen", () => {
  it("release springs back or exits from where the finger let go, never from 0", () => {
    const f = fakeDriver();
    const motion = new SheetMotion(f.driver);
    let ticket = motion.begin();
    motion.move(ticket, 40);
    motion.settle(ticket, "stay");
    // Pinned at the released frame, then animated from it: no reset to 0 in between.
    expect(f.log.slice(1, -1)).toEqual(expect.arrayContaining(["hold 40"]));
    expect(f.log.slice(1)).not.toContain("hold 0");
    expect(f.log.at(-1)).toBe("animate 40→0");
    f.animations[0].done();
    expect(f.log.at(-1)).toBe("rest");

    f.log.length = 0;
    ticket = motion.begin();
    motion.move(ticket, 120);
    motion.settle(ticket, "dismiss");
    expect(f.log).toEqual(["hold 0", "hold 120", "hold 120", "dismiss from 120"]);
  });

  it("a new drag during a spring-back takes over its current frame; the old completion is void", () => {
    const f = fakeDriver();
    const motion = new SheetMotion(f.driver);
    const first = motion.begin();
    motion.move(first, 60);
    motion.settle(first, "stay");
    f.setOffset(25); // mid-animation frame
    const second = motion.begin();
    expect(f.log.at(-1)).toBe("hold 25");
    motion.move(second, -8);
    expect(f.log.at(-1)).toBe("hold 17");
    f.animations[0].done(); // the old spring finishing late
    expect(f.log).not.toContain("rest");
    motion.move(first, 99); // and the old gesture cannot move it
    expect(f.log.at(-1)).toBe("hold 17");
  });

  it("collapse moves on the tall layout first and commits the short one where the sheet already is", () => {
    const f = fakeDriver(0, 200);
    const motion = new SheetMotion(f.driver);
    const ticket = motion.begin();
    motion.move(ticket, 90);
    motion.settle(ticket, "collapse");
    expect(f.log.slice(-1)).toEqual(["animate 90→200"]);
    expect(f.layouts).toHaveLength(0);
    f.animations[0].done();
    expect(f.layouts).toEqual([expect.objectContaining({ expanded: false })]);
    f.layouts[0].ready(0); // committed layout already matches the visual top
    expect(f.log.at(-1)).toBe("rest");
  });

  it("expand commits the tall layout, then eases from the old visual top to rest", () => {
    const f = fakeDriver();
    const motion = new SheetMotion(f.driver);
    const ticket = motion.begin();
    motion.move(ticket, -15);
    motion.settle(ticket, "expand");
    expect(f.log.at(-1)).toBe("layout expanded");
    f.layouts[0].ready(255); // the new layout put the top 255px higher
    expect(f.log.slice(-2)).toEqual(["hold 255", "animate 255→0"]);
    f.animations[0].done();
    expect(f.log.at(-1)).toBe("rest");
  });

  it("a layout commit that lands after a new drag began does not move the sheet", () => {
    const f = fakeDriver();
    const motion = new SheetMotion(f.driver);
    const ticket = motion.begin();
    motion.settle(ticket, "expand");
    motion.begin();
    const before = [...f.log];
    f.layouts[0].ready(255);
    expect(f.log).toEqual(before);
  });

  it("interrupt returns a dragged sheet to rest from its frame, leaves a running dismiss alone; terminate voids everything", () => {
    const f = fakeDriver();
    const motion = new SheetMotion(f.driver);
    const ticket = motion.begin();
    motion.move(ticket, 30);
    motion.interrupt();
    expect(f.log.slice(-2)).toEqual(["hold 30", "animate 30→0"]);
    motion.settle(ticket, "dismiss"); // the cut-off gesture cannot settle afterwards
    expect(f.log).not.toContain("dismiss from 30");

    const exit = motion.begin();
    motion.move(exit, 100);
    motion.settle(exit, "dismiss");
    const count = f.log.length;
    motion.interrupt(); // closing disables the sheet: nothing to interrupt
    expect(f.log).toHaveLength(count);

    motion.terminate();
    f.animations[0].done();
    expect(f.log.at(-1)).toBe("release");
  });
});
