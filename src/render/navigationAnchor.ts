import {
  sanitizePersistedTextAnchor,
  type TextAnchorData,
} from "./textAnchor";

export interface PersistedNavigationAnchor {
  index: number;
  ratio: number;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
}

export interface RuntimeNavigationAnchor extends TextAnchorData {
  index: number;
  ratio: number;
  charsRead: number;
  totalChars: number;
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
  if (text.textOffset === null && !legacyValid) return null;
  return {
    ...text,
    index: legacyValid ? source.index : -1,
    ratio: legacyValid ? source.ratio : 0,
    charsRead: text.textOffset ?? 0,
    totalChars: 0,
  };
}
