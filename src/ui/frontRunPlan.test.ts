import { describe, expect, it, vi } from "vitest";
import type { Book } from "../core/types";
import { planFrontRun, type FrontRunInput } from "./frontRunPlan";
import type { SingleLeafSpread } from "./singleLeafSpreads";

function frontMatter(): FrontRunInput {
  const pairs = new Map<number, SingleLeafSpread | null>();
  for (const left of [0, 2, 4, 6]) {
    const spread = { left, right: left + 1 };
    pairs.set(left, spread); pairs.set(left + 1, spread);
  }
  for (const chapter of [8, 9, 10, 11]) pairs.set(chapter, null);
  const leaves = new Map([[8, 2], [9, 1], [10, 3], [11, 20]]);
  return {
    book: { spine: Array.from({ length: 12 }, (_, index) => ({ idref: String(index), linear: true })) } as Book,
    current: 0, direction: 1, peek: i => pairs.get(i),
    isLeafCandidate: i => i === 9, knownLeaves: i => leaves.get(i),
    imageBytes: i => i < 8 ? 20 : 0,
    budget: { maxScreens: 10, maxBytes: 1024 },
  };
}

describe("front-matter preparation plan", () => {
  it("prepares four pairs, rejected TOC, one-leaf character page and the body entry", () => {
    const input = frontMatter();
    const peek = vi.spyOn(input, "peek");
    const plan = planFrontRun(input);
    expect(plan.units.map(u => u.key)).toEqual(["pair:0:1", "pair:2:3", "pair:4:5", "pair:6:7", "paged:8", "paged:9", "paged:10"]);
    expect(plan.units.map(u => u.estimatedBytes)).toEqual([40, 40, 40, 40, 0, 0, 0]);
    expect(plan.units.every(u => u.edge === "start")).toBe(true);
    expect(plan.units[0]).toMatchObject({ spineIndex: 0, chapters: [0, 1], kind: "pair" });
    expect(plan).toMatchObject({ complete: true, waitingFor: null });
    expect(peek).not.toHaveBeenCalledWith(11);
    expect(planFrontRun(input)).toEqual(plan);
  });

  it("looks backwards from the body start through the entire short run, then adds the opposite entry", () => {
    const input = { ...frontMatter(), current: 10, direction: -1 as const };
    const plan = planFrontRun(input);
    expect(plan.units.map(u => u.key)).toEqual(["paged:10", "paged:9", "paged:8", "pair:6:7", "pair:4:5", "pair:2:3", "pair:0:1", "paged:11"]);
    expect(plan.units.slice(0, -1).every(u => u.edge === "end")).toBe(true);
    expect(plan.units.at(-1)?.edge).toBe("start");
    expect(plan).toMatchObject({ complete: true, waitingFor: null });
  });

  it.each(["pair", "candidate", "measurement"])("stops at an unknown %s instead of guessing", (unknown) => {
    const input = { ...frontMatter(), current: 6 };
    if (unknown === "pair") { const peek = input.peek; input.peek = i => i === 8 ? undefined : peek(i); }
    if (unknown === "candidate") input.isLeafCandidate = () => undefined;
    if (unknown === "measurement") input.knownLeaves = () => undefined;
    const plan = planFrontRun(input);
    expect(plan).toMatchObject({ complete: false, waitingFor: 8 });
    expect(plan.units.map(u => u.key)).toEqual(["pair:6:7"]);
  });

  it.each([
    { maxScreens: 1, maxBytes: 1024 },
    { maxScreens: 10, maxBytes: 30 },
    { maxScreens: 0, maxBytes: 0 },
  ])("always retains current and next with budget $maxScreens/$maxBytes", budget => {
    const plan = planFrontRun({ ...frontMatter(), budget });
    expect(plan.units.map(u => u.key)).toEqual(["pair:0:1", "pair:2:3"]);
    expect(plan).toMatchObject({ complete: false, waitingFor: null });
  });

  it("accepts exact byte bounds, permits zero-byte entries and budgets the opposite screen last", () => {
    const input = { ...frontMatter(), current: 8, budget: { maxScreens: 4, maxBytes: 40 } };
    const plan = planFrontRun(input);
    expect(plan.units.map(u => u.key)).toEqual(["paged:8", "paged:9", "paged:10", "pair:6:7"]);
    expect(plan.complete).toBe(true);
    expect(planFrontRun({ ...input, budget: { maxScreens: 3, maxBytes: 0 } }).units.map(u => u.key)).toEqual(["paged:8", "paged:9", "paged:10"]);
  });

  it("uses known length over the candidate hint and never substitutes an unknown opposite neighbour", () => {
    const short = { ...frontMatter(), current: 8 };
    const known = short.knownLeaves;
    short.knownLeaves = i => i === 9 ? undefined : known(i);
    expect(planFrontRun(short).units.map(u => u.key)).toEqual(["paged:8", "paged:9", "paged:10", "pair:6:7"]);
    const input = { ...frontMatter(), current: 8 };
    input.isLeafCandidate = () => true;
    input.knownLeaves = i => i === 9 ? 4 : 2;
    const plan = planFrontRun(input);
    expect(plan.units.map(u => u.key)).toEqual(["paged:8", "paged:9", "pair:6:7"]);
    expect(plan.complete).toBe(true);
    const peek = input.peek;
    input.peek = i => i === 7 ? undefined : peek(i);
    expect(planFrontRun(input)).toMatchObject({ complete: false, waitingFor: 7 });
  });

  it("skips linear=no entries, including a current non-linear entry, and deduplicates a current right leaf", () => {
    const input = frontMatter();
    input.book.spine[8].linear = false;
    input.current = 7;
    const plan = planFrontRun(input);
    expect(plan.units.map(u => u.key)).toEqual(["pair:6:7", "paged:9", "paged:10", "pair:4:5"]);
    expect(plan.units[0].spineIndex).toBe(6);
    input.current = 8;
    expect(planFrontRun(input).units.map(u => u.key)).toEqual(["paged:9", "paged:10", "pair:6:7"]);
    expect(planFrontRun({ ...input, book: { spine: [] } as unknown as Book, current: -1 })).toEqual({ units: [], complete: true, waitingFor: null });
  });
});
