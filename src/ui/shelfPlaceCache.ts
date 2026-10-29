const CACHE_KEY = "epub-reader-shelf-place-v1";
const MAX_ENTRIES = 256;
const MAX_LABEL = 120;

/** The table-of-contents name of the last place read, so the shelf can say "Chapter 3 …" instead of a file number. */
interface PlaceRecord {
  spineIndex: number;
  label: string;
  touchedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readEntries(): Record<string, PlaceRecord> {
  try {
    const parsed = JSON.parse(storage()?.getItem(CACHE_KEY) ?? "null") as Record<string, Partial<PlaceRecord>> | null;
    if (!parsed || typeof parsed !== "object") return {};
    const entries: Record<string, PlaceRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || !Number.isSafeInteger(value.spineIndex) || (value.spineIndex as number) < 0) continue;
      if (typeof value.label !== "string" || !value.label) continue;
      entries[key] = {
        spineIndex: value.spineIndex as number,
        label: value.label.slice(0, MAX_LABEL),
        touchedAt: typeof value.touchedAt === "number" && Number.isFinite(value.touchedAt) ? value.touchedAt : 0,
      };
    }
    return entries;
  } catch {
    return {};
  }
}

/** The cached chapter name, only when it still describes the shelf's saved position. */
export function readShelfPlaceLabel(key: string | null, spineIndex: number): string | null {
  if (!key) return null;
  const record = readEntries()[key];
  return record && record.spineIndex === spineIndex ? record.label : null;
}

/** Local display metadata only; an empty label (cover, front matter) clears the entry. */
export function writeShelfPlaceLabel(key: string | null, spineIndex: number, label: string): void {
  if (!key) return;
  const entries = readEntries();
  const trimmed = label.trim().slice(0, MAX_LABEL);
  const previous = entries[key];
  if (!trimmed) {
    if (!previous) return;
    delete entries[key];
  } else {
    if (previous && previous.spineIndex === spineIndex && previous.label === trimmed) return;
    entries[key] = { spineIndex, label: trimmed, touchedAt: Date.now() };
  }
  const bounded = Object.fromEntries(Object.entries(entries)
    .sort(([, a], [, b]) => b.touchedAt - a.touchedAt)
    .slice(0, MAX_ENTRIES));
  try {
    storage()?.setItem(CACHE_KEY, JSON.stringify(bounded));
  } catch {
    // An optimization only: quota or security errors must never block reading.
  }
}
