/** Physical content edges of one leaf, in the same coordinate space as its ancestors. */
export interface InlineContentBounds {
  left: number;
  right: number;
}

export interface ContentSize {
  width: number;
  height: number;
}

/**
 * Intersect the actual leaf with its containing boxes, rather than trusting an
 * already oversized nearest parent. The caller supplies current-leaf fragments
 * and excludes intentional bleeds / fixed-layout pages before planning.
 * outerInsets includes the element's margins, borders and padding where needed.
 */
export function resolveAvailableInlineWidth(
  leaf: InlineContentBounds,
  containingBoxes: readonly InlineContentBounds[],
  outerInsets = 0,
): number {
  let left = leaf.left;
  let right = leaf.right;
  for (const box of containingBoxes) {
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  }
  return Math.max(0, right - left - outerInsets);
}

export interface MediaFitPlan extends ContentSize {
  scale: number;
  startOnNextPage: boolean;
}

/**
 * Content-box sizes, after normal image sizing and excluding fixed box insets.
 * null pageHeight means continuous scrolling: cap width, not a long image's height.
 * Measure the restored author styles each time; never feed a previous fitted size
 * back as the authored size. Unloaded media / an empty budget defer to a later layout.
 */
export function planMediaFit(input: {
  authored: ContentSize;
  availableWidth: number;
  pageHeight: number | null;
  remainingHeight?: number;
}): MediaFitPlan | null {
  const { authored, availableWidth, pageHeight, remainingHeight } = input;
  if (authored.width <= 0 || authored.height <= 0 || availableWidth <= 0 ||
      (pageHeight !== null && pageHeight <= 0)) return null;
  const scale = Math.min(
    1,
    availableWidth / authored.width,
    pageHeight === null ? 1 : pageHeight / authored.height,
  );
  const width = authored.width * scale;
  const height = authored.height * scale;
  return {
    width,
    height,
    scale,
    // A partly occupied page is a placement constraint, not a new scale limit.
    startOnNextPage: pageHeight !== null && remainingHeight !== undefined &&
      height > Math.max(0, remainingHeight),
  };
}

/** Convert fitted image content sizes to CSS width/height without scaling borders. */
export function mediaFitCssSize(
  content: ContentSize,
  paddingBorder: ContentSize,
  boxSizing: "content-box" | "border-box",
): ContentSize {
  return boxSizing === "border-box"
    ? { width: content.width + paddingBorder.width, height: content.height + paddingBorder.height }
    : { width: content.width, height: content.height };
}

export type TableWidthPlan =
  | { kind: "preserve" }
  | { kind: "defer" }
  | { kind: "constrain"; borderBoxWidth: number };

/** Table plans use border boxes; do not add the border again on content-box tables. */
export function tableFitCssWidth(
  borderBoxWidth: number,
  paddingBorderWidth: number,
  boxSizing: "content-box" | "border-box",
): number {
  return boxSizing === "border-box" ? borderBoxWidth : Math.max(0, borderBoxWidth - paddingBorderWidth);
}

/**
 * First pass only: propose a border-box width, without shrinking text or changing
 * table-layout / columns. Author min-width, colspan and nowrap can still prevent
 * the table from fitting. Re-measure once before declaring the layout resolved.
 */
export function planTableWidth(
  authoredBorderBoxWidth: number,
  availableBorderBoxWidth: number,
): TableWidthPlan {
  if (authoredBorderBoxWidth <= 0 || availableBorderBoxWidth <= 0) return { kind: "defer" };
  return authoredBorderBoxWidth <= availableBorderBoxWidth
    ? { kind: "preserve" }
    : { kind: "constrain", borderBoxWidth: availableBorderBoxWidth };
}

/**
 * Check table/cell fragments assigned to this leaf after the constrained layout.
 * Do not pass a union bounding box spanning several legitimate columns, or clamp
 * rectangles before checking them: that would hide the overflow we need to detect.
 */
export function tableFitsInlineBounds(
  available: InlineContentBounds,
  fragments: readonly InlineContentBounds[],
): boolean {
  return available.right > available.left && fragments.length > 0 &&
    fragments.every(box => box.right >= box.left &&
      box.left >= available.left - 0.5 && box.right <= available.right + 0.5);
}
