/**
 * Image layout policy, not an author-CSS parser.
 * Scroll mode preserves the browser's author cascade; paginated page filling
 * keeps its existing eligibility test. Wiring is owned by the implementation AI.
 */
export interface ImageLayoutPolicy {
  readonly viewerClass: "fullpage-image" | "pure-image-page" | null;
  readonly usePaginatedMediaDefaults: boolean;
  readonly fillPage: boolean;
}

/**
 * `paginatedFillEligible` is the existing sanitizer decision, including its
 * own-size / fluid-width exceptions. This module must not expand that decision.
 * Keep the existing marker eligibility too: paginator uses it for margin fixes.
 * `pure-image-page` must no longer grant forced sizing in scroll mode.
 */
export function imageLayoutPolicy(input: {
  readonly readingMode: "paginated" | "scroll" | undefined;
  readonly paginatedFillEligible: boolean;
}): ImageLayoutPolicy {
  if (input.readingMode === "scroll") {
    return {
      viewerClass: input.paginatedFillEligible ? "pure-image-page" : null,
      usePaginatedMediaDefaults: false,
      fillPage: false,
    };
  }
  return {
    viewerClass: input.paginatedFillEligible ? "fullpage-image" : null,
    usePaginatedMediaDefaults: true,
    fillPage: input.paginatedFillEligible,
  };
}

/**
 * Replaces all reader *sizing* defaults for scrolling media, rather than being
 * appended after the old !important rules. viewerId is the renderer's constant.
 * Footnote icon sizing and theme shadow rules remain separate existing rules.
 *
 * No width:100%, height:auto, max-height reset, ancestor sizing or !important:
 * removing an author limit is not a prerequisite for allowing natural tall art.
 * :where covers the complete selector (specificity 0,0,0).
 */
export function scrollMediaDefaultsCss(viewerId: string): string {
  return `/* L3 scrolling media: fit the containing width unless the author overrides. */
:where(#${viewerId} img, #${viewerId} svg, #${viewerId} video) {
  max-width: 100%;
}
:where(#${viewerId} img) {
  object-fit: contain;
}`;
}
