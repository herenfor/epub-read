import { useEffect } from "react";

/** Pointer rest time before it is hidden while reading (Issue #1 item 9). */
export const CURSOR_IDLE_MS = 1500;
/** Mirrored on the app root and on every chapter iframe root; the book frame's
 * matching rule lives in sanitize.ts (render code cannot import UI modules). */
export const CURSOR_IDLE_ATTR = "data-reader-cursor-idle";

const READER_FRAMES = ".reader-presentation-host iframe";

function isEditing(doc: Document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(?:input|textarea|select)$/iu.test(el.tagName));
}

/**
 * PC reading view: hide the mouse pointer after it rests, show it again on any
 * movement. Chapter iframes do not bubble mouse events to the app window, so
 * each frame document is observed and marked as well. A held button (text
 * selection, scrubbing), a focused text field or leaving the window keeps the
 * pointer visible; `active` turns false for the shelf, panels and dialogs.
 */
export function useReaderCursorIdle(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hooked = new WeakSet<Document>();

    const frameDocuments = (): Document[] =>
      Array.from(document.querySelectorAll<HTMLIFrameElement>(READER_FRAMES)).flatMap((frame) => {
        try {
          return frame.contentDocument ? [frame.contentDocument] : [];
        } catch {
          return [];
        }
      });
    const mark = (doc: Document): void => {
      doc.documentElement?.toggleAttribute(CURSOR_IDLE_ATTR, idle);
    };
    const setIdle = (next: boolean): void => {
      if (idle === next) return;
      idle = next;
      mark(document);
      frameDocuments().forEach(mark);
    };
    const stop = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const arm = (): void => {
      stop();
      timer = setTimeout(() => {
        timer = null;
        setIdle(true);
      }, CURSOR_IDLE_MS);
    };
    // Pointer events: a control that cancels pointerdown (the progress
    // scrubber) suppresses the compatibility mouse events for the whole drag.
    const onMove = (event: PointerEvent): void => {
      if (event.pointerType === "touch") return;
      setIdle(false);
      const doc = (event.target as Node | null)?.ownerDocument ?? document;
      if (event.buttons !== 0 || isEditing(document) || isEditing(doc)) stop();
      else arm();
    };
    const onPress = (): void => {
      setIdle(false);
      stop();
    };
    const onLeave = (): void => {
      setIdle(false);
      stop();
    };
    const hook = (doc: Document): void => {
      if (hooked.has(doc)) return;
      hooked.add(doc);
      doc.addEventListener("pointermove", onMove, { passive: true });
      doc.addEventListener("pointerdown", onPress, true);
      doc.addEventListener("pointerup", arm, true);
      mark(doc);
    };
    const hookFrames = (): void => frameDocuments().forEach(hook);
    // iframe load does not bubble, but a capturing listener still sees it.
    const onLoad = (event: Event): void => {
      if (event.target instanceof HTMLIFrameElement && event.target.matches(READER_FRAMES)) hookFrames();
    };

    hook(document);
    hookFrames();
    document.addEventListener("load", onLoad, true);
    window.addEventListener("blur", onLeave);
    document.documentElement.addEventListener("mouseleave", onLeave);
    arm();
    return () => {
      stop();
      setIdle(false);
      document.removeEventListener("load", onLoad, true);
      window.removeEventListener("blur", onLeave);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      for (const doc of [document, ...frameDocuments()]) {
        doc.removeEventListener("pointermove", onMove);
        doc.removeEventListener("pointerdown", onPress, true);
        doc.removeEventListener("pointerup", arm, true);
      }
    };
  }, [active]);
}
