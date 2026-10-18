import { describe, expect, it } from "vitest";
import { imagePixelSize } from "./imageHeader";

const ascii = (s: string) => [...s].map(c => c.charCodeAt(0));
const little32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const little24 = (n: number) => little32(n).slice(0, 3);

function png(): Uint8Array {
  const bytes = new Uint8Array([0x89, ...ascii("PNG\r\n\x1a\n"), 0, 0, 0, 13, ...ascii("IHDR"), ...new Array(17).fill(0)]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 320); view.setUint32(20, 240);
  return bytes;
}

function jpeg(marker = 0xc0): Uint8Array {
  return new Uint8Array([0xff, 0xd8,
    0xff, 0xe1, 0, 4, 1, 2, // APP1, skipped without scanning its payload
    0xff, 0xc4, 0, 2, // DHT is not SOF
    0xff, marker, 0, 11, 8, 0, 240, 1, 64, 1, 1, 0x11, 0]);
}

function webp(type: string, payload: number[], prefix: number[] = []): Uint8Array {
  const chunk = [...ascii(type), ...little32(payload.length), ...payload, ...(payload.length % 2 ? [0] : [])];
  return new Uint8Array([...ascii("RIFF"), ...little32(4 + prefix.length + chunk.length), ...ascii("WEBP"), ...prefix, ...chunk]);
}

const headers: Array<[string, Uint8Array]> = [
  ["PNG", png()],
  ["JPEG", jpeg()],
  ["GIF87a", new Uint8Array([...ascii("GIF87a"), 64, 1, 240, 0, 0, 0, 0])],
  ["GIF89a", new Uint8Array([...ascii("GIF89a"), 64, 1, 240, 0, 0, 0, 0])],
  ["WebP VP8", webp("VP8 ", [0, 0, 0, 0x9d, 1, 0x2a, 64, 1, 240, 0])],
  ["WebP VP8L", webp("VP8L", [0x2f, ...little32(319 | (239 << 14))])],
  ["WebP VP8X", webp("VP8X", [0, 0, 0, 0, ...little24(319), ...little24(239)])],
];

describe("encoded image canvas header", () => {
  it.each(headers)("reads %s without decoding and rejects every truncated header", (_format, bytes) => {
    expect(imagePixelSize(bytes)).toEqual({ width: 320, height: 240 });
    for (let length = 0; length < bytes.length; length++) {
      expect(imagePixelSize(bytes.subarray(0, length))).toBeNull();
    }
    const padded = new Uint8Array(bytes.length + 10);
    padded.set(bytes, 5);
    expect(imagePixelSize(padded.subarray(5, 5 + bytes.length))).toEqual({ width: 320, height: 240 });
  });

  it.each([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])("recognizes JPEG SOF %i", marker => {
    expect(imagePixelSize(jpeg(marker))).toEqual({ width: 320, height: 240 });
  });

  it("skips odd-sized RIFF metadata with padding, and zero-length unknown chunks", () => {
    const prefix = [...ascii("JUNK"), ...little32(1), 99, 0, ...ascii("META"), ...little32(0)];
    expect(imagePixelSize(webp("VP8L", [0x2f, ...little32(319 | (239 << 14))], prefix))).toEqual({ width: 320, height: 240 });
  });

  it("returns null for bad lengths, dimensions, signatures and unsupported data", () => {
    const zeroPng = png(); zeroPng.fill(0, 16, 20);
    const badChunk = webp("JUNK", []); new DataView(badChunk.buffer).setUint32(16, 0xffffffff, true);
    const badRiff = webp("VP8X", new Array(10).fill(0)); new DataView(badRiff.buffer).setUint32(4, 0xffffffff, true);
    const badSof = jpeg(); badSof[14] = 0; badSof[15] = 0;
    for (const bytes of [
      zeroPng, badChunk, badRiff, badSof,
      new Uint8Array([0xff, 0xd8, 0xff, 0xff]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      new Uint8Array([...ascii("GIF89a"), 0, 0, 240, 0, 0, 0, 0]),
      webp("VP8 ", [0, 0, 0, 0, 0, 0, 64, 1, 240, 0]),
      webp("VP8L", [0, ...little32(319 | (239 << 14))]),
      new TextEncoder().encode("<svg width='320' height='240'/>")]) {
      expect(imagePixelSize(bytes)).toBeNull();
    }
  });
});
