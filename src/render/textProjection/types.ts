import type { Replacement } from "./core";

export type TextProjectionMode = "original" | "simplified" | "traditional";

/** Persistent user-facing replacement rule. */
export interface TextProjectionRule extends Replacement {
  id: string;
  enabled: boolean;
}

export interface TextProjectionPreferences {
  mode: TextProjectionMode;
  /** Ordered. Match longest from first, then list order for equal lengths. */
  rules: TextProjectionRule[];
}

export const DEFAULT_TEXT_PROJECTION_PREFERENCES: TextProjectionPreferences = {
  mode: "original",
  rules: [],
};

export function isTextProjectionMode(value: unknown): value is TextProjectionMode {
  return value === "original" || value === "simplified" || value === "traditional";
}
