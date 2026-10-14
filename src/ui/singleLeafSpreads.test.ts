import { describe, expect, it } from "vitest";
import type { Book } from "../core/types";
import { SingleLeafSpreads } from "./singleLeafSpreads";

/** kinds: "1" one-leaf chapter, "M" multi-leaf chapter, "x" linear="no". */
function fixture(kinds: string, cap?: number) {
  const book = { spine: [...kinds].map((kind) => ({ linear: kind !== "x" })) } as unknown as Book;
  const asked: number[] = [];
  const spreads = new SingleLeafSpreads(book, async (index) => {
    asked.push(index);
    return kinds[index] === "1";
  }, cap);
  return { spreads, asked, signal: new AbortController().signal };
}

describe("single-leaf chapter spreads (A13)", () => {
  it("pairs a run of one-leaf chapters the same way from any entry point", async () => {
    // 彩页×3、书名页、人物介绍 = 5 个一页章，然后正文。
    const { spreads, signal } = fixture("M11111M");
    const fromRight = await spreads.resolve(4, signal);
    expect(fromRight).toEqual({ left: 3, right: 4 });
    expect(await spreads.resolve(5, signal)).toEqual({ left: 5, right: null });
    expect(await spreads.resolve(2, signal)).toEqual({ left: 1, right: 2 });
    expect(await spreads.resolve(3, signal)).toBe(fromRight);
    expect(await spreads.resolve(6, signal)).toBeNull();
    expect(await spreads.resolve(0, signal)).toBeNull();
  });

  it("gives the same pairs when the run is entered from its end first", async () => {
    const a = fixture("M1111M");
    const b = fixture("M1111M");
    const forward = [];
    for (const i of [1, 2, 3, 4]) forward.push(await a.spreads.resolve(i, a.signal));
    const backward = [];
    for (const i of [4, 3, 2, 1]) backward.push(await b.spreads.resolve(i, b.signal));
    expect(backward.reverse()).toEqual(forward);
  });

  it("skips linear=no chapters without changing parity", async () => {
    const { spreads, signal } = fixture("1x11M");
    expect(await spreads.resolve(2, signal)).toEqual({ left: 0, right: 2 });
    expect(await spreads.resolve(3, signal)).toEqual({ left: 3, right: null });
    expect(await spreads.resolve(1, signal)).toBeNull();
  });

  it("starts a run at every cap-th linear chapter so long runs stay bounded and stable", async () => {
    const { spreads, asked, signal } = fixture("1111111", 3);
    // ordinals 0,3,6 force run starts: [0,1][2] [3,4][5] [6]
    expect(await spreads.resolve(5, signal)).toEqual({ left: 5, right: null });
    expect(Math.min(...asked)).toBe(3); // never walked past the forced start
    expect(await spreads.resolve(4, signal)).toEqual({ left: 3, right: 4 });
    expect(await spreads.resolve(2, signal)).toEqual({ left: 2, right: null });
    expect(await spreads.resolve(1, signal)).toEqual({ left: 0, right: 1 });
    expect(await spreads.resolve(6, signal)).toEqual({ left: 6, right: null });
  });

  it("asks the classifier once per chapter and lets a rejected pair fall back to single chapters", async () => {
    const { spreads, asked, signal } = fixture("11M");
    const pair = await spreads.resolve(1, signal);
    expect(pair).toEqual({ left: 0, right: 1 });
    await spreads.resolve(0, signal);
    expect(asked.filter((i) => i === 0).length).toBe(1);
    spreads.reject(pair!);
    expect(await spreads.resolve(0, signal)).toBeNull();
    expect(await spreads.resolve(1, signal)).toBeNull();
  });

  it("does not cache a classification that was cancelled", async () => {
    const book = { spine: [{ linear: true }, { linear: true }] } as unknown as Book;
    const controller = new AbortController();
    let calls = 0;
    const spreads = new SingleLeafSpreads(book, async () => {
      calls++;
      controller.abort();
      return true;
    });
    await expect(spreads.resolve(1, controller.signal)).rejects.toThrow();
    expect(await spreads.resolve(1, new AbortController().signal)).toEqual({ left: 0, right: 1 });
    expect(calls).toBe(3);
  });
  it("retries a rejected pair after the layout changes, keeping the same pairing", async () => {
    const { spreads, signal } = fixture("M1111M");
    const pair = await spreads.resolve(3, signal);
    expect(pair).toEqual({ left: 3, right: 4 });
    spreads.reject(pair!);
    expect(await spreads.resolve(4, signal)).toBeNull();
    expect(await spreads.resolve(1, signal)).toEqual({ left: 1, right: 2 });
    spreads.retryRejected();
    expect(await spreads.resolve(4, signal)).toEqual({ left: 3, right: 4 });
  });
});
