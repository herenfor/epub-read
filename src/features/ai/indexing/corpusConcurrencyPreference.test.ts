import { describe, expect, it, vi } from "vitest";
import {
  CORPUS_CONCURRENCY_STORAGE_KEY,
  loadCorpusConcurrencyPreference,
  normalizeCorpusConcurrencyPreference,
  resolveCorpusConcurrency,
  saveCorpusConcurrencyPreference,
} from "./corpusConcurrencyPreference";

describe("corpus concurrency preference", () => {
  it("defaults to automatic and resolves from logical cores", () => {
    const preference = normalizeCorpusConcurrencyPreference(undefined, 16);
    expect(preference.mode).toBe("automatic");
    expect(resolveCorpusConcurrency(preference, 16)).toBe(6);
  });

  it("clamps a manual device setting below reserved cores and the hard cap", () => {
    const preference = normalizeCorpusConcurrencyPreference({ mode: "manual", maxConcurrency: 99 }, 8);
    expect(preference).toEqual({ mode: "manual", maxConcurrency: 7 });
    expect(resolveCorpusConcurrency(preference, 8)).toBe(7);
  });

  it("recovers invalid local JSON and writes only device-local configuration", () => {
    const getItem = vi.fn(() => "{");
    expect(loadCorpusConcurrencyPreference({ getItem }, 12).mode).toBe("automatic");
    const setItem = vi.fn();
    saveCorpusConcurrencyPreference({ mode: "manual", maxConcurrency: 4 }, { setItem });
    expect(setItem).toHaveBeenCalledWith(CORPUS_CONCURRENCY_STORAGE_KEY, JSON.stringify({ mode: "manual", maxConcurrency: 4 }));
  });
});
