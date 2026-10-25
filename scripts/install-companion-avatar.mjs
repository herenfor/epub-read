import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error("Usage: node scripts/install-companion-avatar.mjs <model-directory> [display-name]");
const localRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.ai-companion-local");
const destination = resolve(localRoot, "avatar");
const sourceFile = file => {
  const path = resolve(source, file);
  if (isAbsolute(file) || !path.startsWith(source + sep)) throw new Error(`Model reference leaves its directory: ${file}`);
  return path;
};
const contract = JSON.parse(readFileSync(sourceFile("airi-interface.json"), "utf8"));
if (contract.version !== 1) throw new Error("Only airi-interface.json version 1 is supported");
const model = JSON.parse(readFileSync(sourceFile(contract.model), "utf8"));
const refs = model.FileReferences;
const modelDirectory = dirname(contract.model);
// Resolve resources relative to model3.json, preserving the exported directory layout.
const relativeResource = file => {
  const path = resolve(source, modelDirectory, file);
  if (!path.startsWith(source + sep)) throw new Error(`Model reference leaves its directory: ${file}`);
  return path.slice(source.length + 1);
};
const files = new Set(["airi-interface.json", contract.model,
  ...[refs.Moc, ...refs.Textures, refs.Physics, refs.DisplayInfo, refs.Pose, refs.UserData,
    ...(refs.Expressions ?? []).map(item => item.File),
    ...Object.values(refs.Motions ?? {}).flatMap(items => items.flatMap(item => [item.File, item.Sound]))]
    .filter(Boolean).map(relativeResource)]);
const expressionNames = new Set((refs.Expressions ?? []).map(item => item.Name));
const motionFiles = new Set(Object.values(refs.Motions ?? {}).flatMap(items => items.map(item => item.File)));
if (!contract.emotions[contract.defaultEmotion] || !refs.Motions?.[contract.idleMotionGroup]?.length) {
  throw new Error("The interface must name an existing default emotion and idle motion group");
}
for (const [name, emotion] of Object.entries(contract.emotions)) {
  if (!expressionNames.has(emotion.expression) || !expressionNames.has(emotion.speakingExpression)
    || (emotion.motion && !motionFiles.has(emotion.motion))) throw new Error(`Unresolved emotion: ${name}`);
}
if (existsSync(sourceFile("README.md"))) files.add("README.md");
// Validate every reference before copying; publish the selected avatar only after all files exist.
for (const file of files) if (!existsSync(sourceFile(file))) throw new Error(`Missing model resource: ${file}`);
for (const file of files) {
  const path = resolve(destination, file);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(sourceFile(file), path);
}
const name = process.argv[3] || "Local Live2D";
writeFileSync(resolve(localRoot, "avatar.json"), JSON.stringify({ name, interface: "avatar/airi-interface.json" }, null, 2) + "\n");
console.log(`Installed ${name}: ${files.size} files, ${Object.keys(contract.emotions).length} emotions. Source export unchanged.`);
