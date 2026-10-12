import { createElement, forwardRef, useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { Book } from "../core/types";
import { DEFAULT_SETTINGS } from "../render/settings";
import type { ChapterState } from "../render/paginator";
import { createReactDomHarness } from "../test/reactDomHarness";
import { ImageSpreadReaderView } from "./ImageSpreadReaderView";
import type { ReaderHandle, ReaderViewProps } from "./ReaderView";

// The original chapter view owns leaf wheel input; the production spread
// must add only the missing outer/blank paths, preserving that ownership.
const Page = forwardRef<ReaderHandle, ReaderViewProps>(function Page(props, _ref) {
  useEffect(() => {
    props.onPageState({ status: "ready", pageCount: 1, currentPage: 0, empty: false } as ChapterState);
    props.onDisplayReady(null);
  }, []);
  return createElement("div", { className: "reader", onWheel: () => props.onRequestChapter(props.spineIndex + 1) },
    createElement("span", { className: "leaf-content" }, "original leaf"));
});

it("turns the blank leaf, gutter and edge once while preserving leaf, pause and book-boundary ownership", async () => {
  const dom = createReactDomHarness();
  const onRequestChapter = vi.fn();
  const props = {
    book: { spine: [0, 1, 2].map((id) => ({ idref: String(id), linear: true })) } as Book,
    spineIndex: 0, spread: { left: 0, right: null }, gap: 24,
    settings: { ...DEFAULT_SETTINGS, columnsPerView: 2 as const },
    userFonts: [], notes: [], anchorNonce: 0, startAtEnd: { nonce: 0, atEnd: false },
    onRequestChapter, onPageState: vi.fn(), onDisplayReady: vi.fn(),
    onUnsupported: vi.fn(), Page,
    server: {} as ReaderViewProps["server"], initialPage: 0,
    onIssues: vi.fn(), onInternalLink: vi.fn(), onBeforeInternalNavigate: vi.fn(),
    onInternalNavigationSettled: vi.fn(), onExternalLink: vi.fn(),
    onFootnote: vi.fn(), onFootnoteClose: vi.fn(),
  };
  const render = (inputPaused = false) => dom.render(createElement(ImageSpreadReaderView, { ...props, inputPaused }));
  const wheel = async (target: Element, deltaY: number) => {
    const event = new window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperties(event, { deltaY: { value: deltaY }, deltaMode: { value: 0 }, ctrlKey: { value: false } });
    await dom.dispatch(target, event);
  };
  try {
    await render();
    const blank = dom.container.querySelector(".is-empty")!;
    const spread = dom.container.querySelector(".reader-image-spread")!;
    await wheel(blank, 40);
    expect(onRequestChapter).not.toHaveBeenCalled();
    await wheel(blank, 40);
    expect(onRequestChapter).toHaveBeenCalledTimes(1);
    expect(onRequestChapter).toHaveBeenLastCalledWith(1, undefined);
    await wheel(spread, 120);
    expect(onRequestChapter).toHaveBeenCalledTimes(2);
    await wheel(dom.container.querySelector(".edge-turn-next")!, 120);
    expect(onRequestChapter).toHaveBeenCalledTimes(3);
    await wheel(dom.container.querySelector(".leaf-content")!, 120);
    expect(onRequestChapter).toHaveBeenCalledTimes(4); // leaf + parent must not both turn
    await wheel(blank, -120);
    expect(onRequestChapter).toHaveBeenCalledTimes(4); // first spread has no previous neighbor
    await render(true);
    await wheel(blank, 120);
    expect(onRequestChapter).toHaveBeenCalledTimes(4);
  } finally {
    await dom.dispose();
  }
});
