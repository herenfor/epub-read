import { useEffect, useRef } from "react";

const READER_FRAMES = ".reader-presentation-host iframe";

/** Pointer distance from the window bottom that summons the desktop footer. */
export const FOOTER_REVEAL_EDGE_PX = 40;

function frameDocuments(): Array<{ doc: Document; frame: HTMLIFrameElement }> {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>(READER_FRAMES)).flatMap((frame) => {
    try {
      return frame.contentDocument ? [{ doc: frame.contentDocument, frame }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Desktop reading: calls `onNear` while a mouse pointer moves within
 * `distance` px of the window bottom. Chapter iframes do not bubble pointer
 * events to the app window, so each frame document is observed and its
 * coordinates are lifted to the window (same approach as readerCursorIdle).
 */
export function useBottomEdgePointer(active: boolean, distance: number, onNear: () => void): void {
  const onNearRef = useRef(onNear);
  onNearRef.current = onNear;
  useEffect(() => {
    if (!active) return;
    const hooked = new Map<Document, (event: PointerEvent) => void>();
    const listen = (doc: Document, frame: HTMLIFrameElement | null): void => {
      if (hooked.has(doc)) return;
      const onMove = (event: PointerEvent): void => {
        if (event.pointerType === "touch" || event.buttons !== 0) return;
        const top = frame ? frame.getBoundingClientRect().top : 0;
        if (window.innerHeight - (top + event.clientY) <= distance) onNearRef.current();
      };
      doc.addEventListener("pointermove", onMove, { passive: true });
      hooked.set(doc, onMove);
    };
    const hookFrames = (): void => frameDocuments().forEach(({ doc, frame }) => listen(doc, frame));
    // iframe load does not bubble, but a capturing listener still sees it.
    const onLoad = (event: Event): void => {
      if (event.target instanceof HTMLIFrameElement && event.target.matches(READER_FRAMES)) hookFrames();
    };
    listen(document, null);
    hookFrames();
    document.addEventListener("load", onLoad, true);
    return () => {
      document.removeEventListener("load", onLoad, true);
      for (const [doc, onMove] of hooked) doc.removeEventListener("pointermove", onMove);
      hooked.clear();
    };
  }, [active, distance]);
}
