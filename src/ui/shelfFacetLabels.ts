import type { PlainMessageKey } from "./localization/core";
import type { Translate } from "./localization/UiLanguageProvider";
import { UNKNOWN_SHELF_AUTHOR, UNKNOWN_SHELF_LANGUAGE, type ShelfTimeSegment } from "./shelf";

/**
 * Facet values stay the stable ids produced by shelf.ts (filters keep using
 * them); only the label shown in the filter list follows the UI language.
 */
const LANGUAGE_KEYS: Readonly<Record<string, PlainMessageKey>> = {
  中文: "shelfMenu.language.zh",
  日语: "shelfMenu.language.ja",
  英语: "shelfMenu.language.en",
  韩语: "shelfMenu.language.ko",
  法语: "shelfMenu.language.fr",
  德语: "shelfMenu.language.de",
  西班牙语: "shelfMenu.language.es",
  俄语: "shelfMenu.language.ru",
  [UNKNOWN_SHELF_LANGUAGE]: "shelfMenu.language.unknown",
};

const TIME_SEGMENT_KEYS: Readonly<Record<ShelfTimeSegment, PlainMessageKey>> = {
  today: "shelf.timeSegment.today",
  last7Days: "shelf.timeSegment.last7Days",
  last30Days: "shelf.timeSegment.last30Days",
  thisYear: "shelf.timeSegment.thisYear",
  older: "shelf.timeSegment.older",
};

export type ShelfFacetKind = "authors" | "titles" | "timeSegments" | "languages";

export function localizeFacetOptions<T extends { value: string; label: string }>(
  kind: ShelfFacetKind,
  options: readonly T[],
  t: Translate,
): T[] {
  return options.map((option) => {
    const key = kind === "timeSegments" ? TIME_SEGMENT_KEYS[option.value as ShelfTimeSegment]
      : kind === "languages" ? LANGUAGE_KEYS[option.value]
        : kind === "authors" && option.value === UNKNOWN_SHELF_AUTHOR ? "shelf.unknownAuthor"
          : undefined;
    return key ? { ...option, label: t(key) } : option;
  });
}
