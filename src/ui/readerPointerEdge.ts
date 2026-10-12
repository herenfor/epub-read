import { useEffect, useRef } from "react";

const READER_HOSTS = ".reader-presentation-host";
const READER_FRAMES = `${READER_HOSTS} iframe`;

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
 * Only the window and the frames' current documents stay hooked: a chapter
 * change or a removed frame releases the old document's listener.
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
    // Hosts are watched only for frames coming and going (preload, image
    // pages), not for every DOM change inside the app.
    const hosts = new Set<Element>();
    const hostObserver = new MutationObserver((records) => {
      const framesChanged = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some((node) =>
          node instanceof Element && (node.tagName === "IFRAME" || node.querySelector("iframe") !== null)));
      if (framesChanged) hookFrames();
    });
    const hookFrames = (): void => {
      const frames = frameDocuments();
      const live = new Set<Document>([document, ...frames.map(({ doc }) => doc)]);
      for (const [doc, onMove] of hooked) {
        if (live.has(doc)) continue;
        doc.removeEventListener("pointermove", onMove);
        hooked.delete(doc);
      }
      frames.forEach(({ doc, frame }) => listen(doc, frame));
      for (const host of hosts) if (!host.isConnected) hosts.delete(host);
      for (const host of document.querySelectorAll(READER_HOSTS)) {
        if (hosts.has(host)) continue;
        hosts.add(host);
        hostObserver.observe(host, { childList: true, subtree: true });
      }
    };
    // iframe load does not bubble, but a capturing listener still sees it.
    const onLoad = (event: Event): void => {
      if (event.target instanceof HTMLIFrameElement && event.target.matches(READER_FRAMES)) hookFrames();
    };
    listen(document, null);
    hookFrames();
    document.addEventListener("load", onLoad, true);
    return () => {
      document.removeEventListener("load", onLoad, true);
      hostObserver.disconnect();
      hosts.clear();
      for (const [doc, onMove] of hooked) doc.removeEventListener("pointermove", onMove);
      hooked.clear();
    };
  }, [active, distance]);
}
