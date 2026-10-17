import { createElement, forwardRef, useEffect, useImperativeHandle } from "react";
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
    spineIndex: 0, spread: { left: 0, right: null },
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
    props.book.pageProgression = "rtl";
    await render();
    // A13 crop display: the first chapter shows only its own (right) slot.
    expect((dom.container.querySelector("[data-image-chapter='0']") as HTMLElement).style.clipPath).toBe("inset(0 0 0 50%)");
    expect(dom.container.querySelector("[data-image-chapter='0']")?.getAttribute("data-image-side")).toBe("right");
    expect(dom.container.querySelector(".is-empty")?.getAttribute("data-image-side")).toBe("left");
    await wheel(dom.container.querySelector(".is-empty")!, 120);
    expect(onRequestChapter).toHaveBeenLastCalledWith(1, undefined);
  } finally {
    await dom.dispose();
  }
});

// T7: after a window resize each leaf reflows on its own; the pair is rebuilt
// only from both leaves' committed geometry, each leaf placed by its own step.
it("re-pairs both leaves after a relayout and places the second leaf by its own column step", async () => {
  const dom = createReactDomHarness();
  const layouts = new Map<number, { columnStep: number } | "pending" | null>([[0, { columnStep: 812 }], [1, { columnStep: 800 }]]);
  const settled = new Map<number, () => void>();
  const LayoutPage = forwardRef<ReaderHandle, ReaderViewProps>(function LayoutPage(props, ref) {
    useImperativeHandle(ref, () => ({ spreadLeafLayout: () => layouts.get(props.spineIndex) ?? null }) as unknown as ReaderHandle, [props.spineIndex]);
    settled.set(props.spineIndex, () => props.onLayoutSettled?.());
    useEffect(() => {
      props.onPageState({ status: "ready", pageCount: 1, currentPage: 0, empty: false, effectiveColumns: 2 } as ChapterState);
      props.onDisplayReady(null);
    }, []);
    return createElement("div", { className: "reader" });
  });
  const onDisplayReady = vi.fn();
  const onUnsupported = vi.fn();
  const props = {
    book: { spine: [0, 1, 2].map((id) => ({ idref: String(id), linear: true })) } as Book,
    spineIndex: 0, spread: { left: 0, right: 1 },
    settings: { ...DEFAULT_SETTINGS, columnsPerView: 2 as const },
    userFonts: [], notes: [], anchorNonce: 0, startAtEnd: { nonce: 0, atEnd: false },
    onRequestChapter: vi.fn(), onPageState: vi.fn(), onDisplayReady, onUnsupported, Page: LayoutPage,
    server: {} as ReaderViewProps["server"], initialPage: 0,
    onIssues: vi.fn(), onInternalLink: vi.fn(), onBeforeInternalNavigate: vi.fn(),
    onInternalNavigationSettled: vi.fn(), onExternalLink: vi.fn(),
    onFootnote: vi.fn(), onFootnoteClose: vi.fn(),
  };
  const spread = () => dom.container.querySelector(".reader-image-spread")!;
  const secondShift = () => (dom.container.querySelector("[data-image-chapter='1'] .reader-image-leaf-shift") as HTMLElement).style.transform;
  try {
    await dom.render(createElement(ImageSpreadReaderView, props));
    expect(spread().getAttribute("data-image-spread-ready")).toBe("true");
    expect(secondShift()).toBe("translateX(800px)"); // its own step, not the first leaf's 812
    expect(onDisplayReady).toHaveBeenCalledTimes(1);

    // Window restored: the first leaf has relaid out, the second has not yet.
    layouts.set(0, { columnStep: 512 });
    layouts.set(1, "pending");
    await dom.run(() => settled.get(0)!());
    expect(spread().getAttribute("data-image-spread-ready")).toBe("false");

    layouts.set(1, { columnStep: 500 });
    await dom.run(() => settled.get(1)!());
    expect(spread().getAttribute("data-image-spread-ready")).toBe("true");
    expect(secondShift()).toBe("translateX(500px)");
    expect(onDisplayReady).toHaveBeenCalledTimes(1); // a relayout is not a second display-ready
    expect(onUnsupported).not.toHaveBeenCalled();

    // Laid out but no longer a two-column spread (e.g. narrowed to one page).
    layouts.set(1, null);
    await dom.run(() => settled.get(1)!());
    expect(onUnsupported).toHaveBeenCalledTimes(1);
  } finally {
    await dom.dispose();
  }
});
