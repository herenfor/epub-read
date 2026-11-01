/**
 * Shelf cover object URLs kept across shelf remounts. The shelf unmounts while
 * a book is open; without this every cover reads its cached thumbnail again on
 * return and shows the fallback for a moment. Thumbnails are bounded
 * (240x360), so a small byte budget holds a few screens of covers. A URL still
 * shown by a mounted cover is never revoked.
 */
const COVER_URL_BUDGET_BYTES = 3 * 1024 * 1024;

interface CoverUrlEntry {
  url: string;
  bytes: number;
  users: number;
}

const entries = new Map<string, CoverUrlEntry>();
let totalBytes = 0;

function touch(key: string, entry: CoverUrlEntry): void {
  entries.delete(key);
  entries.set(key, entry);
}

function evict(): void {
  if (totalBytes <= COVER_URL_BUDGET_BYTES) return;
  // Map order is least recently used first.
  for (const [key, entry] of entries) {
    if (totalBytes <= COVER_URL_BUDGET_BYTES) break;
    if (entry.users > 0) continue;
    entries.delete(key);
    totalBytes -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  }
}

export interface HeldCoverUrl {
  url: string;
  release: () => void;
}

function hold(key: string, entry: CoverUrlEntry): HeldCoverUrl {
  entry.users += 1;
  touch(key, entry);
  let released = false;
  return {
    url: entry.url,
    release: () => {
      if (released) return;
      released = true;
      entry.users -= 1;
      if (entries.get(key) === entry) evict();
    },
  };
}

/** The cached URL for a cover without holding it, for a first render. */
export function peekCoverUrl(key: string): string | null {
  return entries.get(key)?.url ?? null;
}

/** The cached URL for a cover, held for the caller until it calls release. */
export function acquireCoverUrl(key: string): HeldCoverUrl | null {
  const entry = entries.get(key);
  return entry ? hold(key, entry) : null;
}

/** Takes ownership of a freshly made URL and holds it for the caller. */
export function storeCoverUrl(key: string, url: string, bytes: number): HeldCoverUrl {
  const existing = entries.get(key);
  if (existing) {
    // Another cover with the same key finished first; keep that one.
    URL.revokeObjectURL(url);
    return hold(key, existing);
  }
  const entry: CoverUrlEntry = { url, bytes, users: 0 };
  entries.set(key, entry);
  totalBytes += bytes;
  const held = hold(key, entry);
  evict();
  return held;
}

export function coverUrlCacheSize(): { count: number; bytes: number } {
  return { count: entries.size, bytes: totalBytes };
}

export function clearCoverUrlCacheForTests(): void {
  for (const entry of entries.values()) URL.revokeObjectURL(entry.url);
  entries.clear();
  totalBytes = 0;
}

export { COVER_URL_BUDGET_BYTES };
