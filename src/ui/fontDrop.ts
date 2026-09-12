export const SUPPORTED_FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"] as const;

export function isSupportedFontFileName(name: string): boolean {
  return /\.(ttf|otf|woff|woff2)$/i.test(name.trim());
}

export function partitionFontItems<T>(items: readonly T[], nameOf: (item: T) => string): {
  supported: T[];
  unsupported: T[];
} {
  const supported: T[] = [];
  const unsupported: T[] = [];
  for (const item of items) {
    (isSupportedFontFileName(nameOf(item)) ? supported : unsupported).push(item);
  }
  return { supported, unsupported };
}

export interface DragDepthTracker {
  enter(): boolean;
  leave(): boolean;
  reset(): boolean;
}

/** Nested children emit matching dragenter/dragleave pairs; depth prevents visual flicker. */
export function createDragDepthTracker(): DragDepthTracker {
  let depth = 0;
  return {
    enter: () => { depth += 1; return true; },
    leave: () => { depth = Math.max(0, depth - 1); return depth > 0; },
    reset: () => { depth = 0; return false; },
  };
}

export function isPhysicalPointInsideRect(
  point: { x: number; y: number },
  scaleFactor: number,
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">
): boolean {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const x = point.x / scale;
  const y = point.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Keep font imports serial: hashing and persistence can be expensive for large font files. */
export async function runFontImportBatch<T>(items: readonly T[], importOne: (item: T) => Promise<void>): Promise<void> {
  for (const item of items) await importOne(item);
}
