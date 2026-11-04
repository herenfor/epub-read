import { createElement, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../render/settings";
import { createReactDomHarness } from "../test/reactDomHarness";
import { ComicReaderView } from "./ComicReaderView";
import type { ReaderHandle, ReaderViewProps } from "./ReaderView";

describe("comic progress jump ownership", () => {
  it("a jump replaced by another navigation before it lands is cancelled, never reported as landed", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: true });
    const pages = Array.from({ length: 12 }, (_, i) => ({ path: `p${i}.png` }));
    const settled = vi.fn(), cancelled = vi.fn();
    // Page reads never finish, so no jump can land while the test runs.
    const server = {
      acquireResource: () => new Promise<never>(() => {}),
      resourceRasterPixels: () => 0,
      resourceRasterSize: () => undefined,
    };
    const props = {
      book: { comicPages: pages, pageProgression: "ltr" },
      server,
      settings: DEFAULT_SETTINGS,
      onPageState: vi.fn(), onDisplayReady: vi.fn(), onInternalNavigationSettled: vi.fn(),
      onContentFractionSettled: settled, onContentFractionCancelled: cancelled,
    } as unknown as ReaderViewProps;
    const ref = createRef<ReaderHandle>();
    for (const method of ["scrollTo", "scrollBy"]) dom.define(dom.window.HTMLElement.prototype, method, { writable: true, value: () => {} });
    try {
      await dom.render(createElement(ComicReaderView, { ...props, ref }));
      const first = { session: 1, request: 1 }, second = { session: 1, request: 2 };
      await dom.run(() => { ref.current!.seekContentFraction!({ key: "comic", spineIndex: 0, fraction: 0.5 }, first); });
      expect(cancelled).not.toHaveBeenCalled();
      // A newer jump replaces the first; a plain page navigation then replaces the second.
      await dom.run(() => { ref.current!.seekContentFraction!({ key: "comic", spineIndex: 0, fraction: 0.8 }, second); });
      expect(cancelled).toHaveBeenLastCalledWith(first);
      await dom.run(() => { ref.current!.setPage(2); });
      expect(cancelled).toHaveBeenLastCalledWith(second);
      expect(cancelled).toHaveBeenCalledTimes(2);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      await dom.dispose();
    }
  });
});
