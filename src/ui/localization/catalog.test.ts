import { describe, expect, it } from "vitest";
import { CATALOGS, EN_FILES, zhCN } from "./catalog";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("UI message catalogs", () => {
  it("registers every catalog once, with keys inside its own namespace", () => {
    const namespaces = CATALOGS.map((catalog) => catalog.namespace);
    expect(new Set(namespaces).size).toBe(namespaces.length);
    expect(Object.keys(EN_FILES).sort()).toEqual([...namespaces].sort());
    let total = 0;
    for (const catalog of CATALOGS) {
      for (const key of Object.keys(catalog.zh)) {
        expect(key.startsWith(`${catalog.namespace}.`), key).toBe(true);
        total += 1;
      }
    }
    expect(Object.keys(zhCN)).toHaveLength(total);
  });

  it("keeps English files to known keys with the same placeholders", () => {
    for (const catalog of CATALOGS) {
      const zh = catalog.zh as Record<string, string>;
      for (const [key, text] of Object.entries(EN_FILES[catalog.namespace])) {
        expect(zh[key], `${catalog.namespace}: unknown key ${key}`).toBeDefined();
        if (text === "") continue; // Untranslated; falls back to Chinese.
        expect(placeholders(text), key).toEqual(placeholders(zh[key]));
      }
    }
  });
});
