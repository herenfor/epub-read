import {
  DEFAULT_TEXT_PROJECTION_PREFERENCES,
  isTextProjectionMode,
  type TextProjectionMode,
  type TextProjectionPreferences,
  type TextProjectionRule,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.trim().length === 0) return null;
  return value;
}

function cleanRule(value: unknown, index: number): TextProjectionRule | null {
  if (!isRecord(value)) return null;
  const from = cleanText(value.from);
  const to = cleanText(value.to);
  if (from === null || to === null) return null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : `rule-${index + 1}`;
  return { id, from, to, enabled: value.enabled !== false };
}

function cleanMode(value: unknown, fallback: TextProjectionMode): TextProjectionMode {
  return isTextProjectionMode(value) ? value : fallback;
}

/** Invalid/old local values are dropped at the boundary; never throw in rendering. */
export function sanitizeTextProjectionPreferences(
  value: unknown,
  fallback: TextProjectionPreferences = DEFAULT_TEXT_PROJECTION_PREFERENCES,
): TextProjectionPreferences {
  if (!isRecord(value)) return { ...fallback, rules: [...fallback.rules] };
  const rules: TextProjectionRule[] = [];
  if (Array.isArray(value.rules)) {
    value.rules.forEach((candidate, index) => {
      const rule = cleanRule(candidate, index);
      if (rule) rules.push(rule);
    });
  }
  return {
    mode: cleanMode(value.mode, fallback.mode),
    rules,
  };
}

/** Rule ids whose `from` appears more than once. The first occurrence is authoritative. */
export function duplicateRuleIds(rules: readonly TextProjectionRule[]): Set<string> {
  const firstByFrom = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const rule of rules) {
    const previous = firstByFrom.get(rule.from);
    if (previous === undefined) firstByFrom.set(rule.from, rule.id);
    else duplicates.add(rule.id);
  }
  return duplicates;
}

export function enabledReplacementRules(rules: readonly TextProjectionRule[]) {
  return rules.filter((rule) => rule.enabled && rule.from.trim().length > 0 && rule.to.trim().length > 0);
}
