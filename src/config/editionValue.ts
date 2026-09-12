export type AppEdition = "core" | "ai";

export function normalizeAppEdition(value: string | undefined): AppEdition {
  if (value === undefined) return "core";
  const normalized = value.trim().toLowerCase();
  if (normalized === "core" || normalized === "ai") return normalized;
  throw new Error(`Invalid VITE_EDITION: ${value}. Expected core or ai.`);
}
