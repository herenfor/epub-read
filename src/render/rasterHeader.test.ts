import { expect, it } from "vitest";
import { rasterHeaderPixels } from "./rasterHeader";

it("reads the pixel count of a JPEG with an APP segment and a progressive frame", () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0,
    0xff, 0xc2, 0, 8, 8, 0x0f, 0, 8, 0x70, 1,
  ]);
  expect(rasterHeaderPixels(jpeg)).toBe(2160 * 3840);
  expect(rasterHeaderPixels(jpeg.subarray(0, -1))).toBeUndefined();
});

it("reads the PNG IHDR dimensions without allocating pixel storage", () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0xa0, 0, 0, 10, 0,
  ]);
  expect(rasterHeaderPixels(png)).toBe(1440 * 2560);
});
