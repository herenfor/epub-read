import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { FOOTER_REVEAL_EDGE_PX, useBottomEdgePointer } from "./readerPointerEdge";

function Probe(props: { onNear(): void }) {
  useBottomEdgePointer(true, FOOTER_REVEAL_EDGE_PX, props.onNear);
  return null;
}

/** A chapter document whose pointermove listeners can be counted. */
function chapterDocument() {
  const { document } = parseHTML("<html><body><p>chapter</p></body></html>");
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    if (type === "pointermove") listeners.add(listener);
    add(type, listener, options as AddEventListenerOptions);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    if (type === "pointermove") listeners.delete(listener);
    remove(type, listener, options as EventListenerOptions);
  }) as typeof document.removeEventListener;
  return { document, listeners };
}

describe("bottom-edge pointer: chapter documents", () => {
  it("releases a frame's old document on chapter load and on frame removal, and still reveals from the new one", async () => {
    const dom = createReactDomHarness({ frames: true });
    const win = dom.window;
    const flushObservers = () => dom.run(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const doc = dom.container.ownerDocument;
    const host = doc.createElement("div");
    host.className = "reader-presentation-host";
    doc.body.appendChild(host);
    const frame = doc.createElement("iframe");
    let current = chapterDocument();
    Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => current.document });
    host.appendChild(frame);
    const onNear = vi.fn();
    try {
      await dom.render(createElement(Probe, { onNear }));
      const first = current;
      expect(first.listeners.size).toBe(1);

      // Same iframe, next chapter: the load re-scan drops the old document.
      current = chapterDocument();
      // Browsers deliver the non-bubbling load to the capturing listener;
      // linkedom only propagates bubbling events, so the test lets it bubble.
      await dom.run(() => { frame.dispatchEvent(new win.Event("load", { bubbles: true })); });
      expect(first.listeners.size).toBe(0);
      expect(current.listeners.size).toBe(1);

      // The new document still summons the footer near the window bottom.
      const move = new win.Event("pointermove");
      Object.assign(move, { pointerType: "mouse", buttons: 0, clientY: window.innerHeight - 10 });
      await dom.dispatch(current.document as unknown as Element, move);
      expect(onNear).toHaveBeenCalledTimes(1);

      // The frame goes away (image page / preload host): its document is released too.
      const second = current;
      host.removeChild(frame);
      await flushObservers();
      expect(second.listeners.size).toBe(0);
    } finally {
      await dom.dispose();
    }
  });
});
