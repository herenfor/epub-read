/** A large EPUB is deliberately isolated to avoid multiplying decompression memory. */
export const LARGE_BOOK_BYTES = 512 * 1024 * 1024;

export type CorpusConcurrencyMode = "auto" | "manual";

export interface CorpusConcurrencyOptions {
  mode?: CorpusConcurrencyMode;
  /** The local device setting. `auto` is used when omitted. */
  maxConcurrency?: number;
  logicalCores?: number;
  hardCap?: number;
}

/**
 * Select the worker budget without depending on React, Tauri or persistence.
 * The value is a cap, not a promise that all workers will be busy.
 */
export function calculateCorpusConcurrency(options: CorpusConcurrencyOptions = {}): number {
  const logicalCores = positiveInteger(options.logicalCores, detectLogicalCores());
  const manualCap = Math.min(16, Math.max(1, logicalCores - 1));
  const hardCap = positiveInteger(options.hardCap, 16);
  const automatic = logicalCores <= 4
    ? 1
    : logicalCores <= 8
    ? 2
    : logicalCores <= 12
    ? 4
    : logicalCores <= 16
    ? 6
    : 8;
  if (options.mode === "manual") {
    return Math.min(hardCap, manualCap, positiveInteger(options.maxConcurrency, 1));
  }
  return Math.min(hardCap, automatic, manualCap);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const result = Math.floor(value ?? fallback);
  return Number.isFinite(result) && result > 0 ? result : fallback;
}

function detectLogicalCores(): number {
  const value = typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;
  return positiveInteger(value, 1);
}
