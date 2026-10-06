import { compileReplacementStage, projectPipeline, type Projection } from "./core";
import { loadOpenCCStage } from "./opencc";
import { enabledReplacementRules, sanitizeTextProjectionPreferences } from "./preferences";
import type { TextProjectionPreferences } from "./types";

export interface CompiledTextProjection {
  /** Stable identity for display search caches and cancel tokens. */
  readonly version: string;
  readonly stages: ReadonlyArray<(source: string) => Projection>;
  readonly preferences: TextProjectionPreferences;
}

function stableRules(preferences: TextProjectionPreferences): string {
  return JSON.stringify(
    enabledReplacementRules(preferences.rules).map((rule) => [rule.from, rule.to] as const),
  );
}

/** Sync identity used by paginator prepare keys, display search cache and getters. */
export function textProjectionVersion(value: TextProjectionPreferences): string {
  const preferences = sanitizeTextProjectionPreferences(value);
  return `${preferences.mode}:${stableRules(preferences)}`;
}

/** True when no conversion stage is active and the original document path can be reused. */
export function isIdentityTextProjection(value: TextProjectionPreferences): boolean {
  const preferences = sanitizeTextProjectionPreferences(value);
  return preferences.mode === "original" && enabledReplacementRules(preferences.rules).length === 0;
}

const MAX_COMPILED_CACHE_ENTRIES = 4;
const compiledCache = new Map<string, Promise<CompiledTextProjection>>();

/**
 * Compile presets first, then enabled custom rules. The result is immutable
 * and shared by every page/preload paginator and display search using the same
 * stable version. Disabled rules do not create a second trie.
 */
export function compileTextProjection(
  value: TextProjectionPreferences,
): Promise<CompiledTextProjection> {
  const preferences = sanitizeTextProjectionPreferences(value);
  const version = textProjectionVersion(preferences);
  const cached = compiledCache.get(version);
  if (cached) {
    // Map insertion order is the tiny LRU: a hit moves to the newest end.
    compiledCache.delete(version);
    compiledCache.set(version, cached);
    return cached;
  }
  const pending = (async () => {
    const stages: Array<(source: string) => Projection> = [];
    if (preferences.mode !== "original") {
      stages.push(await loadOpenCCStage(preferences.mode));
    }
    const custom = enabledReplacementRules(preferences.rules);
    if (custom.length > 0) stages.push(compileReplacementStage(custom));
    return { version, stages, preferences };
  })();
  compiledCache.set(version, pending);
  while (compiledCache.size > MAX_COMPILED_CACHE_ENTRIES) {
    const oldest = compiledCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    compiledCache.delete(oldest);
  }
  void pending.catch(() => {
    if (compiledCache.get(version) === pending) compiledCache.delete(version);
  });
  return pending;
}

/** Project raw text with an already-compiled snapshot. */
export function projectText(source: string, compiled: CompiledTextProjection): string {
  return projectPipeline(source, compiled.stages).display;
}

export function clearTextProjectionCacheForTests(): void {
  compiledCache.clear();
}
