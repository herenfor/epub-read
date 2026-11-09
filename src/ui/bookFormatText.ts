import { MOBI_FORMAT_ENABLED } from "../config/mobiFormat";

/**
 * Texts that list the importable formats, and their wording for builds with
 * MOBI switched off (ER-0150; AZW3 stays listed). Delete the `.noMobi` keys
 * once the switch is gone.
 */
const WITHOUT_MOBI = {
  "shelf.import.tip": "shelf.import.tip.noMobi",
  "shelf.import.books.detail": "shelf.import.books.detail.noMobi",
  "shelf.import.dropHint": "shelf.import.dropHint.noMobi",
  "shelf.import.dropHint.booksOnly": "shelf.import.dropHint.booksOnly.noMobi",
  "shelf.import.toFolder.tip": "shelf.import.toFolder.tip.noMobi",
  "notice.picker.epubFilter": "notice.picker.epubFilter.noMobi",
  "notice.drop.unsupported": "notice.drop.unsupported.noMobi",
  "notice.drop.booksOnly": "notice.drop.booksOnly.noMobi",
} as const;

export type FormatListKey = keyof typeof WITHOUT_MOBI;

export function formatListKey<K extends FormatListKey>(
  key: K,
  mobi: boolean = MOBI_FORMAT_ENABLED,
): K | (typeof WITHOUT_MOBI)[K] {
  return mobi ? key : WITHOUT_MOBI[key];
}
