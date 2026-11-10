/**
 * Line breaking and fitting for share cards, independent of the canvas so it
 * can be tested with a fake measure. Chinese and Japanese break between any
 * two characters but keep the usual line-start and line-end rules (no comma
 * or closing quote at a line start, no opening quote at a line end); Latin
 * words never split unless a single word is wider than the line.
 */

/** Width of `text` at `fontPx`, including any letter spacing the caller adds. */
export type Measure = (text: string, fontPx: number) => number;

/** Characters that may not begin a line. */
const NO_LINE_START = new Set([..."，。、；：？！）」』》〉】〕］｝”’…—～·%‰℃,.;:?!)]}ー、。・"]);
/** Characters that may not end a line. */
const NO_LINE_END = new Set([..."（「『《〈【〔［｛“‘([{"]);

const WIDE = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/;

/**
 * Breaks one paragraph into units that may not be split: a wide character
 * with the punctuation glued to it, or a Latin word with its trailing space.
 */
export function breakUnits(paragraph: string): string[] {
  // In a Latin paragraph punctuation stays inside its word ("don’t", "e.g.").
  const wide = WIDE.test(paragraph);
  const raw: string[] = [];
  let word = "";
  for (const ch of paragraph) {
    if (wide && (WIDE.test(ch) || NO_LINE_START.has(ch) || NO_LINE_END.has(ch))) {
      if (word) raw.push(word), (word = "");
      raw.push(ch);
    } else if (ch === " ") {
      word += ch;
      raw.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (word) raw.push(word);

  const units: string[] = [];
  let carry = "";
  for (const piece of raw) {
    if (units.length && !carry && [...piece].every((c) => NO_LINE_START.has(c))) {
      units[units.length - 1] += piece;
    } else if (piece.length === 1 && NO_LINE_END.has(piece)) {
      carry += piece;
    } else {
      units.push(carry + piece);
      carry = "";
    }
  }
  if (carry) units.push(carry);
  return units;
}

/** Lays text into lines no wider than `maxWidth`; paragraphs start new lines. */
export function breakLines(text: string, maxWidth: number, fontPx: number, measure: Measure): string[] {
  return breakParagraphs(text, maxWidth, fontPx, measure).lines;
}

export interface BrokenText {
  lines: string[];
  /** Indexes of the lines that begin the second and later paragraphs. */
  paragraphStarts: number[];
}

/** breakLines, also reporting where each later paragraph begins. */
export function breakParagraphs(text: string, maxWidth: number, fontPx: number, measure: Measure): BrokenText {
  const lines: string[] = [];
  const paragraphStarts: number[] = [];
  for (const paragraph of text.split("\n")) {
    if (lines.length) paragraphStarts.push(lines.length);
    let line = "";
    for (const unit of breakUnits(paragraph)) {
      const next = line + unit;
      if (!line || measure(next.trimEnd(), fontPx) <= maxWidth) {
        line = next;
        if (measure(line.trimEnd(), fontPx) > maxWidth) {
          // A single unit wider than the line: split it by character.
          const split = splitByChar(line, maxWidth, fontPx, measure);
          lines.push(...split.slice(0, -1));
          line = split[split.length - 1];
        }
        continue;
      }
      lines.push(line.trimEnd());
      line = unit.trimStart() ? unit : "";
      if (measure(line.trimEnd(), fontPx) > maxWidth) {
        const split = splitByChar(line, maxWidth, fontPx, measure);
        lines.push(...split.slice(0, -1));
        line = split[split.length - 1];
      }
    }
    lines.push(line.trimEnd());
  }
  return { lines, paragraphStarts };
}

function splitByChar(text: string, maxWidth: number, fontPx: number, measure: Measure): string[] {
  const out: string[] = [];
  let line = "";
  for (const ch of text) {
    if (line && measure(line + ch, fontPx) > maxWidth) {
      out.push(line);
      line = "";
    }
    line += ch;
  }
  out.push(line);
  return out;
}

export interface FitRequest {
  text: string;
  /** Line length: width for horizontal text, column height for vertical text. */
  lineLength: number;
  /** Room across lines: height for horizontal text, width for vertical text. */
  blockSize: number;
  /** Line pitch as a multiple of the font size. */
  lineHeight: number;
  maxPx: number;
  minPx: number;
  stepPx?: number;
  measure: Measure;
  /** Appended when the passage is cut. */
  ellipsis: string;
  /** Extra room between paragraphs, as a multiple of the font size. */
  paragraphGap?: number;
}

export interface FitResult extends BrokenText {
  fontPx: number;
  truncated: boolean;
}

/** The room a fitted text takes across its lines, paragraph gaps included. */
export function fittedBlockSize(fit: FitResult, lineHeight: number, paragraphGap = 0): number {
  return fit.lines.length * fit.fontPx * lineHeight + fit.paragraphStarts.length * fit.fontPx * paragraphGap;
}

/**
 * The largest size from max to min at which the text fits; below the
 * minimum the passage is cut at the longest prefix that still fits, with
 * trailing punctuation dropped before the ellipsis.
 */
export function fitText(req: FitRequest): FitResult {
  const step = req.stepPx ?? 2;
  const gap = req.paragraphGap ?? 0;
  const fits = (broken: BrokenText, px: number) =>
    broken.lines.length * px * req.lineHeight + broken.paragraphStarts.length * px * gap <= req.blockSize + 0.5;
  for (let px = req.maxPx; px >= req.minPx; px -= step) {
    const broken = breakParagraphs(req.text, req.lineLength, px, req.measure);
    if (fits(broken, px)) return { fontPx: px, ...broken, truncated: false };
  }
  const px = req.minPx;
  const chars = [...req.text];
  const attempt = (n: number) => breakParagraphs(cutAt(chars, n) + req.ellipsis, req.lineLength, px, req.measure);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(attempt(mid), px)) lo = mid;
    else hi = mid - 1;
  }
  return { fontPx: px, ...attempt(lo), truncated: true };
}

function cutAt(chars: string[], n: number): string {
  return chars.slice(0, n).join("").replace(/[\s，、；：,;:·—\-]+$/u, "");
}

/** Shortens one line to fit `maxWidth`, ending with "…" when cut. */
export function ellipsize(text: string, maxWidth: number, fontPx: number, measure: Measure): string {
  if (measure(text, fontPx) <= maxWidth) return text;
  const chars = [...text];
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(chars.slice(0, mid).join("").trimEnd() + "…", fontPx) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("").trimEnd() + "…";
}

/** Vertical presentation forms for punctuation in a vertical column. */
const VERTICAL_FORMS: Record<string, string> = {
  "，": "︐", "、": "︑", "。": "︒", "：": "︓", "；": "︔", "！": "︕", "？": "︖",
  "「": "﹁", "」": "﹂", "『": "﹃", "』": "﹄", "（": "︵", "）": "︶", "《": "︽", "》": "︾",
  "〈": "︿", "〉": "﹀", "【": "︻", "】": "︼", "…": "︙", "—": "︱", "“": "﹃", "”": "﹄", "‘": "﹁", "’": "﹂",
};

/** The glyph to draw for a character in a vertical column. */
export function verticalGlyph(ch: string): string {
  return VERTICAL_FORMS[ch] ?? ch;
}
