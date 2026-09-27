import { describe, expect, it } from "vitest";
import { captureSearchOccurrence, resolveSearchOccurrence } from "./searchOccurrence";

describe("search occurrence disambiguation", () => {
  it("accepts the exact coordinates only when the whole context still matches", () => {
    const source = ["甲", "星", "君", "乙", "丙"];
    const hit = { start: 1, end: 3, exactText: "星君" };
    const occurrence = captureSearchOccurrence(source, [hit]);
    expect(occurrence).toEqual({
      hits: [hit],
      before: "甲",
      after: "乙丙",
    });
    expect(resolveSearchOccurrence(source, occurrence!)).toEqual([{ start: 1, end: 3 }]);

    const overlapping = captureSearchOccurrence(source, [
      { start: 1, end: 2, exactText: "星" },
      hit,
    ]);
    expect(resolveSearchOccurrence(source, overlapping!)).toEqual([
      { start: 1, end: 2 },
      { start: 1, end: 3 },
    ]);

    const drifted = ["前", "甲", "星", "君", "乙", "丙"];
    expect(resolveSearchOccurrence(drifted, occurrence!)).toEqual([{ start: 2, end: 4 }]);
  });

  it("returns unresolved for repeated context instead of selecting the nearest same word", () => {
    const source = ["甲", "星", "君", "乙"];
    const occurrence = captureSearchOccurrence(source, [{ start: 1, end: 3, exactText: "星君" }]);
    expect(occurrence).not.toBeNull();
    const repeated = ["x", "甲", "星", "君", "乙", "y", "甲", "星", "君", "乙"];
    expect(resolveSearchOccurrence(repeated, occurrence!)).toBeNull();
  });
});
