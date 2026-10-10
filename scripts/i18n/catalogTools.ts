import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CATALOGS, EN_FILES } from "../../src/ui/localization/catalog";

export const ROOT = join(import.meta.dirname, "../..");
export const EN_DIR = join(ROOT, "src/ui/localization/en");

export interface ExportEntry {
  key: string;
  zh: string;
  en: string;
  placeholders: string[];
  note?: string;
  max?: number;
  usedIn: string[];
}

export const placeholdersOf = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort();

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "localization" && name !== "node_modules") sourceFiles(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** key → "file:line" list, so translators see where each string lives. */
export function usageIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const pattern = /["'`]([a-z][\w-]*(?:\.[\w-]+)+)["'`]/g;
  for (const file of sourceFiles(join(ROOT, "src"))) {
    readFileSync(file, "utf8").split("\n").forEach((line, row) => {
      for (const match of line.matchAll(pattern)) {
        const list = index.get(match[1]) ?? [];
        list.push(`${relative(ROOT, file)}:${row + 1}`);
        index.set(match[1], list);
      }
    });
  }
  return index;
}

export function exportEntries(): Array<{ namespace: string; entries: ExportEntry[] }> {
  const usage = usageIndex();
  return CATALOGS.map((catalog) => ({
    namespace: catalog.namespace,
    entries: Object.entries(catalog.meta).map(([key, meta]) => ({
      key,
      zh: meta.zh,
      en: EN_FILES[catalog.namespace][key] ?? "",
      placeholders: placeholdersOf(meta.zh),
      ...(meta.note ? { note: meta.note } : {}),
      ...(meta.max ? { max: meta.max } : {}),
      usedIn: usage.get(key) ?? [],
    })),
  }));
}
