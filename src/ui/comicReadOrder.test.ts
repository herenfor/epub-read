import { describe, expect, it } from "vitest";
import { comicDecodeOrder, comicReadOrder } from "./comicReadOrder";

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

it("decodes both visible 4K pages and leaves their neighbours encoded on Android", () => {
  const pixels = 2160 * 3840;
  expect(comicDecodeOrder([3, 4, 5, 6, 1, 2], new Set([3, 4]), () => pixels, 18_000_000))
    .toEqual([3, 4]);
  expect(comicDecodeOrder([3, 4, 5, 6], new Set([3, 4, 5, 6]), () => pixels, 18_000_000))
    .toEqual([3, 4, 5, 6]);
});

it("keeps directional predecode for small pages and defers unknown image sizes", () => {
  const pixels = (page: number) => page === 5 ? undefined : 1440 * 2560;
  expect(comicDecodeOrder([3, 4, 1, 2, 5], new Set([3, 4]), pixels, 18_000_000))
    .toEqual([3, 4, 1, 2]);
  expect(comicDecodeOrder([3, 5, 1], new Set([3, 5]), pixels, 18_000_000))
    .toEqual([3, 5]);
});
