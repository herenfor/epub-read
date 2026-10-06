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

/**
 * Compile presets first, then enabled custom rules. The result is immutable;
 * callers reuse it for every text node in one document snapshot.
 */
export async function compileTextProjection(
  value: TextProjectionPreferences,
): Promise<CompiledTextProjection> {
  const preferences = sanitizeTextProjectionPreferences(value);
  const stages: Array<(source: string) => Projection> = [];
  if (preferences.mode !== "original") {
    stages.push(await loadOpenCCStage(preferences.mode));
  }
  const custom = enabledReplacementRules(preferences.rules);
  if (custom.length > 0) stages.push(compileReplacementStage(custom));
  return {
    version: `${preferences.mode}:${stableRules(preferences)}`,
    stages,
    preferences,
  };
}

/** Project raw text with an already-compiled snapshot. */
export function projectText(source: string, compiled: CompiledTextProjection): string {
  return projectPipeline(source, compiled.stages).display;
}
