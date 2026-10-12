import { describe, expect, it } from "vitest";
import { translate } from "./localization/core";
import type { Translate } from "./localization/UiLanguageProvider";
import { buildShelfFilterFacets, type ShelfEntry } from "./shelf";
import { EMPTY_SHELF_FILTERS, orderFacetValues, shelfFilterChips, shelfFilterCount } from "./ShelfFilterPanel";

function entry(id: string, creator: string, language = "ja"): ShelfEntry {
  return {
    id, title: `书 ${id}`, creator, language, fileName: `${id}.epub`, fileSize: 1, coverMime: "image/jpeg",
    addedAtMs: Date.now(), lastReadAtMs: 0, spineIndex: 0, page: 0, progressPct: 0,
    anchorIndex: null, anchorRatio: null, contentHash: id, isNew: false,
  };
}

describe("shelf filter helpers", () => {
  it("keeps picked values on top and sorts the rest by book count", () => {
    const options = [
      { value: "a", label: "Alpha", count: 1 },
      { value: "b", label: "Beta", count: 5 },
      { value: "c", label: "Gamma", count: 3 },
      { value: "d", label: "Delta", count: 0 },
    ];
    const ordered = orderFacetValues(options, new Set(["a", "d"]));
    expect(ordered.picked.map((option) => option.value)).toEqual(["a", "d"]);
    expect(ordered.others.map((option) => option.value)).toEqual(["b", "c"]);
    expect(orderFacetValues(options, new Set(["a"]), "ta").others.map((option) => option.value)).toEqual(["b", "d"]);
  });

  it("makes one chip per dimension however many values are selected", () => {
    const t = ((key, ...args) => translate("zh-CN", key, ...args)) as Translate;
    const authors = Array.from({ length: 120 }, (_, index) => `作者${String(index).padStart(3, "0")}`);
    const entries = authors.map((name, index) => entry(String(index), name, index % 2 ? "ja" : "zh"));
    const facets = buildShelfFilterFacets(entries);
    const filters = { ...EMPTY_SHELF_FILTERS, authors: new Set(authors), languages: new Set(["日语"]) };
    expect(shelfFilterCount(filters)).toBe(121);

    const wide = shelfFilterChips(filters, facets, t, false);
    expect(wide.map((chip) => chip.dimension)).toEqual(["authors", "languages"]);
    expect(wide[0].label).toBe("作者：作者000、作者001 等 120 项");
    expect(wide[1].label).toBe("语言：日语");
    expect(wide[0].clearLabel).toBe("清除作者筛选");

    const compact = shelfFilterChips(filters, facets, t, true);
    expect(compact.map((chip) => chip.label)).toEqual(["作者 120", "日语"]);
    expect(shelfFilterChips(EMPTY_SHELF_FILTERS, facets, t, false)).toEqual([]);
  });
});
