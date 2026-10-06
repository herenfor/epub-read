import { compileReplacementStage, type Projection, type Replacement } from "./core";
import type { TextProjectionMode } from "./types";

/** Frozen upstream revision used by both preset directions. */
export const OPENCC_COMMIT = "3ac34aa439a9908dd49fa92b5174b46314787ac2";
export const OPENCC_LICENSE = "Apache-2.0";
export const OPENCC_SOURCE = "https://github.com/BYVoid/OpenCC";

type Stage = (source: string) => Projection;
type DictionaryLoader = () => Promise<string>;

const loaders: Record<Exclude<TextProjectionMode, "original">, DictionaryLoader> = {
  simplified: () => import("./data/t2s").then((module) => module.default),
  traditional: () => import("./data/s2t").then((module) => module.default),
};

type StagePromise = Promise<Stage>;

const stagePromises = new Map<Exclude<TextProjectionMode, "original">, StagePromise>();

/** Parse generated OpenCC rows. Later duplicate keys are ignored, matching phrase-first data order. */
export function parseOpenCCDictionary(data: string): Replacement[] {
  const rules: Replacement[] = [];
  for (const line of data.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const from = line.slice(0, tab);
    const candidates = line.slice(tab + 1).trim().split(/\s+/u);
    const to = candidates[0] ?? "";
    if (from.trim().length === 0 || to.trim().length === 0) continue;
    rules.push({ from, to });
  }
  return rules;
}

/**
 * Load and compile the fixed OpenCC subset once per direction. The dynamic
 * import keeps the dictionary out of the original-mode bundle until the user
 * actually enables a preset conversion.
 */
export function loadOpenCCStage(mode: Exclude<TextProjectionMode, "original">): Promise<Stage> {
  const cached = stagePromises.get(mode);
  if (cached) return cached;
  const pending = loaders[mode]().then((data) =>
    compileReplacementStage(parseOpenCCDictionary(data))
  );
  stagePromises.set(mode, pending);
  void pending.catch(() => {
    if (stagePromises.get(mode) === pending) stagePromises.delete(mode);
  });
  return pending;
}

export function clearOpenCCStageCacheForTests(): void {
  stagePromises.clear();
}
