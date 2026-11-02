import { VIEWER_ID } from "../render/sanitize";

/** The book's own type values, read from the text on screen. Missing = unknown. */
export interface BookTypography {
  lineHeight?: number;
  fontWeight?: number;
  letterSpacingPx?: number;
  wordSpacingPx?: number;
}

/** A paragraph long enough to carry the body text's style. */
const MIN_SAMPLE_CHARS = 8;

function sampleElement(viewer: Element): Element {
  for (const paragraph of Array.from(viewer.querySelectorAll("p"))) {
    if ((paragraph.textContent ?? "").trim().length >= MIN_SAMPLE_CHARS) return paragraph;
  }
  return viewer;
}

function spacingPx(value: string): number | undefined {
  if (value === "normal") return 0;
  const px = parseFloat(value);
  return Number.isFinite(px) ? px : undefined;
}

/** Type values of one rendered section, from its first body paragraph. */
export function readTypographyFrom(contentDoc: Document): BookTypography | null {
  const view = contentDoc.defaultView;
  const viewer = contentDoc.getElementById(VIEWER_ID) ?? contentDoc.body;
  if (!view || !viewer || typeof view.getComputedStyle !== "function") return null;
  const style = view.getComputedStyle(sampleElement(viewer));
  const result: BookTypography = {};
  const fontSize = parseFloat(style.fontSize);
  const lineHeight = parseFloat(style.lineHeight);
  // "normal" depends on the font; leave it unknown rather than guess.
  if (fontSize > 0 && Number.isFinite(lineHeight)) result.lineHeight = Math.round((lineHeight / fontSize) * 100) / 100;
  const weight = parseInt(style.fontWeight, 10);
  if (Number.isFinite(weight)) result.fontWeight = weight;
  const letter = spacingPx(style.letterSpacing);
  if (letter !== undefined) result.letterSpacingPx = letter;
  const word = spacingPx(style.wordSpacing);
  if (word !== undefined) result.wordSpacingPx = word;
  return result;
}

/**
 * The book's type values from the first readable reader frame on the page.
 * Values the reader overrides read as the override, so callers keep only the
 * fields the reader leaves to the book.
 */
export function readBookTypography(doc: Document): BookTypography | null {
  for (const frame of Array.from(doc.querySelectorAll<HTMLIFrameElement>(".reader iframe"))) {
    try {
      const contentDoc = frame.contentDocument;
      if (!contentDoc || frame.getBoundingClientRect().width === 0) continue;
      const values = readTypographyFrom(contentDoc);
      if (values) return values;
    } catch {
      // A frame that is gone or not ours: try the next.
    }
  }
  return null;
}
