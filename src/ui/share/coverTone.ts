import { parseHex } from "./shareCardModel";

/**
 * The background for the "cover tone" card: the cover's most common colour,
 * kept restrained (saturation capped) and darkened until the card's light
 * text reads comfortably on it.
 */

const CARD_TEXT = "#f4f0e7";
/** Contrast the light text needs on the tone. */
const MIN_CONTRAST = 6;
const MAX_SATURATION = 0.42;

/** Picks the tone from RGBA pixels (e.g. a small canvas copy of the cover). */
export function coverToneFromPixels(data: ArrayLike<number>): string | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    // Paper white and pure black say nothing about a cover's colour.
    if (max > 238 && max - min < 18) continue;
    if (max < 18) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++; bucket.r += r; bucket.g += g; bucket.b += b;
    buckets.set(key, bucket);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) if (!best || bucket.n > best.n) best = bucket;
  if (!best) return null;
  return readableTone([best.r / best.n, best.g / best.n, best.b / best.n]);
}

/** Samples a loaded cover image; null when it cannot be read (e.g. tainted). */
export function coverToneFromImage(image: CanvasImageSource, doc: Document = document): string | null {
  try {
    const canvas = doc.createElement("canvas");
    canvas.width = 32;
    canvas.height = 48;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return coverToneFromPixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    return null;
  }
}

/** Caps saturation and darkens the colour until CARD_TEXT reaches MIN_CONTRAST on it. */
export function readableTone(rgb: [number, number, number]): string {
  const [h, s, l] = rgbToHsl(rgb);
  let lightness = Math.min(l, 0.42);
  let hex = hslToHex(h, Math.min(s, MAX_SATURATION), lightness);
  while (contrast(hex, CARD_TEXT) < MIN_CONTRAST && lightness > 0.04) {
    lightness -= 0.02;
    hex = hslToHex(h, Math.min(s, MAX_SATURATION), lightness);
  }
  return hex;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const rgb = s === 0 ? [l, l, l] : [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
  return `#${rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}
