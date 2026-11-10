import { ICON_BOX, ICON_PAGES_PATH, ICON_RADIUS, WORDMARK_ADVANCE, WORDMARK_BASELINE, WORDMARK_PATH } from "./brandMark";
import {
  canUseVertical, isLatinText, shareCardPalette, shareCardSize, SHARE_CARD_WIDTH, SHARE_LONG_MAX_HEIGHT, SHARE_LONG_MIN_HEIGHT,
  type ShareCardContent, type ShareCardOptions, type ShareCardPalette,
} from "./shareCardModel";
import { ellipsize, fitText, fittedBlockSize, verticalGlyph, type FitResult, type Measure } from "./shareLayout";
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

/** A long card keeps one comfortable text size and grows instead (ER-0162). */
const LONG_QUOTE_CQ = { cjk: 4.4, latin: 4.2 };
/** Room between paragraphs on a long card, as a multiple of the text size. */
const LONG_PARAGRAPH_GAP = 0.7;

/** Everything about a card that is decided before any pixel is drawn. */
interface CardPlan {
  W: number;
  H: number;
  cq: number;
  pad: number;
  contentW: number;
  quote: string;
  note: string;
  latin: boolean;
  template: ShareCardOptions["template"];
  palette: ShareCardPalette;
  cover: CanvasImageSource | null;
  footerH: number;
  bodyTop: number;
  bodyH: number;
  maxPx: number;
  minPx: number;
  notePx: number;
  /** The horizontal passage and note, already broken into lines; null on a vertical card. */
  horizontal: HorizontalPlan | null;
}

const COVER_W_CQ = 8.5, TITLE_CQ = 3.6, META_CQ = 2.7, ICON_CQ = 4, ACCENT_H_CQ = 0.9;

function planShareCard(ctx: ShareCardContext, content: ShareCardContent, options: ShareCardOptions, assets: ShareCardAssets): CardPlan {
  const W = SHARE_CARD_WIDTH;
  const cq = W / 100;
  const long = options.ratio === "long";
  const quote = tidyPassage(content.quote);
  const latin = isLatinText(quote);
  const template = options.template === "vertical" && !canUseVertical(quote, options.ratio) ? "paper" : options.template;
  const vertical = template === "vertical";
  const palette = shareCardPalette(template, content.accent, assets.coverTone);
  const note = options.showNote ? tidyPassage(content.note ?? "") : "";

  const pad = 9 * cq;
  const contentW = W - pad * 2;
  const cover = options.showCover ? assets.cover ?? null : null;
  const textBlockH = TITLE_CQ * cq * 1.3 + 0.6 * cq + META_CQ * cq * 1.3;
  const footerH = Math.max(cover ? COVER_W_CQ * cq * 1.5 : textBlockH, options.showBrand ? ICON_CQ * cq : 0);
  const bodyTop = vertical ? pad : pad + ACCENT_H_CQ * cq + 4.5 * cq;
  // Under the body: a gap, the hairline, a gap, the footer, the bottom padding.
  const belowBody = 4.5 * cq + 4 * cq + footerH + pad * 0.78;

  const longPx = (latin ? LONG_QUOTE_CQ.latin : LONG_QUOTE_CQ.cjk) * cq;
  const maxPx = long ? longPx : (options.ratio === "9:16" ? 7.4 : options.ratio === "1:1" ? 6 : 6.6) * cq;
  const minPx = long ? longPx : (latin ? 3.9 : 4.1) * cq;
  const notePx = 3.3 * cq;
  const body = { contentW, maxPx, minPx, notePx, cq, long };

  let H = shareCardSize(options.ratio).height;
  let horizontal: HorizontalPlan | null = null;
  if (long) {
    const natural = planHorizontalBody(ctx, quote, note, latin, { ...body, bodyH: Infinity });
    const wanted = Math.ceil(bodyTop + natural.height + belowBody);
    H = Math.min(SHARE_LONG_MAX_HEIGHT, Math.max(SHARE_LONG_MIN_HEIGHT, wanted));
    if (wanted <= H) horizontal = natural;
  }
  const bodyH = H - bodyTop - belowBody;
  if (!vertical && !horizontal) horizontal = planHorizontalBody(ctx, quote, note, latin, { ...body, bodyH });

  return { W, H, cq, pad, contentW, quote, note, latin, template, palette, cover, footerH, bodyTop, bodyH, maxPx, minPx, notePx, horizontal };
}

/**
 * The card's export height. Fixed for the three ratios; a long card is as
 * tall as its passage and note need. Size the canvas with this before drawing.
 */
export function shareCardHeight(ctx: ShareCardContext, content: ShareCardContent, options: ShareCardOptions, assets: ShareCardAssets = {}): number {
  return options.ratio === "long" ? planShareCard(ctx, content, options, assets).H : shareCardSize(options.ratio).height;
}

export function drawShareCard(
  ctx: ShareCardContext,
  content: ShareCardContent,
  options: ShareCardOptions,
  assets: ShareCardAssets = {},
  makePath: (d: string) => Path2D = (d) => new Path2D(d),
): ShareCardDrawResult {
  const plan = planShareCard(ctx, content, options, assets);
  const { W, H, cq, pad, contentW, palette, cover, footerH, bodyTop, bodyH, template } = plan;

  ctx.save();
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- Footer: book on the left, brand on the right, a hairline above. ----
  const coverW = COVER_W_CQ * cq, coverH = coverW * 1.5;
  const titlePx = TITLE_CQ * cq, metaPx = META_CQ * cq;
  const textBlockH = titlePx * 1.3 + 0.6 * cq + metaPx * 1.3;
  const footerBottom = H - pad * 0.78;
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
  if (plan.horizontal) {
    const accentH = ACCENT_H_CQ * cq;
    ctx.fillStyle = palette.accent;
    roundRect(ctx, pad, pad, 7 * cq, accentH, accentH / 2);
    ctx.fill();
  }
  const truncated = plan.horizontal
    ? drawHorizontalBody(ctx, plan.horizontal, plan.latin, palette, { pad, bodyTop, bodyH, contentW, notePx: plan.notePx, cq })
    : drawVerticalBody(ctx, plan.quote, plan.note, palette, { pad, W, bodyTop, bodyH, contentW, maxPx: plan.maxPx, minPx: plan.minPx, notePx: plan.notePx, cq });

  ctx.restore();
  return { width: W, height: H, truncated, template };
}

interface BodyBox { pad: number; bodyTop: number; bodyH: number; contentW: number; maxPx: number; minPx: number; notePx: number; cq: number }

const NOTE_INDENT_CQ = 3, NOTE_LINE_HEIGHT = 1.65, NOTE_GAP_CQ = 5;

interface HorizontalPlan {
  fit: FitResult;
  noteFit: FitResult | null;
  lineHeight: number;
  spacing: number;
  paragraphGap: number;
  /** Height of the passage plus the note under it. */
  height: number;
}

/**
 * Breaks the passage and the note for a horizontal card. A fixed card keeps
 * the note to three lines; a long card shows all of it.
 */
function planHorizontalBody(
  ctx: ShareCardContext, quote: string, note: string, latin: boolean,
  box: { contentW: number; bodyH: number; maxPx: number; minPx: number; notePx: number; cq: number; long: boolean },
): HorizontalPlan {
  const { contentW, bodyH, notePx, cq, long } = box;
  const spacing = latin ? 0 : 0.02;
  const lineHeight = latin ? 1.55 : 1.75;
  const paragraphGap = long ? LONG_PARAGRAPH_GAP : 0;
  const gap = NOTE_GAP_CQ * cq;

  const noteRoom = long ? bodyH * 0.4 : notePx * NOTE_LINE_HEIGHT * 3;
  const noteFit = note
    ? fitText({ text: note, lineLength: contentW - NOTE_INDENT_CQ * cq, blockSize: noteRoom, lineHeight: NOTE_LINE_HEIGHT, maxPx: notePx, minPx: notePx, measure: measureWith(ctx, `{px}px ${UI_FONT}`), ellipsis: "…" })
    : null;
  const noteH = noteFit ? fittedBlockSize(noteFit, NOTE_LINE_HEIGHT) : 0;

  const fit = fitText({
    text: quote, lineLength: contentW, blockSize: bodyH - (noteFit ? noteH + gap : 0), lineHeight, paragraphGap,
    maxPx: box.maxPx, minPx: box.minPx, stepPx: Math.max(1, cq * 0.2), measure: measureWith(ctx, `{px}px ${BOOK_FONT}`, spacing), ellipsis: latin ? "…" : "……",
  });
  const height = fittedBlockSize(fit, lineHeight, paragraphGap) + (noteFit ? gap + noteH : 0);
  return { fit, noteFit, lineHeight, spacing, paragraphGap, height };
}

function drawHorizontalBody(
  ctx: ShareCardContext, plan: HorizontalPlan, latin: boolean, palette: ShareCardPalette,
  box: { pad: number; bodyTop: number; bodyH: number; contentW: number; notePx: number; cq: number },
): boolean {
  const { pad, bodyTop, bodyH, contentW, notePx, cq } = box;
  const { fit, noteFit, lineHeight, spacing } = plan;
  let y = bodyTop + (bodyH - plan.height) / 2;

  ctx.fillStyle = palette.fg;
  ctx.font = `${fit.fontPx}px ${BOOK_FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const paragraphStarts = new Set(fit.paragraphStarts);
  fit.lines.forEach((line, i) => {
    if (paragraphStarts.has(i)) y += fit.fontPx * plan.paragraphGap;
    const mid = y + fit.fontPx * lineHeight / 2;
    if (latin) {
      ctx.fillText(line, pad, mid);
    } else {
      const paragraphEnd = i === fit.lines.length - 1 || paragraphStarts.has(i + 1);
      drawSpacedLine(ctx, line, pad, mid, fit.fontPx, spacing, paragraphEnd ? null : contentW);
    }
    y += fit.fontPx * lineHeight;
  });

  if (noteFit) {
    const noteH = fittedBlockSize(noteFit, NOTE_LINE_HEIGHT);
    y += NOTE_GAP_CQ * cq;
    ctx.fillStyle = palette.accent;
    ctx.fillRect(pad, y + notePx * 0.2, Math.max(2, 0.5 * cq), noteH - notePx * 0.4);
    ctx.fillStyle = palette.muted;
    ctx.font = `${notePx}px ${UI_FONT}`;
    for (const line of noteFit.lines) {
      ctx.fillText(line, pad + NOTE_INDENT_CQ * cq, y + notePx * NOTE_LINE_HEIGHT / 2);
      y += notePx * NOTE_LINE_HEIGHT;
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
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("share card: 2D canvas unavailable");
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = shareCardHeight(ctx, content, options, assets);
  const result = drawShareCard(ctx, content, options, assets);
  return { canvas, result };
}

/** The card as PNG bytes. */
export function shareCardPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("share card: PNG encoding failed"))), "image/png");
  });
}

