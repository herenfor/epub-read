import { summarizeLinearCounts, type ChapterCountCollection } from "./chapterCounts";

const CACHE_KEY = "epub-reader-chapter-counts-v1";
const CACHE_VERSION = 1;
const MAX_ENTRIES = 256;
const MAX_TOTAL_COUNTS = 100_000;

interface CacheRecord {
  linear: boolean[];
  counts: Array<number | null>;
  touchedAt: number;
  /** Local display metadata; never part of a portable progress record. */
  progressKnown?: boolean;
}

interface CacheState {
  version: number;
  entries: Record<string, CacheRecord>;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readState(): CacheState {
  const store = storage();
  if (!store) return { version: CACHE_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(store.getItem(CACHE_KEY) ?? "null") as Partial<CacheState> | null;
    if (!parsed || parsed.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: CACHE_VERSION, entries: {} };
    }
    const entries: Record<string, CacheRecord> = {};
    let total = 0;
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!value || !Array.isArray(value.linear) || !Array.isArray(value.counts)) continue;
      if (value.linear.length !== value.counts.length || value.linear.length > MAX_TOTAL_COUNTS) continue;
      if (!value.linear.every((item) => typeof item === "boolean")) continue;
      if (!value.counts.every((item) => item === null || validCount(item))) continue;
      total += value.counts.length;
      if (total > MAX_TOTAL_COUNTS) break;
      entries[key] = {
        linear: [...value.linear],
        counts: [...value.counts],
        touchedAt: typeof value.touchedAt === "number" && Number.isFinite(value.touchedAt) ? value.touchedAt : 0,
        progressKnown: typeof value.progressKnown === "boolean" ? value.progressKnown : undefined,
      };
    }
    return { version: CACHE_VERSION, entries };
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

function writeState(state: CacheState): void {
  try {
    storage()?.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    // Cache is an optimization. Quota/security errors must never block reading.
  }
}

/** Return only validated cached estimates matching the current linear mask. */
export function readCachedChapterCounts(
  key: string | null,
  linear: readonly boolean[],
): Map<number, number> {
  if (!key) return new Map();
  const state = readState();
  const record = state.entries[key];
  if (!record || record.linear.length !== linear.length || record.counts.length !== linear.length) return new Map();
  if (record.linear.some((value, index) => value !== linear[index])) return new Map();
  const result = new Map<number, number>();
  record.counts.forEach((value, index) => {
    if (linear[index] && validCount(value)) result.set(index, value);
  });
  return result;
}

/** Read once per shelf projection, rather than parsing storage for every card. */
export function readKnownChapterProgressKeys(): ReadonlySet<string> {
  const known = new Set<string>();
  for (const [key, record] of Object.entries(readState().entries)) {
    const complete = record.linear.every((linear, index) => !linear || validCount(record.counts[index]));
    const nonempty = record.linear.some((linear, index) => linear && (record.counts[index] ?? 0) > 0);
    if (record.progressKnown ?? (complete && nonempty)) known.add(key);
  }
  return known;
}

/**
 * Persist structural estimates only. A measured/error/unknown result must not
 * erase an older structural estimate for the same chapter: it remains useful
 * as a provisional baseline for the next open.
 */
export function writeChapterCountCache(
  key: string | null,
  collection: ChapterCountCollection,
  structural: ChapterCountCollection = collection,
): void {
  if (!key) return;
  const state = readState();
  const previous = state.entries[key];
  const previousMatches = Boolean(
    previous &&
    previous.linear.length === collection.linear.length &&
    previous.counts.length === collection.linear.length &&
    previous.linear.every((value, index) => value === collection.linear[index])
  );
  const counts: Array<number | null> = structural.counts.map((item, index) => {
    if (!collection.linear[index]) return null;
    if (item.source === "estimated" && validCount(item.value)) return item.value;
    return previousMatches && previous?.counts[index] !== null && validCount(previous?.counts[index])
      ? previous.counts[index]
      : null;
  });
  const summary = summarizeLinearCounts(collection, 0);
  state.entries[key] = {
    linear: [...collection.linear],
    counts,
    touchedAt: Date.now(),
    progressKnown: summary.complete && summary.total > 0,
  };
  const entries = Object.entries(state.entries)
    .sort(([, a], [, b]) => b.touchedAt - a.touchedAt)
    .slice(0, MAX_ENTRIES);
  let total = 0;
  const bounded: Record<string, CacheRecord> = {};
  for (const [entryKey, value] of entries) {
    if (total + value.counts.length > MAX_TOTAL_COUNTS) continue;
    bounded[entryKey] = value;
    total += value.counts.length;
  }
  state.entries = bounded;
  writeState(state);
}

export const chapterCountCacheLimits = { maxEntries: MAX_ENTRIES, maxTotalCounts: MAX_TOTAL_COUNTS } as const;
