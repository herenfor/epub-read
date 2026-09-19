import { describe, expect, it } from "vitest";
import {
  buildExactTextHits,
  resolveExactTextHit,
  resolveExactTextHits,
} from "./exactTextHits";

describe("exact text hit mapping", () => {
  it("maps raw UTF-16 ranges to non-whitespace Unicode code points", () => {
    const source = "a\u0000\t😀b";
    const hits = buildExactTextHits(source, [
      { start: 0, end: 1 },
      { start: 3, end: 5 },
    ]);
    expect(hits).toEqual([
      { start: 0, end: 1, exactText: "a" },
      { start: 1, end: 2, exactText: "😀" },
    ]);
  });

  it("rejects half surrogate pairs and empty ranges", () => {
    expect(buildExactTextHits("a😀", [{ start: 1, end: 3 }])).toEqual([
      { start: 1, end: 2, exactText: "😀" },
    ]);
    expect(buildExactTextHits("a😀", [{ start: 1, end: 2 }])).toBeNull();
    expect(buildExactTextHits("a😀", [{ start: 1, end: 1 }])).toBeNull();
  });

  it("resolves all keyword ranges with one relocation delta", () => {
    const hits = buildExactTextHits("A B", [
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
    expect(hits).not.toBeNull();
    expect(resolveExactTextHits(["x", "A", "B", "y"], hits!)).toEqual([
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
  });

  it("allows duplicate and overlapping keyword ranges when every original range validates", () => {
    const hits = buildExactTextHits("星美君", [
      { start: 0, end: 1 },
      { start: 0, end: 3 },
    ]);
    expect(hits).not.toBeNull();
    expect(resolveExactTextHits(["星", "美", "君"], hits!)).toEqual([
      { start: 0, end: 1 },
      { start: 0, end: 3 },
    ]);
    const duplicate = buildExactTextHits("星美", [
      { start: 0, end: 1 },
      { start: 0, end: 1 },
    ]);
    expect(resolveExactTextHits(["星", "美"], duplicate!)).toEqual([
      { start: 0, end: 1 },
      { start: 0, end: 1 },
    ]);
  });

  it("returns null instead of moving keywords independently", () => {
    const hits = buildExactTextHits("A B", [
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
    expect(resolveExactTextHits(["A", "x", "B"], hits!)).toBeNull();
  });

  it("uses bounded KMP only for a unique nearest complete match", () => {
    const hit = buildExactTextHits("needle", [{ start: 0, end: 6 }])![0];
    expect(resolveExactTextHit(["x", "n", "e", "e", "d", "l", "e", "y"], hit, 32))
      .toEqual({ start: 1, end: 7 });
    // A fake one-point hit whose exact position is absent and whose two
    // nearest candidates are equidistant must not be guessed.
    expect(resolveExactTextHit(["n", "x", "n"], { start: 1, end: 2, exactText: "n" }, 32)).toBeNull();
  });
});
