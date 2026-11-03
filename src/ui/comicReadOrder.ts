/** Which source pages to read now: `urgent` must not wait behind anything else. */
export interface ComicReadOrder { urgent: number[]; order: number[] }

/**
 * The screens on view and the explicit goal come first, then one screen each
 * side, the heading side first. Screens are display groups (a spread, or one
 * page in single and scroll modes); the result is source pages.
 */
export function comicReadOrder(groups: readonly (readonly number[])[], groupForPage: readonly number[],
  shown: readonly number[], goal: number, heading: 1 | -1): ComicReadOrder {
  const screens = shown.map(p => groupForPage[p]).filter(s => s !== undefined);
  if (screens.length === 0) return { urgent: [], order: [] };
  const first = Math.min(...screens), last = Math.max(...screens);
  const urgent = new Set<number>();
  for (let s = first; s <= last; s++) for (const p of groups[s]) urgent.add(p);
  for (const p of groups[groupForPage[goal]] ?? []) urgent.add(p);
  const order = new Set(urgent);
  for (const s of heading === 1 ? [last + 1, first - 1] : [first - 1, last + 1]) {
    for (const p of groups[s] ?? []) order.add(p);
  }
  return { urgent: [...urgent], order: [...order] };
}
