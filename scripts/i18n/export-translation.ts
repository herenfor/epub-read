/**
 * Write one JSON file per UI catalog for a translator.
 *   npx tsx scripts/i18n/export-translation.ts <out-dir> [--missing]
 * --missing keeps only entries without English yet.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exportEntries } from "./catalogTools";

const [outArg, ...flags] = process.argv.slice(2);
if (!outArg) {
  console.error("usage: export-translation.ts <out-dir> [--missing]");
  process.exit(2);
}
const out = resolve(outArg);
const onlyMissing = flags.includes("--missing");
mkdirSync(out, { recursive: true });

const summary: Array<{ namespace: string; total: number; exported: number }> = [];
for (const { namespace, entries } of exportEntries()) {
  const chosen = onlyMissing ? entries.filter((entry) => entry.en.trim() === "") : entries;
  summary.push({ namespace, total: entries.length, exported: chosen.length });
  if (chosen.length === 0) continue;
  writeFileSync(join(out, `${namespace}.json`), `${JSON.stringify({ namespace, entries: chosen }, null, 2)}\n`);
}
writeFileSync(join(out, "index.json"), `${JSON.stringify(summary, null, 2)}\n`);
for (const row of summary) console.log(`${row.namespace.padEnd(16)} ${row.exported}/${row.total}`);
