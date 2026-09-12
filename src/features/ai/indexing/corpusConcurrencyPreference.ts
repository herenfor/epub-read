import { calculateCorpusConcurrency } from "./corpusConcurrency";

export const CORPUS_CONCURRENCY_STORAGE_KEY = "epub-reader:corpus-concurrency:v1";
export type CorpusConcurrencyPreferenceMode = "automatic" | "manual";

export interface CorpusConcurrencyPreference {
  mode: CorpusConcurrencyPreferenceMode;
  maxConcurrency: number;
}

export function detectedLogicalCores(): number {
  const value = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

export function normalizeCorpusConcurrencyPreference(
  value: unknown,
  logicalCores = detectedLogicalCores(),
): CorpusConcurrencyPreference {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mode: CorpusConcurrencyPreferenceMode = record.mode === "manual" ? "manual" : "automatic";
  const requested = typeof record.maxConcurrency === "number" ? record.maxConcurrency : 1;
  const maxConcurrency = calculateCorpusConcurrency({ mode: "manual", maxConcurrency: requested, logicalCores });
  return { mode, maxConcurrency };
}

export function resolveCorpusConcurrency(
  preference: CorpusConcurrencyPreference,
  logicalCores = detectedLogicalCores(),
): number {
  return calculateCorpusConcurrency({
    mode: preference.mode === "manual" ? "manual" : "auto",
    maxConcurrency: preference.maxConcurrency,
    logicalCores,
  });
}

export function loadCorpusConcurrencyPreference(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
  logicalCores = detectedLogicalCores(),
): CorpusConcurrencyPreference {
  if (!storage) return normalizeCorpusConcurrencyPreference(undefined, logicalCores);
  try {
    return normalizeCorpusConcurrencyPreference(JSON.parse(storage.getItem(CORPUS_CONCURRENCY_STORAGE_KEY) ?? "null"), logicalCores);
  } catch {
    return normalizeCorpusConcurrencyPreference(undefined, logicalCores);
  }
}

export function saveCorpusConcurrencyPreference(
  preference: CorpusConcurrencyPreference,
  storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
): void {
  storage?.setItem(CORPUS_CONCURRENCY_STORAGE_KEY, JSON.stringify(preference));
}
