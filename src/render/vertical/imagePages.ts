import type { MediaReadingAnchor } from "../paginator";
import { buildVerticalPageModel, verticalPageAt, type VerticalInterval, type VerticalPage, type VerticalPageModel } from "./pageModel";

export interface VerticalImageFit {
  readonly width: number; readonly height: number;
  readonly left: number; readonly top: number;
}
export interface VerticalImageBox extends VerticalInterval {
  readonly anchor: Readonly<MediaReadingAnchor>;
  readonly naturalWidth: number; readonly naturalHeight: number;
}
export type VerticalChapterPage =
  | (VerticalPage & { readonly kind: "text" })
  | (VerticalPage & { readonly kind: "image"; readonly anchor: Readonly<MediaReadingAnchor>; readonly fit: VerticalImageFit });
export type VerticalChapterModel =
  | { readonly kind: "empty"; readonly pageWidth: number; readonly pageHeight: number; readonly extent: 0; readonly pages: readonly [] }
  | { readonly kind: "pending"; readonly reason: "image-size" }
  | { readonly kind: "unsupported"; readonly reason: "text-layout" | "image-box" | "overlap" }
  | { readonly kind: "ready"; readonly pageWidth: number; readonly pageHeight: number;
      readonly extent: number; readonly groups: readonly VerticalInterval[]; readonly pages: readonly VerticalChapterPage[] };

function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
/** Pure contain geometry. Original pixels, URLs and media identity stay intact. */
export function fitVerticalImage(width: number, height: number, pageWidth: number, pageHeight: number): VerticalImageFit | null {
  if (!positive(pageWidth) || !positive(pageHeight)) throw new RangeError("invalid vertical page size");
  if (!positive(width) || !positive(height)) return null;
  const scale = Math.min(pageWidth / width, pageHeight / height);
  const fittedWidth = width * scale, fittedHeight = height * scale;
  return { width: fittedWidth, height: fittedHeight, left: (pageWidth - fittedWidth) / 2, top: (pageHeight - fittedHeight) / 2 };
}

/** Call after the owner has reserved exactly one leaf-width for each full-page
 * media box and rebuilt the text snapshot. No DOM writes or UI activation. */
export function buildVerticalChapterModel(text: VerticalPageModel, images: readonly VerticalImageBox[], pageHeight: number): VerticalChapterModel {
  if (!positive(pageHeight)) throw new RangeError("invalid vertical page height");
  if (text.kind === "unsupported") return { kind: "unsupported", reason: "text-layout" };
  const pageWidth = text.pageWidth;
  const sorted = [...images].sort((a, b) => a.start - b.start);
  const groups = text.kind === "ready" ? text.groups : [];
  const pages: VerticalChapterPage[] = [];
  let cursor = 0, origin = 0;
  const seenIndices = new Set<number>();
  const appendText = (endCursor: number): void => {
    const segment = buildVerticalPageModel(groups.slice(cursor, endCursor).map(g => ({ start: g.start - origin, end: g.end - origin })), pageWidth);
    // A subset of already-supported text groups cannot become wider.
    if (segment.kind === "ready") for (const p of segment.pages) {
      pages.push({ kind: "text", start: origin + p.start, end: origin + p.end, blankAfter: p.blankAfter });
    }
    cursor = endCursor;
  };
  for (const image of sorted) {
    if (!Number.isFinite(image.start) || !Number.isFinite(image.end) || image.start < 0 ||
        Math.abs(image.end - image.start - pageWidth) > 0.01 ||
        !image.anchor.signature || !Number.isInteger(image.anchor.index) || image.anchor.index < 0 ||
        seenIndices.has(image.anchor.index) || !image.anchor.tag || !Number.isFinite(image.anchor.ratio) || image.anchor.ratio < 0 || image.anchor.ratio > 1) {
      return { kind: "unsupported", reason: "image-box" };
    }
    seenIndices.add(image.anchor.index);
    const fit = fitVerticalImage(image.naturalWidth, image.naturalHeight, pageWidth, pageHeight);
    if (!fit) return { kind: "pending", reason: "image-size" };
    if (image.start < origin) return { kind: "unsupported", reason: "overlap" };
    let endCursor = cursor;
    while (endCursor < groups.length && groups[endCursor].end <= image.start) endCursor++;
    if (groups[endCursor] && groups[endCursor].start < image.end) return { kind: "unsupported", reason: "overlap" };
    appendText(endCursor);
    pages.push({ kind: "image", start: image.start, end: image.end, blankAfter: 0, anchor: { ...image.anchor }, fit });
    origin = image.end;
  }
  appendText(groups.length);
  if (!pages.length) return { kind: "empty", pageWidth, pageHeight, extent: 0, pages: [] };
  return { kind: "ready", pageWidth, pageHeight, extent: pages.at(-1)!.end,
    groups: [...groups, ...sorted.map(({ start, end }) => ({ start, end }))].sort((a, b) => a.start - b.start), pages };
}

/** Canonical text locations are mapped into the same text/image leaf list. */
export function verticalChapterPageAt(model: VerticalChapterModel, logicalOffset: number): number | null {
  if (model.kind !== "ready") return null;
  const page = verticalPageAt(model, logicalOffset);
  // A gap before an independent image is not itself a reading page.
  return page !== null && logicalOffset >= model.pages[page].start ? page : null;
}

export function locateVerticalImage(model: VerticalChapterModel, anchor: Readonly<MediaReadingAnchor>):
  | { readonly status: "located"; readonly page: number; readonly anchor: Readonly<MediaReadingAnchor>; readonly imageY: number }
  | { readonly status: "unresolved" } {
  if (model.kind !== "ready" || !Number.isFinite(anchor.ratio) || anchor.ratio < 0 || anchor.ratio > 1) return { status: "unresolved" };
  const matches = model.pages.flatMap((page, n) => page.kind === "image" &&
    page.anchor.tag === anchor.tag && page.anchor.signature === anchor.signature ? [{ page, n }] : []);
  const hinted = matches.find(({ page }) => page.anchor.index === anchor.index);
  const found = hinted ?? (matches.length === 1 ? matches[0] : undefined);
  if (!found) return { status: "unresolved" };
  return { status: "located", page: found.n, anchor: { ...found.page.anchor, ratio: anchor.ratio },
    imageY: found.page.fit.top + found.page.fit.height * anchor.ratio };
}
