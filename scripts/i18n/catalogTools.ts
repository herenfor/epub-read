import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CATALOGS, EN_FILES, ZH_TW_FILES } from "../../src/ui/localization/catalog";

export const ROOT = join(import.meta.dirname, "../..");
export const EN_DIR = join(ROOT, "src/ui/localization/en");

/** Translated locales; "zh-CN" is the source and lives in catalogs/. */
export type TargetLocale = "en" | "zh-TW";
export const TARGETS: Record<TargetLocale, { dir: string; files: Readonly<Record<string, Readonly<Record<string, string>>>>; field: "en" | "zhTW"; name: string }> = {
  en: { dir: EN_DIR, files: EN_FILES, field: "en", name: "English" },
  "zh-TW": { dir: join(ROOT, "src/ui/localization/zh-TW"), files: ZH_TW_FILES, field: "zhTW", name: "Traditional Chinese" },
};

/** Reads `--locale <en|zh-TW>` (default en) and returns the remaining arguments. */
export function takeLocale(args: string[]): { locale: TargetLocale; rest: string[] } {
  const at = args.indexOf("--locale");
  if (at < 0) return { locale: "en", rest: args };
  const value = args[at + 1];
  if (value !== "en" && value !== "zh-TW") {
    console.error("--locale must be en or zh-TW");
    process.exit(2);
  }
  return { locale: value, rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}

export interface ExportEntry {
  key: string;
  zh: string;
  en: string;
  zhTW: string;
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
      // Catalog sources/data define keys rather than use them.
      if (!path.endsWith("localization/catalogs") && !path.endsWith("localization/en") && name !== "node_modules") sourceFiles(path, out);
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
        // tn("x.count", n) uses "x.count.one" / "x.count.other".
        for (const form of ["one", "other"]) {
          const plural = `${match[1]}.${form}`;
          index.set(plural, [...(index.get(plural) ?? []), `${relative(ROOT, file)}:${row + 1}`]);
        }
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
      zhTW: ZH_TW_FILES[catalog.namespace][key] ?? "",
      placeholders: placeholdersOf(meta.zh),
      ...(meta.note ? { note: meta.note } : {}),
      ...(meta.max ? { max: meta.max } : {}),
      usedIn: usage.get(key) ?? [],
    })),
  }));
}
