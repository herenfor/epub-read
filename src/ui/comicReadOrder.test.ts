import { describe, expect, it } from "vitest";
import { comicReadOrder } from "./comicReadOrder";

const spreads = [[0], [1, 2], [3, 4], [5], [6, 7]];
const spreadOf = [0, 1, 1, 2, 2, 3, 4, 4];
const singles = Array.from({ length: 8 }, (_, i) => [i]);
const singleOf = singles.map((_, i) => i);

describe("comic read order", () => {
  it("reads both pages of the visible spread first, then the heading side", () => {
    expect(comicReadOrder(spreads, spreadOf, [3], 3, 1)).toEqual({ urgent: [3, 4], order: [3, 4, 5, 1, 2] });
    expect(comicReadOrder(spreads, spreadOf, [3], 3, -1)).toEqual({ urgent: [3, 4], order: [3, 4, 1, 2, 5] });
  });

  it("keeps a far goal urgent while passing through other screens", () => {
    expect(comicReadOrder(spreads, spreadOf, [1], 6, 1).urgent).toEqual([1, 2, 6, 7]);
  });

  it("covers every page on screen in scroll mode and stops at the ends", () => {
    expect(comicReadOrder(singles, singleOf, [6, 7], 6, 1)).toEqual({ urgent: [6, 7], order: [6, 7, 5] });
    expect(comicReadOrder(singles, singleOf, [0], 0, -1)).toEqual({ urgent: [0], order: [0, 1] });
  });
});
