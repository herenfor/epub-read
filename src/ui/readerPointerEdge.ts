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
 * Keeps `listen` attached to the app document and to every reader chapter
 * frame's current document. Chapter iframes do not bubble input events to the
 * app window, so each frame document is hooked; a chapter change or a removed
 * frame releases the old document. `listen` returns that document's release.
 */
function watchReaderDocuments(
  listen: (doc: Document, frame: HTMLIFrameElement | null) => () => void,
): () => void {
  const hooked = new Map<Document, () => void>();
  const hook = (doc: Document, frame: HTMLIFrameElement | null): void => {
    if (!hooked.has(doc)) hooked.set(doc, listen(doc, frame));
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
    for (const [doc, release] of hooked) {
      if (live.has(doc)) continue;
      release();
      hooked.delete(doc);
    }
    frames.forEach(({ doc, frame }) => hook(doc, frame));
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
  hook(document, null);
  hookFrames();
  document.addEventListener("load", onLoad, true);
  return () => {
    document.removeEventListener("load", onLoad, true);
    hostObserver.disconnect();
    hosts.clear();
    for (const release of hooked.values()) release();
    hooked.clear();
  };
}

/**
 * Desktop reading: calls `onNear` while a mouse pointer moves within
 * `distance` px of the window bottom, from the app window or any chapter
 * frame (coordinates are lifted to the window, as in readerCursorIdle).
 */
export function useBottomEdgePointer(active: boolean, distance: number, onNear: () => void): void {
  const onNearRef = useRef(onNear);
  onNearRef.current = onNear;
  useEffect(() => {
    if (!active) return;
    return watchReaderDocuments((doc, frame) => {
      const onMove = (event: PointerEvent): void => {
        if (event.pointerType === "touch" || event.buttons !== 0) return;
        const top = frame ? frame.getBoundingClientRect().top : 0;
        if (window.innerHeight - (top + event.clientY) <= distance) onNearRef.current();
      };
      doc.addEventListener("pointermove", onMove, { passive: true });
      return () => doc.removeEventListener("pointermove", onMove);
    });
  }, [active, distance]);
}

const READING_INPUT_EVENTS = ["pointerdown", "touchstart", "wheel", "keydown"] as const;

/**
 * Reading input starts (press, touch, wheel, key) in the app window or inside
 * any chapter frame — the paths page turns, scrolling and navigation start
 * from. Captured and passive: the input itself is never delayed or consumed.
 */
export function useReadingInputStart(active: boolean, onStart: () => void): void {
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;
  useEffect(() => {
    if (!active) return;
    return watchReaderDocuments((doc) => {
      const onInput = (): void => onStartRef.current();
      for (const type of READING_INPUT_EVENTS) doc.addEventListener(type, onInput, { capture: true, passive: true });
      return () => {
        for (const type of READING_INPUT_EVENTS) doc.removeEventListener(type, onInput, { capture: true });
      };
    });
  }, [active]);
}
