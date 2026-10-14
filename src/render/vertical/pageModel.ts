/** Vertical-rl text flows towards increasing logical distance, while native
 * scrollLeft is negative. Pure page geometry; never persists pixel positions. */
export interface VerticalInterval { readonly start: number; readonly end: number }
export interface VerticalPage extends VerticalInterval { readonly blankAfter: number }
export type VerticalPageModel =
  | { readonly kind: "empty"; readonly pageWidth: number; readonly extent: 0; readonly pages: readonly [] }
  | { readonly kind: "unsupported"; readonly reason: "wide-group"; readonly group: VerticalInterval; readonly pageWidth: number }
  | { readonly kind: "ready"; readonly pageWidth: number; readonly extent: number;
      readonly pages: readonly VerticalPage[]; readonly groups: readonly VerticalInterval[] };

/** Tolerance at the leading edge only; touching columns remain separable. */
const EPSILON = 0.01;

export function buildVerticalPageModel(
  intervals: readonly VerticalInterval[], pageWidth: number,
): VerticalPageModel {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) throw new RangeError("pageWidth must be positive");
  const sorted = intervals.map(({ start, end }) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < -EPSILON || end <= start) {
      throw new RangeError("invalid vertical content interval");
    }
    return { start: Math.max(0, start), end };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const groups: Array<{ start: number; end: number }> = [];
  for (const item of sorted) {
    const last = groups.at(-1);
    if (last && item.start < last.end) last.end = Math.max(last.end, item.end);
    else groups.push({ ...item });
  }
  if (groups.length === 0) return { kind: "empty", pageWidth, extent: 0, pages: [] };
  const wide = groups.find(group => group.end - group.start > pageWidth);
  if (wide) return { kind: "unsupported", reason: "wide-group", group: wide, pageWidth };

  const extent = groups.at(-1)!.end;
  const pages: VerticalPage[] = [];
  let start = 0, cursor = 0;
  while (start < extent) {
    const ideal = Math.min(start + pageWidth, extent);
    if (ideal <= start) throw new RangeError("pageWidth is below coordinate precision");
    while (cursor < groups.length && groups[cursor].end <= ideal) cursor++;
    const crossing = groups[cursor];
    const end = crossing && crossing.start < ideal ? crossing.start : ideal;
    // A too-wide atom can never be partially accepted or create a zero-step loop.
    if (end <= start) return { kind: "unsupported", reason: "wide-group", group: crossing, pageWidth };
    pages.push({ start, end, blankAfter: Math.max(0, pageWidth - (end - start)) });
    start = end;
  }
  return { kind: "ready", pageWidth, extent, pages, groups };
}

/** Exact shared edges belong to the following page, except the book end. */
export function verticalPageAt(model: VerticalPageModel, logicalOffset: number): number | null {
  if (model.kind !== "ready" || !Number.isFinite(logicalOffset) || logicalOffset < 0 || logicalOffset > model.extent) return null;
  if (logicalOffset === model.extent) return model.pages.length - 1;
  let lo = 0, hi = model.pages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (model.pages[mid].end <= logicalOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo < model.pages.length ? lo : null;
}

export function verticalPageScrollLeft(model: VerticalPageModel, page: number): number | null {
  if (model.kind !== "ready" || !Number.isInteger(page) || page < 0 || page >= model.pages.length) return null;
  return -model.pages[page].start;
}
