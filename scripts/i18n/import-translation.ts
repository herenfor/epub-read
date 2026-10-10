/**
 * Merge translated English back into src/ui/localization/en/<namespace>.json.
 *   npx tsx scripts/i18n/import-translation.ts <file.json>... [--dry-run]
 * Accepts the exported shape ({ namespace, entries: [{ key, en }] }) or a flat
 * { "key": "English" } map. Unknown keys, changed placeholders and empty text
 * are rejected; nothing is written if any file has errors.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, EN_FILES } from "../../src/ui/localization/catalog";
import { EN_DIR, placeholdersOf } from "./catalogTools";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const files = args.filter((arg) => !arg.startsWith("--"));
if (files.length === 0) {
  console.error("usage: import-translation.ts <file.json>... [--dry-run]");
  process.exit(2);
}

const owner = new Map<string, { namespace: string; zh: string }>();
for (const catalog of CATALOGS) {
  for (const [key, zh] of Object.entries(catalog.zh as Record<string, string>)) owner.set(key, { namespace: catalog.namespace, zh });
}

const updates = new Map<string, Record<string, string>>();
const errors: string[] = [];
let accepted = 0;
for (const file of files) {
  const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const pairs: Array<[string, unknown]> = Array.isArray((data as { entries?: unknown }).entries)
    ? ((data as { entries: Array<{ key: string; en: unknown }> }).entries).map((entry) => [entry.key, entry.en])
    : Object.entries(data as Record<string, unknown>);
  for (const [key, value] of pairs) {
    const source = owner.get(key);
    if (!source) { errors.push(`${file}: unknown key ${key}`); continue; }
    if (typeof value !== "string" || value.trim() === "") { errors.push(`${file}: ${key} has no English text`); continue; }
    const expected = placeholdersOf(source.zh).join(",");
    const actual = placeholdersOf(value).join(",");
    if (expected !== actual) { errors.push(`${file}: ${key} placeholders {${actual}} must be {${expected}}`); continue; }
    if (/<\/?[a-z][^>]*>/i.test(value)) { errors.push(`${file}: ${key} contains markup; UI text is plain text`); continue; }
    const target = updates.get(source.namespace) ?? {};
    target[key] = value.trim();
    updates.set(source.namespace, target);
    accepted += 1;
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} problem(s); nothing written.`);
  process.exit(1);
}

for (const [namespace, changes] of updates) {
  const merged = { ...EN_FILES[namespace], ...changes };
  // Keep the Chinese catalog's order so diffs stay readable.
  const catalog = CATALOGS.find((entry) => entry.namespace === namespace)!;
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(catalog.zh)) if (merged[key]) ordered[key] = merged[key];
  if (!dryRun) writeFileSync(join(EN_DIR, `${namespace}.json`), `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(`${namespace}: ${Object.keys(changes).length} updated`);
}
console.log(`${accepted} entr${accepted === 1 ? "y" : "ies"} accepted${dryRun ? " (dry run, nothing written)" : ""}.`);
