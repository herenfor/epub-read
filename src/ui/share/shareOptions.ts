// Device-local share card choices (ER-0119): the last look, size and switches.
// Never part of note data, archives or sync.
import { useCallback, useState } from "react";
import { DEFAULT_SHARE_OPTIONS, SHARE_RATIOS, SHARE_TEMPLATES, type ShareCardOptions } from "./shareCardModel";

const KEY = "epub-reader:share-options-v1";

/** Anything malformed falls back field by field; a missing store reads as defaults. */
export function parseShareOptions(raw: string | null): ShareCardOptions {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
  } catch { /* defaults */ }
  const flag = (key: keyof ShareCardOptions) => typeof value[key] === "boolean" ? value[key] as boolean : DEFAULT_SHARE_OPTIONS[key] as boolean;
  return {
    template: SHARE_TEMPLATES.includes(value.template as never) ? value.template as ShareCardOptions["template"] : DEFAULT_SHARE_OPTIONS.template,
    ratio: SHARE_RATIOS.includes(value.ratio as never) ? value.ratio as ShareCardOptions["ratio"] : DEFAULT_SHARE_OPTIONS.ratio,
    showNote: flag("showNote"),
    showCover: flag("showCover"),
    showChapter: flag("showChapter"),
    showBrand: flag("showBrand"),
  };
}

export function readShareOptions(): ShareCardOptions {
  try {
    return parseShareOptions(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_SHARE_OPTIONS;
  }
}

export function writeShareOptions(options: ShareCardOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(options));
  } catch { /* storage unavailable: keep for this session only */ }
}

export function useShareOptions() {
  const [options, setOptions] = useState(readShareOptions);
  const update = useCallback((patch: Partial<ShareCardOptions>) => {
    setOptions((current) => {
      const next = { ...current, ...patch };
      writeShareOptions(next);
      return next;
    });
  }, []);
  return { shareOptions: options, updateShareOptions: update };
}
