// Web search for the selected text (ER-0181). The engine is a device-local
// preference, like the highlight preferences: never part of sync or archives.
import { useCallback, useState } from "react";

export const SELECTION_SEARCH_ENGINES = ["bing", "google", "baidu"] as const;
export type SelectionSearchEngine = typeof SELECTION_SEARCH_ENGINES[number];

const KEY = "epub-reader:selection-search-engine";
/** Longer selections are cut: engines reject or ignore very long queries. */
const MAX_QUERY_CHARS = 120;

const URLS: Record<SelectionSearchEngine, string> = {
  bing: "https://www.bing.com/search?q=",
  google: "https://www.google.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
};

export function isSelectionSearchEngine(value: unknown): value is SelectionSearchEngine {
  return (SELECTION_SEARCH_ENGINES as readonly unknown[]).includes(value);
}

/** The search page for a selection; null when nothing searchable is selected. */
export function selectionSearchUrl(text: string, engine: SelectionSearchEngine): string | null {
  const query = Array.from(text.replace(/\s+/g, " ").trim()).slice(0, MAX_QUERY_CHARS).join("");
  return query ? URLS[engine] + encodeURIComponent(query) : null;
}

export function readSelectionSearchEngine(): SelectionSearchEngine {
  try {
    const stored = localStorage.getItem(KEY);
    if (isSelectionSearchEngine(stored)) return stored;
  } catch { /* default */ }
  return "bing";
}

export function useSelectionSearchEngine() {
  const [engine, setEngine] = useState(readSelectionSearchEngine);
  const choose = useCallback((next: SelectionSearchEngine) => {
    setEngine(next);
    try {
      localStorage.setItem(KEY, next);
    } catch { /* storage unavailable: keep for this session only */ }
  }, []);
  return [engine, choose] as const;
}
