import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { vi } from "vitest";

/** Real React event/effect ordering, without pretending to measure iframe layout. */
export function createReactDomHarness() {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  window.innerWidth = 1024;
  window.innerHeight = 768;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("Element", window.Element);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = window.document.getElementById("root") as unknown as HTMLElement;
  const root = createRoot(container);
  return {
    container,
    async render(node: ReactNode) { await act(async () => root.render(node)); },
    async click(element: Element) {
      await act(async () => { element.dispatchEvent(new window.Event("click", { bubbles: true })); });
    },
    async dispose() {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}
