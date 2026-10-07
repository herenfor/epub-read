import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";

const { sanitizeMock } = vi.hoisted(() => ({ sanitizeMock: vi.fn() }));

vi.mock("./sanitize", () => ({
  VIEWER_ID: "epub-viewer",
  sanitizeChapter: sanitizeMock,
}));

import { adaptNavigationAnchor } from "./navigationAnchor";
import { createSpreadGeometry, createSpreadLayout } from "./pagedSpread";
import { ChapterPaginator, type MediaReadingAnchor } from "./paginator";

function fakeStyle(): CSSStyleDeclaration {
  return {
    getPropertyValue: () => "",
    getPropertyPriority: () => "",
    setProperty() {},
    removeProperty() {},
  } as unknown as CSSStyleDeclaration;
}

function fakeIframe(): HTMLIFrameElement {
  return {
    style: fakeStyle(),
    src: "about:blank",
    clientWidth: 800,
    clientHeight: 600,
    addEventListener() {},
    removeEventListener() {},
    contentDocument: null,
  } as unknown as HTMLIFrameElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function makePaginator(serverOverrides: Record<string, unknown> = {}) {
  const server = {
    textFor: () => "<html><body>chapter</body></html>",
    revokeAll: vi.fn(),
    ...serverOverrides,
  };
  const iframe = fakeIframe();
  const paginator = new ChapterPaginator(
    iframe,
    server as never,
    DEFAULT_SETTINGS,
    true,
    vi.fn(),
  );
  return { paginator, iframe, server };
}

describe("load restore report lifecycle and source ticket", () => {
  let createUrl: { mockRestore(): void };
  let revokeUrl: { mockRestore(): void };

  beforeEach(() => {
    vi.stubGlobal("window", { clearTimeout: (id: number) => clearTimeout(id) });
    createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:restore-test");
    revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    sanitizeMock.mockReset();
    sanitizeMock.mockImplementation(async () => ({
      html: "<html><body><epub-viewer id='epub-viewer'/></body></html>",
      issues: [],
      downgraded: false,
    }));
  });

  afterEach(() => {
    createUrl.mockRestore();
    revokeUrl.mockRestore();
    vi.unstubAllGlobals();
  });

  it("keeps the report after cleanupDoc and settles it with the load ticket", async () => {
    const gate = deferred<number>();
    const { paginator } = makePaginator({ acquireChapter: () => gate.promise });
    const settle = vi.fn();
    paginator.setRestoreResultHandler(settle);
    const ticket = { session: 4, request: 9, chapterPath: "chapter.xhtml" };

    const load = paginator.load("chapter.xhtml", {
      readingAnchor: { index: -1, ratio: 0, anchorTextOffset: 12, anchorTextSnippet: "正文" },
      reportRestore: true,
      restoreTicket: ticket,
      fallbackPage: 3,
    });

    // The real load has run cleanupDoc before pausing at acquireChapter.
    // The old bug stored restoreReport before cleanup and lost it here.
    expect((paginator as unknown as { restoreReport: unknown }).restoreReport).toMatchObject({
      semantic: true,
      modern: true,
      ticket,
      loadSeq: 1,
    });

    expect((paginator as unknown as { pendingFallbackPage: number | null }).pendingFallbackPage).toBeNull();
    (paginator as unknown as { settleRestoreReport(value: boolean): void }).settleRestoreReport(true);
    expect(settle).toHaveBeenCalledWith({ located: true, ticket, loadSeq: 1 });

    gate.resolve(0);
    await load;
    paginator.dispose();
  });

  it("reports a semantic media target unresolved when the empty chapter cannot prove it", () => {
    const context = makeEmptyRecomputeContext(true);
    (ChapterPaginator.prototype as unknown as {
      recomputeInner(this: typeof context, useAnchor: boolean, loadSeq: number): void;
    }).recomputeInner.call(context, true, 1);
    expect(context.reports).toEqual([{ located: false, ticket: null, loadSeq: 1 }]);

    const scroll = makeEmptyScrollContext(true);
    (ChapterPaginator.prototype as unknown as {
      recomputeScroll(this: typeof scroll): void;
    }).recomputeScroll.call(scroll);
    expect(scroll.reports).toEqual([{ located: false, ticket: null, loadSeq: 1 }]);
  });

  it("keeps a no-target chapter start as a successful empty report", () => {
    const context = makeEmptyRecomputeContext(false);
    (ChapterPaginator.prototype as unknown as {
      recomputeInner(this: typeof context, useAnchor: boolean, loadSeq: number): void;
    }).recomputeInner.call(context, true, 1);
    expect(context.reports).toEqual([{ located: true, ticket: null, loadSeq: 1 }]);
  });
});

describe("explicit user commit source", () => {
  it("notifies only for a real userInitiated page commit", () => {
    const context = makeSetPageContext();
    const handler = vi.fn();
    (ChapterPaginator.prototype as unknown as {
      setUserCommitHandler(this: typeof context, handler: (() => void) | null): void;
    }).setUserCommitHandler.call(context, handler);

    (ChapterPaginator.prototype as unknown as {
      setPage(this: typeof context, page: number, options?: { userInitiated?: boolean }): void;
    }).setPage.call(context, 1, { userInitiated: true });
    expect(handler).toHaveBeenCalledTimes(1);

    (ChapterPaginator.prototype as unknown as {
      setPage(this: typeof context, page: number, options?: { userInitiated?: boolean }): void;
    }).setPage.call(context, 2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not let preview/reflow paths through the user commit handler", () => {
    const context = makeSetPageContext();
    const handler = vi.fn();
    context.userCommitHandler = handler;
    (ChapterPaginator.prototype as unknown as {
      previewPagedScroll(this: typeof context, left: number): void;
    }).previewPagedScroll.call(context, 50);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("media and empty semantic targets", () => {
  const media: MediaReadingAnchor = {
    index: 0,
    tag: "img",
    signature: "img||||",
    ratio: 0.5,
  };

  it("adapts a media-only saved locator instead of dropping it as page zero", () => {
    expect(adaptNavigationAnchor({
      index: -1,
      ratio: 0,
      anchorTextOffset: null,
      anchorTextSnippet: null,
      mediaAnchor: media,
    })).toMatchObject({
      index: -1,
      ratio: media.ratio,
      textOffset: null,
      mediaAnchor: media,
    });
  });

  it("maps a media identity to its current spread instead of treating index=-1 as success", () => {
    const context = makeMediaResolveContext(media);
    const resolved = (ChapterPaginator.prototype as unknown as {
      resolveAnchorCol(this: typeof context): { col: number; source: string } | null;
    }).resolveAnchorCol.call(context);
    expect(resolved).toEqual({ col: 0, source: "media" });
  });

  it("returns null when the saved media signature is gone", () => {
    const context = makeMediaResolveContext({
      ...media,
      signature: "img||stale||",
    });
    const resolved = (ChapterPaginator.prototype as unknown as {
      resolveAnchorCol(this: typeof context): { col: number; source: string } | null;
    }).resolveAnchorCol.call(context);
    expect(resolved).toBeNull();
  });
});

function makeSetPageContext() {
  const context = Object.create(ChapterPaginator.prototype) as Record<string, unknown>;
  Object.defineProperties(context, {
    viewStepPx: { value: 100, writable: true, configurable: true },
    scrollMode: { value: false, writable: true, configurable: true },
  });
  return Object.assign(context, {
    viewer: { scrollLeft: 0 },
    metrics: { pageCount: 4, currentPage: 0 },
    spreadLayout: null,
    pageMotion: null,
    adoptedPageUncommitted: false,
    userCommitHandler: null as (() => void) | null,
    footnotePinned: false,
    footnoteHoverGate: { isVisible: () => false },
    closeFootnoteForNavigation() {},
    clearSearchHighlightForDocument() {},
    scheduleAnchorSample() {},
    emit() {},
  });
}

function makeEmptyRecomputeContext(semantic: boolean) {
  const context = Object.assign(Object.create(ChapterPaginator.prototype), {
    loadSeq: 1,
    viewer: { scrollLeft: 0, clientWidth: 800, clientHeight: 600 },
    step: 100,
    textIndex: {},
    spreadGeometry: { columns: 1, columnStep: 100, columnWidth: 100, viewportWidth: 800, gap: 0 },
    bookmarkSpreadCache: new Map(),
    collectContentFragments: () => [],
    removeTailSpacer() {},
    metrics: { pageCount: 1, currentPage: 0 },
    effectiveColumns: 1,
    leadingColumns: 0,
    restoreReport: { semantic, ticket: null as { session: number; request: number; chapterPath: string } | null, loadSeq: 1 },
    reports: [] as Array<{ located: boolean; ticket: unknown; loadSeq: number }>,
    emit() {},
  });
  (context as unknown as { restoreResultHandler: (result: unknown) => void }).restoreResultHandler = (result) => {
    context.reports.push(result as { located: boolean; ticket: unknown; loadSeq: number });
  };
  return context;
}

function makeEmptyScrollContext(semantic: boolean) {
  const context = Object.assign(Object.create(ChapterPaginator.prototype), {
    loadSeq: 1,
    viewer: { scrollTop: 0 },
    getContinuousContentHeight: () => 0,
    pendingFallbackPage: 3,
    pendingAnchor: "x",
    pendingStartAtEnd: true,
    pendingRestoreAnchor: {},
    metrics: { pageCount: 4, currentPage: 2 },
    scrollPageCount: 4,
    lastScrollTop: 0,
    restoreReport: { semantic, ticket: null as { session: number; request: number; chapterPath: string } | null, loadSeq: 1 },
    reports: [] as Array<{ located: boolean; ticket: unknown; loadSeq: number }>,
    readyState: (empty: boolean) => ({ status: "ready", pageCount: 1, currentPage: 0, empty }),
    emit() {},
  });
  (context as unknown as { restoreResultHandler: (result: unknown) => void }).restoreResultHandler = (result) => {
    context.reports.push(result as { located: boolean; ticket: unknown; loadSeq: number });
  };
  return context;
}

function makeMediaResolveContext(anchor: MediaReadingAnchor) {
  const el = {
    tagName: "IMG",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 50, top: 10, width: 100, height: 200, right: 150, bottom: 210 }),
  };
  return Object.assign(Object.create(ChapterPaginator.prototype), {
    disposed: false,
    _currentPath: "chapter.xhtml",
    anchorPath: "chapter.xhtml",
    viewer: {
      scrollLeft: 0,
      clientLeft: 0,
      querySelectorAll: (selector: string) => selector === "img, svg, video" ? [el] : [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    },
    contentDoc: {},
    step: 100,
    effectiveColumns: 1,
    leadingColumns: 0,
    spreadLayout: null,
    metrics: { pageCount: 1, currentPage: 0 },
    anchor: { index: -1, ratio: anchor.ratio, charsRead: 0, totalChars: 0, textOffset: null, textSnippet: null, mediaAnchor: anchor },
  });
}


describe("modern restore identity and meaningful user movement", () => {
  it("a missing modern text cannot restore through a surviving legacy element", () => {
    const context = makeModernRestoreContext(true);
    context.recomputeInner(true, 1);
    expect(context.reports).toEqual([{ located: false, ticket: null, loadSeq: 1 }]);
    expect(context.metrics.currentPage).toBe(0);
    expect(context.viewer.scrollLeft).toBe(0);
  });

  it("a missing modern text cannot commit a within-chapter legacy candidate", () => {
    const context = makeModernRestoreContext(true);
    const anchorBefore = context.anchor;
    expect(context.navigateWithinCurrentChapter({
      readingAnchor: { index: 0, ratio: 0, anchorTextOffset: 0, anchorTextSnippet: "已消失" },
      fallbackPage: 1,
    })).toBe(false);
    expect(context.anchor).toBe(anchorBefore);
    expect(context.viewer.scrollLeft).toBe(0);
  });

  it("a scrolling restore with missing modern text ignores the element and saved page", () => {
    const context = makeModernRestoreContext(true);
    context.viewer.scrollHeight = 2400;
    context.viewer.clientHeight = 600;
    expect(context.applyScrollRestore(1, context.anchor)).toBe(false);
    expect(context.viewer.scrollTop).toBe(0);
  });

  it("legacy-only records still restore to their element", () => {
    const context = makeModernRestoreContext(false);
    context.recomputeInner(true, 1);
    expect(context.reports).toEqual([{ located: true, ticket: null, loadSeq: 1 }]);
    expect(context.metrics.currentPage).toBe(1);
  });

  it("a valid modern text still commits its resolved spread", () => {
    const context = makeModernRestoreContext(true);
    context.anchor.textSnippet = "新内容";
    context.resolveTextAnchorCol = () => 1;
    context.textIndex.snippetAt = () => "新内容";
    context.recomputeInner(true, 1);
    expect(context.reports).toEqual([{ located: true, ticket: null, loadSeq: 1 }]);
    expect(context.metrics.currentPage).toBe(1);
  });

  it("a spread no-op does not unlock progress but a real move or adopted position does", () => {
    const context = makeModernRestoreContext(false);
    context.spreadLayout = createSpreadLayout(createSpreadGeometry(800, 24, 2), { first: 0, last: 3 });
    context.metrics = { pageCount: 2, currentPage: 0 };
    const handler = vi.fn();
    context.setUserCommitHandler(handler);
    context.setPage(0, { userInitiated: true });
    expect(handler).not.toHaveBeenCalled();
    context.setPage(1, { userInitiated: true });
    expect(handler).toHaveBeenCalledTimes(1);
    context.setPage(1, { userInitiated: true });
    expect(handler).toHaveBeenCalledTimes(1);
    context.adoptedPageUncommitted = true;
    context.setPage(1, { userInitiated: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("a scrolling page command only notifies when it moved", () => {
    const context = makeSetPageContext() as any;
    Object.defineProperty(context, "scrollMode", { value: true, configurable: true });
    context.haltPageMotion = () => {};
    context.scrollByViewport = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const handler = vi.fn();
    context.setUserCommitHandler(handler);
    context.setPage(1, { userInitiated: true });
    expect(handler).not.toHaveBeenCalled();
    context.setPage(1, { userInitiated: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

function makeModernRestoreContext(modern: boolean): any {
  const element = {
    getBoundingClientRect: () => ({ left: 824, top: 800, width: 100, height: 80 }),
  };
  const context: any = Object.assign(makeSetPageContext(), {
    disposed: false,
    _currentPath: "chapter.xhtml",
    anchorPath: "chapter.xhtml",
    iframe: { contentWindow: null },
    contentDoc: {},
    viewer: {
      scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientWidth: 800, clientHeight: 600,
      querySelectorAll: () => [element],
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    },
    loadSeq: 1, step: 824, effectiveColumns: 1, leadingColumns: 0,
    textIndex: { totalChars: 3, codePoints: Array.from("新内容"), snippetAt: () => "新内容" },
    anchor: {
      index: 0, ratio: 0, charsRead: 0, totalChars: 3,
      textOffset: modern ? 0 : null, textSnippet: modern ? "已消失" : null,
    },
    spreadGeometry: createSpreadGeometry(800, 24, 1),
    bookmarkSpreadCache: new Map(),
    collectContentFragments: () => [{ left: 0, right: 100 }, { left: 824, right: 924 }],
    pendingFallbackPage: 1,
    captureAnchor() {},
    haltPageMotion() {},
    restoreReport: { semantic: true, modern, ticket: null, loadSeq: 1 },
    reports: [] as unknown[],
    lastState: { status: "ready" },
  });
  context.readyState = () => ({ status: "ready", ...context.metrics });
  context.restoreResultHandler = (report: unknown) => context.reports.push(report);
  let scrollWidth = 800;
  Object.defineProperty(context, "viewportPort", { value: {
    ensureScrollWidth: (width: number) => { scrollWidth = Math.max(scrollWidth, width); },
    readScrollWidth: () => scrollWidth,
    readClientWidth: () => 800,
    readScrollLeft: () => context.viewer.scrollLeft,
    writeScrollLeft: (left: number) => { context.viewer.scrollLeft = left; },
  } });
  return context;
}
