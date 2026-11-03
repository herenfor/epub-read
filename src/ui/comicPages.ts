/** Stable source pages never change identity when the display switches to spreads. */
export function comicSpreads(pages: readonly {
    doublePage: boolean;
}[], columns: 1 | 2): number[][] {
    const result: number[][] = [];
    for (let i = 0; i < pages.length;) {
        if (columns === 1 || i === 0 || pages[i].doublePage) {
            result.push([i++]);
            continue;
        }
        const group = [i++];
        if (i < pages.length && !pages[i].doublePage)
            group.push(i++);
        result.push(group);
    }
    return result;
}
export function comicPageForAnchor(pages: readonly {
    path: string;
}[], signature: string | undefined, hint: number): number | null {
    if (signature) {
        const index = pages.findIndex(p => p.path === signature);
        return index < 0 ? null : index;
    }
    return Number.isInteger(hint) && hint >= 0 && hint < pages.length ? hint : null;
}

/** Repeated taps queue; the opposite direction takes over from the visible position. */
export function comicTurnTarget(visual: number, goal: number, direction: 1 | -1, previous: 1 | -1 | null): number {
  if (previous === direction) return goal + direction;
  return direction === 1 ? Math.floor(visual + 0.001) + 1 : Math.ceil(visual - 0.001) - 1;
}
