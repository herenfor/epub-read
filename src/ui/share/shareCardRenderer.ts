import { ICON_BOX, ICON_PAGES_PATH, ICON_RADIUS, WORDMARK_ADVANCE, WORDMARK_BASELINE, WORDMARK_PATH } from "./brandMark";
import {
  canUseVertical, isLatinText, shareCardPalette, shareCardSize,
  type ShareCardContent, type ShareCardOptions, type ShareCardPalette,
} from "./shareCardModel";
import { ellipsize, fitText, verticalGlyph, type Measure } from "./shareLayout";
import { tidyPassage } from "./shareText";

/**
 * Draws a share card with Canvas 2D. The preview and the exported PNG use
 * this same function, so what the reader sees is what gets shared.
 * Geometry is in "cq" units (1/100 of the card width), as in the design.
 */

export const BOOK_FONT = '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "STSong", "SimSun", Georgia, serif';
export const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif';

export interface ShareCardAssets {
  /** A loaded cover image, drawn only when the cover switch is on. */
  cover?: CanvasImageSource | null;
  /** Background for the cover-tone look (see coverTone.ts). */
  coverTone?: string | null;
}

export interface ShareCardDrawResult {
  width: number;
  height: number;
  /** The passage did not fit at the smallest size and was cut. */
  truncated: boolean;
  /** The look actually drawn (vertical falls back to paper for Latin text). */
  template: ShareCardOptions["template"];
}

/** Minimal 2D context surface the renderer needs; a real CanvasRenderingContext2D fits. */
export type ShareCardContext = Pick<CanvasRenderingContext2D,
  "save" | "restore" | "fillRect" | "fillText" | "measureText" | "beginPath" | "moveTo" | "lineTo" | "arcTo" | "closePath" |
  "fill" | "clip" | "drawImage" | "translate" | "scale"
> & {
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetY: number;
  fill(path?: Path2D | CanvasFillRule): void;
};

export function drawShareCard(
  ctx: ShareCardContext,
  content: ShareCardContent,
  options: ShareCardOptions,
  assets: ShareCardAssets = {},
  makePath: (d: string) => Path2D = (d) => new Path2D(d),
): ShareCardDrawResult {
  const { width: W, height: H } = shareCardSize(options.ratio);
  const cq = W / 100;
  const quote = tidyPassage(content.quote);
  const latin = isLatinText(quote);
  const template = options.template === "vertical" && !canUseVertical(quote) ? "paper" : options.template;
  const vertical = template === "vertical";
  const palette = shareCardPalette(template, content.accent, assets.coverTone);
  const note = options.showNote ? tidyPassage(content.note ?? "") : "";

  ctx.save();
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, W, H);

  const pad = 9 * cq;
  const padBottom = pad * 0.78;
  const contentW = W - pad * 2;

  // ---- Footer: book on the left, brand on the right, a hairline above. ----
  const cover = options.showCover ? assets.cover ?? null : null;
  const coverW = 8.5 * cq, coverH = coverW * 1.5;
  const titlePx = 3.6 * cq, metaPx = 2.7 * cq;
  const textBlockH = titlePx * 1.3 + 0.6 * cq + metaPx * 1.3;
  const iconSize = 4 * cq;
  const footerH = Math.max(cover ? coverH : textBlockH, options.showBrand ? iconSize : 0);
  const footerBottom = H - padBottom;
  const footerTop = footerBottom - footerH;
  const ruleY = footerTop - 4 * cq;
  ctx.fillStyle = palette.rule;
  ctx.fillRect(pad, ruleY, contentW, Math.max(1, 0.25 * cq));

  const brandW = options.showBrand ? drawBrand(ctx, palette, W - pad, footerBottom, cq, makePath) : 0;
  let textX = pad;
  if (cover) {
    drawCover(ctx, cover, pad, footerTop + (footerH - coverH) / 2, coverW, coverH, cq);
    textX += coverW + 3 * cq;
  }
  const textMax = W - pad - (brandW ? brandW + 4 * cq : 0) - textX;
  const textTop = footerTop + (footerH - textBlockH) / 2;
  const title = isLatinText(content.bookTitle) ? content.bookTitle.trim() : `《${content.bookTitle.trim()}》`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = palette.fg;
  ctx.font = `600 ${titlePx}px ${BOOK_FONT}`;
  // 《 carries its blank on the left; hang it so the title lines up with the line below.
  const hang = title.startsWith("《") ? titlePx * 0.45 : 0;
  ctx.fillText(ellipsize(title, textMax + hang, titlePx, measureWith(ctx, `600 {px}px ${BOOK_FONT}`)), textX - hang, textTop + titlePx * 0.65);
  const meta = [content.author?.trim(), options.showChapter ? content.chapter?.trim() : ""].filter(Boolean).join(" · ");
  if (meta) {
    ctx.fillStyle = palette.muted;
    ctx.font = `${metaPx}px ${UI_FONT}`;
    ctx.fillText(ellipsize(meta, textMax, metaPx, measureWith(ctx, `{px}px ${UI_FONT}`)), textX, textTop + titlePx * 1.3 + 0.6 * cq + metaPx * 0.65);
  }

  // ---- Body: the passage, then the reader's note, centred in what is left. ----
  const accentH = 0.9 * cq;
  const bodyTop = vertical ? pad : pad + accentH + 4.5 * cq;
  const bodyBottom = ruleY - 4.5 * cq;
  const bodyH = bodyBottom - bodyTop;
  if (!vertical) {
    ctx.fillStyle = palette.accent;
    roundRect(ctx, pad, pad, 7 * cq, accentH, accentH / 2);
    ctx.fill();
  }

  const maxPx = (options.ratio === "9:16" ? 7.4 : options.ratio === "1:1" ? 6 : 6.6) * cq;
  const minPx = (latin ? 3.9 : 4.1) * cq;
  const notePx = 3.3 * cq;
  const truncated = vertical
    ? drawVerticalBody(ctx, quote, note, palette, { pad, W, bodyTop, bodyH, contentW, maxPx, minPx, notePx, cq })
    : drawHorizontalBody(ctx, quote, note, latin, palette, { pad, bodyTop, bodyH, contentW, maxPx, minPx, notePx, cq });

  ctx.restore();
  return { width: W, height: H, truncated, template };
}

interface BodyBox { pad: number; bodyTop: number; bodyH: number; contentW: number; maxPx: number; minPx: number; notePx: number; cq: number }

function drawHorizontalBody(ctx: ShareCardContext, quote: string, note: string, latin: boolean, palette: ShareCardPalette, box: BodyBox): boolean {
  const { pad, bodyTop, bodyH, contentW, notePx, cq } = box;
  const spacing = latin ? 0 : 0.02;
  const lineHeight = latin ? 1.55 : 1.75;
  const quoteFont = `{px}px ${BOOK_FONT}`;
  const measureQuote = measureWith(ctx, quoteFont, spacing);

  const noteIndent = 3 * cq, noteLineHeight = 1.65, gap = 5 * cq;
  const noteFit = note
    ? fitText({ text: note, lineLength: contentW - noteIndent, blockSize: notePx * noteLineHeight * 3, lineHeight: noteLineHeight, maxPx: notePx, minPx: notePx, measure: measureWith(ctx, `{px}px ${UI_FONT}`), ellipsis: "…" })
    : null;
  const noteH = noteFit ? noteFit.lines.length * notePx * noteLineHeight : 0;

  const fit = fitText({
    text: quote, lineLength: contentW, blockSize: bodyH - (noteFit ? noteH + gap : 0), lineHeight,
    maxPx: box.maxPx, minPx: box.minPx, stepPx: Math.max(1, cq * 0.2), measure: measureQuote, ellipsis: latin ? "…" : "……",
  });
  const quoteH = fit.lines.length * fit.fontPx * lineHeight;
  let y = bodyTop + (bodyH - quoteH - (noteFit ? gap + noteH : 0)) / 2;

  ctx.fillStyle = palette.fg;
  ctx.font = quoteFont.replace("{px}", String(fit.fontPx));
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  fit.lines.forEach((line, i) => {
    const mid = y + fit.fontPx * lineHeight / 2;
    if (latin) {
      ctx.fillText(line, pad, mid);
    } else {
      const last = i === fit.lines.length - 1;
      drawSpacedLine(ctx, line, pad, mid, fit.fontPx, spacing, last ? null : contentW);
    }
    y += fit.fontPx * lineHeight;
  });

  if (noteFit) {
    y += gap;
    ctx.fillStyle = palette.accent;
    ctx.fillRect(pad, y + notePx * 0.2, Math.max(2, 0.5 * cq), noteH - notePx * 0.4);
    ctx.fillStyle = palette.muted;
    ctx.font = `${notePx}px ${UI_FONT}`;
    for (const line of noteFit.lines) {
      ctx.fillText(line, pad + noteIndent, y + notePx * noteLineHeight / 2);
      y += notePx * noteLineHeight;
    }
  }
  return fit.truncated;
}

/**
 * One line of CJK text, glyph by glyph so spacing is exact. Full lines are
 * justified to `justifyTo`; short lines (paragraph ends) keep natural spacing.
 */
function drawSpacedLine(ctx: ShareCardContext, line: string, x: number, y: number, px: number, spacing: number, justifyTo: number | null) {
  const chars = [...line];
  const widths = chars.map((ch) => ctx.measureText(ch).width + spacing * px);
  const natural = widths.reduce((a, b) => a + b, 0) - spacing * px;
  let extra = 0;
  if (justifyTo !== null && chars.length > 1 && natural >= justifyTo * 0.8) {
    extra = Math.min((justifyTo - natural) / (chars.length - 1), px * 0.6);
    if (extra < 0) extra = 0;
  }
  let cx = x;
  chars.forEach((ch, i) => {
    ctx.fillText(ch, cx, y);
    cx += widths[i] + extra;
  });
}

function drawVerticalBody(ctx: ShareCardContext, quote: string, note: string, palette: ShareCardPalette, box: BodyBox & { W: number }): boolean {
  const { pad, W, bodyTop, bodyH, contentW, notePx, cq } = box;
  const advance = 1.12, pitch = 1.9;
  const columns: Measure = (text, px) => [...text].length * px * advance;

  const noteTop = 3 * cq, noteGap = 6 * cq, notePitch = 1.65;
  const noteFit = note
    ? fitText({ text: note, lineLength: bodyH - noteTop, blockSize: notePx * notePitch * 3, lineHeight: notePitch, maxPx: notePx, minPx: notePx, measure: columns, ellipsis: "…" })
    : null;
  const noteW = noteFit ? noteFit.lines.length * notePx * notePitch : 0;

  const fit = fitText({
    text: quote, lineLength: bodyH, blockSize: contentW - (noteFit ? noteW + noteGap : 0), lineHeight: pitch,
    maxPx: box.maxPx, minPx: box.minPx, stepPx: Math.max(1, cq * 0.2), measure: columns, ellipsis: "……",
  });

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = palette.fg;
  ctx.font = `${fit.fontPx}px ${BOOK_FONT}`;
  let x = W - pad;
  for (const line of fit.lines) {
    drawColumn(ctx, line, x - fit.fontPx * pitch / 2, bodyTop, fit.fontPx, advance);
    x -= fit.fontPx * pitch;
  }

  if (noteFit) {
    x -= noteGap - fit.fontPx * (pitch - 1) / 2;
    ctx.fillStyle = palette.accent;
    ctx.fillRect(x - notePx * notePitch / 2 - notePx / 2, bodyTop, notePx, Math.max(2, 0.5 * cq));
    ctx.fillStyle = palette.muted;
    ctx.font = `${notePx}px ${UI_FONT}`;
    for (const line of noteFit.lines) {
      drawColumn(ctx, line, x - notePx * notePitch / 2, bodyTop + noteTop, notePx, advance);
      x -= notePx * notePitch;
    }
  }
  return fit.truncated;
}

function drawColumn(ctx: ShareCardContext, line: string, cx: number, top: number, px: number, advance: number) {
  let y = top + px * advance / 2;
  for (const ch of line) {
    ctx.fillText(verticalGlyph(ch), cx, y);
    y += px * advance;
  }
}

/** Draws the icon and the SeLis wordmark ending at (right, bottom); returns the width used. */
function drawBrand(ctx: ShareCardContext, palette: ShareCardPalette, right: number, bottom: number, cq: number, makePath: (d: string) => Path2D): number {
  const icon = 4 * cq, gap = 1.4 * cq, cap = 1.9 * cq;
  const wordScale = cap / WORDMARK_BASELINE;
  const wordW = WORDMARK_ADVANCE * wordScale;
  const total = icon + gap + wordW;
  const left = right - total, top = bottom - icon;

  ctx.save();
  ctx.translate(left, top);
  ctx.scale(icon / ICON_BOX, icon / ICON_BOX);
  ctx.fillStyle = palette.markBg;
  roundRect(ctx, 0, 0, ICON_BOX, ICON_BOX, ICON_RADIUS);
  ctx.fill();
  ctx.fillStyle = palette.markFg;
  ctx.fill(makePath(ICON_PAGES_PATH));
  ctx.restore();

  ctx.save();
  ctx.translate(left + icon + gap, top + (icon - cap) / 2);
  ctx.scale(wordScale, wordScale);
  ctx.fillStyle = palette.muted;
  ctx.fill(makePath(WORDMARK_PATH));
  ctx.restore();
  return total;
}

function drawCover(ctx: ShareCardContext, image: CanvasImageSource, x: number, y: number, w: number, h: number, cq: number) {
  const size = imageSize(image);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.22)";
  ctx.shadowBlur = 1.2 * cq;
  ctx.shadowOffsetY = 0.4 * cq;
  ctx.fillStyle = "#000";
  roundRect(ctx, x, y, w, h, 0.6 * cq);
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, x, y, w, h, 0.6 * cq);
  ctx.clip();
  if (size) {
    // Cover-fit: fill the frame, crop the overflow from the centre.
    const scale = Math.max(w / size.w, h / size.h);
    const sw = w / scale, sh = h / scale;
    ctx.drawImage(image, (size.w - sw) / 2, (size.h - sh) / 2, sw, sh, x, y, w, h);
  }
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(x, y, 0.8 * cq, h);
  ctx.restore();
}

function imageSize(image: CanvasImageSource): { w: number; h: number } | null {
  const any = image as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength };
  const w = any.naturalWidth || any.videoWidth || (typeof any.width === "number" ? any.width : 0);
  const h = any.naturalHeight || any.videoHeight || (typeof any.height === "number" ? any.height : 0);
  return w && h ? { w, h } : null;
}

function roundRect(ctx: ShareCardContext, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** A Measure on this context for a font template like "600 {px}px serif", plus letter spacing in em. */
function measureWith(ctx: ShareCardContext, fontTemplate: string, spacingEm = 0): Measure {
  return (text, px) => {
    const previous = ctx.font;
    ctx.font = fontTemplate.replace("{px}", String(px));
    const width = ctx.measureText(text).width + spacingEm * px * Math.max(0, [...text].length - 1);
    ctx.font = previous;
    return width;
  };
}

/** Draws the card on a new canvas of its export size. */
export function createShareCardCanvas(
  content: ShareCardContent,
  options: ShareCardOptions,
  assets: ShareCardAssets = {},
  doc: Document = document,
): { canvas: HTMLCanvasElement; result: ShareCardDrawResult } {
  const { width, height } = shareCardSize(options.ratio);
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("share card: 2D canvas unavailable");
  const result = drawShareCard(ctx, content, options, assets);
  return { canvas, result };
}

/** The card as PNG bytes. */
export function shareCardPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("share card: PNG encoding failed"))), "image/png");
  });
}

