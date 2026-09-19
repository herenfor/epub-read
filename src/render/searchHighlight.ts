export const SEARCH_HIGHLIGHT_NAME = "reader-search-hit";

type HighlightRegistryLike = {
  set(name: string, value: unknown): unknown;
  delete(name: string): boolean;
};

type HighlightWindow = Window & {
  Highlight?: new (...ranges: Range[]) => unknown;
  CSS?: typeof CSS;
};

export interface HighlightSupport {
  registry: HighlightRegistryLike;
  HighlightCtor: NonNullable<HighlightWindow["Highlight"]>;
}

export function getHighlightSupport(doc: Document | null | undefined): HighlightSupport | null {
  const win = doc?.defaultView as HighlightWindow | null | undefined;
  const registry = win?.CSS?.highlights;
  const HighlightCtor = win?.Highlight;
  if (!win || !registry || typeof HighlightCtor !== "function") return null;
  return { registry, HighlightCtor };
}

/** Draw a search range without inserting marker nodes or changing DOM text. */
export function applySearchHighlight(
  doc: Document | null | undefined,
  ranges: readonly Range[],
): "applied" | "unsupported" {
  const support = getHighlightSupport(doc);
  if (!support) return "unsupported";
  support.registry.delete(SEARCH_HIGHLIGHT_NAME);
  if (ranges.length > 0) {
    support.registry.set(SEARCH_HIGHLIGHT_NAME, new support.HighlightCtor(...ranges));
  }
  return "applied";
}

/** Remove only this feature's registry entry; never clear all highlights. */
export function clearSearchHighlight(doc: Document | null | undefined): void {
  const support = getHighlightSupport(doc);
  if (!support) return;
  support.registry.delete(SEARCH_HIGHLIGHT_NAME);
}
