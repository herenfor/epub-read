import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const edition = (process.argv[2] ?? process.env.VITE_EDITION ?? "core").toLowerCase();
if (!new Set(["core", "ai"]).has(edition)) throw new Error("edition must be core or ai");
const outDir = join(process.cwd(), "dist", edition === "ai" ? "ai" : "core");
const files = [];
const walk = (dir) => { for (const name of readdirSync(dir)) { const p = join(dir, name); const s = statSync(p); if (s.isDirectory()) walk(p); else files.push(p); } };
if (!existsSync(outDir)) throw new Error(`missing ${outDir}`);
walk(outDir);
if (!existsSync(join(outDir, "edition-manifest.json"))) throw new Error("missing edition-manifest.json");
const manifest = JSON.parse(readFileSync(join(outDir, "edition-manifest.json"), "utf8"));
const expected = { schemaVersion: 1, edition, version: JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version, expectedBackendFeature: edition, identifier: edition === "ai" ? "dev.epubreader.ai" : "dev.epubreader.app" };
for (const [key, value] of Object.entries(expected)) if (manifest[key] !== value) throw new Error(`edition manifest mismatch: ${key}`);
const fileNames = files.map((p) => p.slice(outDir.length + 1)).join("\n");
const text = files.filter((p) => /\.(js|css|html|json)$/.test(p)).map((p) => readFileSync(p, "utf8")).join("\n");
const has = (needle) => text.includes(needle);
if (edition === "core") {
  for (const needle of ["c57-dev-probe", "ai_model_", "ModelAssetsDevelopmentSection", "AiFoundationPanel", "ai-foundation-panel", ".ai-foundation-", ".model-assets-", "dev.epubreader.ai", "EPUB Reader AI"]) if (has(needle) || fileNames.includes(needle)) throw new Error(`Core artifact contains AI marker: ${needle}`);
  if (!has("corpusWorker")) throw new Error("Core artifact is missing corpusWorker");
} else {
  if (!existsSync(join(outDir, "c57-dev-probe", "probe.txt"))) throw new Error("AI artifact is missing the AI development probe");
  for (const needle of ["AiFoundationPanel", "ai-foundation-panel", ".ai-foundation-", ".model-assets-", "ai_model_"]) if (!has(needle) && !fileNames.includes(needle)) throw new Error(`AI artifact is missing marker: ${needle}`);
  if (!has("corpusWorker")) throw new Error("AI artifact is missing corpusWorker");
}
const artifactManifest = { schemaVersion: 1, profile: edition, identifier: expected.identifier, expectedBackendFeature: expected.expectedBackendFeature, tauriConfig: `src-tauri/tauri.${edition}.conf.json`, targetDir: `src-tauri/target-${edition}` };
writeFileSync(join(outDir, "artifact-manifest.json"), JSON.stringify(artifactManifest, null, 2) + "\n", "utf8");
console.log(`PASS: ${edition} frontend artifact (${outDir})`);
