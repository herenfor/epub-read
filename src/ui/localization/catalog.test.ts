import { describe, expect, it } from "vitest";
import { CATALOGS, EN_FILES, ZH_TW_FILES, zhCN } from "./catalog";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("UI message catalogs", () => {
  it("registers every catalog once, with keys inside its own namespace", () => {
    const namespaces = CATALOGS.map((catalog) => catalog.namespace);
    expect(new Set(namespaces).size).toBe(namespaces.length);
    expect(Object.keys(EN_FILES).sort()).toEqual([...namespaces].sort());
    expect(Object.keys(ZH_TW_FILES).sort()).toEqual([...namespaces].sort());
    let total = 0;
    for (const catalog of CATALOGS) {
      for (const key of Object.keys(catalog.zh)) {
        expect(key.startsWith(`${catalog.namespace}.`), key).toBe(true);
        total += 1;
      }
    }
    expect(Object.keys(zhCN)).toHaveLength(total);
  });

  it("keeps translated files to known keys with the same placeholders", () => {
    for (const files of [EN_FILES, ZH_TW_FILES]) {
      for (const catalog of CATALOGS) {
        const zh = catalog.zh as Record<string, string>;
        for (const [key, text] of Object.entries(files[catalog.namespace])) {
          expect(zh[key], `${catalog.namespace}: unknown key ${key}`).toBeDefined();
          if (text === "") continue; // Untranslated; falls back to Simplified Chinese.
          expect(placeholders(text), key).toEqual(placeholders(zh[key]));
        }
      }
    }
  });

  it("keeps the render and core layers free of the UI language module", async () => {
    // @ts-expect-error The project intentionally does not include @types/node.
    const { readdir, readFile } = await import("node:fs/promises");
    const offenders: string[] = [];
    for (const dir of ["src/render", "src/core"]) {
      for (const entry of await readdir(dir, { recursive: true })) {
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        const source = await readFile(`${dir}/${entry}`, "utf8");
        if (/from\s+["'][^"']*\/localization\//.test(source)) offenders.push(`${dir}/${entry}`);
      }
    }
    // Text drawn inside the book frame is injected by the host (e.g. ChapterPaginator.setEndText).
    expect(offenders).toEqual([]);
  });
});
