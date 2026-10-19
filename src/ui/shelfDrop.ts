import { isSupportedFontFileName } from "./fontDrop";

/** What a native window drop carried: EPUBs, fonts, and anything else (folders are found among the rest). */
export interface DroppedPaths {
  readonly epubs: string[];
  readonly fonts: string[];
  readonly others: string[];
}

export function partitionDroppedPaths(paths: readonly string[]): DroppedPaths {
  const epubs: string[] = [];
  const fonts: string[] = [];
  const others: string[] = [];
  for (const path of paths) {
    if (path.toLowerCase().endsWith(".epub")) epubs.push(path);
    else if (isSupportedFontFileName(path)) fonts.push(path);
    else others.push(path);
  }
  return { epubs, fonts, others };
}

/**
 * Shelf folder (grid card, list row or drag chip) under a native drag point.
 * Native drag positions are physical pixels relative to the webview.
 */
export function folderIdAtPhysicalPoint(
  position: { x: number; y: number },
  devicePixelRatio: number,
  doc: Pick<Document, "elementFromPoint"> = document,
): string | null {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const element = doc.elementFromPoint(position.x / ratio, position.y / ratio);
  return element?.closest<HTMLElement>("[data-folder-id]")?.dataset.folderId ?? null;
}
