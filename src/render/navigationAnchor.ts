import {
  sanitizePersistedTextAnchor,
  type TextAnchorData,
} from "./textAnchor";
import type { MediaReadingAnchor } from "./paginator";

export interface PersistedNavigationAnchor {
  index: number;
  ratio: number;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
  /** B-155/R4：纯图片/媒体身份；仅文本/legacy 均不可用时作为语义目标。 */
  mediaAnchor?: MediaReadingAnchor | null;
}

export interface RuntimeNavigationAnchor extends TextAnchorData {
  index: number;
  ratio: number;
  charsRead: number;
  totalChars: number;
  mediaAnchor?: MediaReadingAnchor | null;
}

/**
 * Convert persisted/UI navigation fields to the paginator's runtime anchor
 * explicitly.  The old code passed this object to a validator that only reads
 * textOffset/textSnippet, silently dropping the anchor and making search/note
 * jumps fall back to page 0.
 */
export function adaptNavigationAnchor(
  source: PersistedNavigationAnchor | null | undefined,
): RuntimeNavigationAnchor | null {
  if (!source) return null;
  const text = sanitizePersistedTextAnchor({
    textOffset: source.anchorTextOffset,
    textSnippet: source.anchorTextSnippet,
  });
  const legacyValid =
    Number.isSafeInteger(source.index) &&
    source.index >= 0 &&
    Number.isFinite(source.ratio) &&
    source.ratio >= 0 &&
    source.ratio <= 1;
  const mediaAnchor = source.mediaAnchor ?? null;
  if (text.textOffset === null && !legacyValid && !mediaAnchor) return null;
  return {
    ...text,
    index: legacyValid ? source.index : -1,
    ratio: legacyValid ? source.ratio : (mediaAnchor?.ratio ?? 0),
    charsRead: text.textOffset ?? 0,
    totalChars: 0,
    ...(mediaAnchor ? { mediaAnchor: { ...mediaAnchor } } : {}),
  };
}
