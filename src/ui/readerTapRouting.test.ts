import { act, createElement, createRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ReaderSettings } from "../render/settings";
import type { Book } from "../core/types";
import { createReactDomHarness } from "../test/reactDomHarness";
import { computeTapRegionGeometry, DEFAULT_READER_TAP_PREFERENCES, type ReaderTapPreferences } from "./readerTapRegions";
import { edgeTurnOverlayOf, edgeTurnZoneSpecs, ReaderTurnOwnerContext, routeReaderTap } from "./readerTapRouting";
import { readTapRegionPreferences, TAP_REGION_PREFERENCES_KEY, writeTapRegionPreferences } from "./tapRegionPreferences";

const instances = vi.hoisted(() => [] as MockPaginator[]);
class MockPaginator {
  isDisplayReady = false;
  state: { status: string; empty?: boolean; pageCount?: number; currentPage?: number } = { status: "loading" };
  currentPage = 0;
  pageCount = 5;
  pageMotionAvailable = false;
  motionBeginDrag = vi.fn(() => null);
  prepareMotion() {}
  setMotionWindowForeground = vi.fn();
  endMotionContact() {}
  path = "";
  callbacks: unknown[];
  settings: ReaderSettings;
  constructor(...args: unknown[]) {
    this.settings = args[2] as ReaderSettings;
    this.callbacks = args;
    instances.push(this);
  }
  load = vi.fn(async (path: string) => {
    this.path = path;
    this.state = { status: "loading" };
    (this.callbacks[4] as Function)(this.state);
  });
  loadAndWaitForDisplay = vi.fn(async (path: string) => { await this.load(path); return true; });
  finish() {
    this.isDisplayReady = true;
    this.state = { status: "ready", empty: false, pageCount: this.pageCount, currentPage: this.currentPage };
    (this.callbacks[4] as Function)(this.state);
    (this.callbacks[15] as Function)();
  }
  /** The body-tap entry ReaderView hands to the paginator (iframe client coordinates). */
  tap(clientX: number, pointerType: "touch" | "mouse" = "mouse") {
    (this.callbacks[this.callbacks.length - 2] as Function)({ clientX, clientY: 300, pointerType });
  }
  getStateSnapshot() { return this.state; }
  getCurrentPath() { return this.path; }
  setNotes() {}
  pagedSlideFrame = vi.fn(() => null);
  planPagedTurn = vi.fn((direction: 1 | -1, hasAdjacentChapter: boolean) => {
    const target = this.currentPage + direction;
    if (target >= 0 && target < this.pageCount) {
      return { kind: "page", page: target, from: this.currentPage * 100, to: target * 100 };
    }
    return hasAdjacentChapter ? { kind: "chapter", direction, fromPage: this.currentPage } : { kind: "book-edge", page: this.currentPage };
  });
  previewPagedScroll = vi.fn();
  setPage = vi.fn((page: number) => {
    this.currentPage = page;
    this.state = { ...this.state, currentPage: page };
    (this.callbacks[4] as Function)(this.state);
  });
  navigateToSearchTarget() { return "unresolved" as const; }
  closeForNavigation() {}
  clearSearchHighlight() {}
  resetWheelAccumulator() {}
  dispose() {}
}

vi.mock("../render/paginator", () => ({
  ChapterPaginator: class { constructor(...args: unknown[]) { return new MockPaginator(...args); } },
}));

import { ReaderView, type ReaderHandle } from "./ReaderView";

const custom = (left: number, right: number, touchLeftTapForward = false): ReaderTapPreferences => ({
  pc: { mode: "custom", custom: { left, right } },
  touch: { mode: "custom", custom: { left, right } },
  touchLeftTapForward,
});

describe("tap routing geometry", () => {
  it("routes by where the tap fell in the host, and PC ignores the touch-only left-forward option", () => {
    const geometry = computeTapRegionGeometry(1000, custom(30, 20).pc);
    const prefs = custom(30, 20, true);
    const pc = { device: "pc" as const, preferences: prefs, geometry };
    const touch = { device: "touch" as const, preferences: prefs, geometry };
    // Host starts at x=100 in the window: the band is measured from the host, not the window.
    expect(routeReaderTap(pc, 100, 350)).toEqual({ kind: "turn", side: "left", direction: -1 });
    expect(routeReaderTap(touch, 100, 350)).toEqual({ kind: "turn", side: "left", direction: 1 });
    expect(routeReaderTap(pc, 100, 450)).toEqual({ kind: "center" });
    expect(routeReaderTap(pc, 100, 950)).toEqual({ kind: "turn", side: "right", direction: 1 });
    expect(routeReaderTap(pc, 100, 50)).toEqual({ kind: "outside" });
  });

  it("never widens the transparent band past the default; default mode keeps the old markup", () => {
    const wide = computeTapRegionGeometry(1000, custom(35, 3).pc);
    expect(edgeTurnOverlayOf(wide, "left")?.width).toBe(50);
    expect(edgeTurnOverlayOf(wide, "right")?.width).toBe(30);
    expect(edgeTurnOverlayOf(computeTapRegionGeometry(1000, custom(0, 10).pc), "left")?.width).toBe(0);
    expect(edgeTurnOverlayOf(computeTapRegionGeometry(1000, { mode: "default" }), "left")).toBeUndefined();

    expect(edgeTurnZoneSpecs(null)).toEqual([{ side: "left", direction: -1 }, { side: "right", direction: 1 }]);
    const geometry = computeTapRegionGeometry(1000, { mode: "default" });
    const feedback = { hold: vi.fn() } as never;
    const specs = edgeTurnZoneSpecs({ device: "touch", preferences: { ...DEFAULT_READER_TAP_PREFERENCES, touchLeftTapForward: true },
      geometry, hostLeft: () => 0, feedback });
    // The left band moves nowhere; only what it executes changes.
    expect(specs[0]).toEqual({ side: "left", direction: 1, sideProp: "left", region: undefined });
    expect(specs[1]).toEqual({ side: "right", direction: 1, sideProp: undefined, region: undefined });
  });
});

describe("tap region preferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores one local record and falls back to the defaults when missing or damaged", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    expect(readTapRegionPreferences()).toEqual(DEFAULT_READER_TAP_PREFERENCES);
    writeTapRegionPreferences(custom(12, 40, true));
    expect([...values.keys()]).toEqual([TAP_REGION_PREFERENCES_KEY]);
    // Values are clamped to 0-35 on the way in and out.
    expect(readTapRegionPreferences()).toEqual(custom(12, 35, true));
    values.set(TAP_REGION_PREFERENCES_KEY, "{broken");
    expect(readTapRegionPreferences()).toEqual(DEFAULT_READER_TAP_PREFERENCES);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(readTapRegionPreferences()).toEqual(DEFAULT_READER_TAP_PREFERENCES);
    expect(() => writeTapRegionPreferences(custom(1, 1))).not.toThrow();
  });
});

describe("body taps in the paged reader", () => {
  let dom: ReturnType<typeof createReactDomHarness>;
  let props: ComponentProps<typeof ReaderView>;

  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
    dom = createReactDomHarness();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    // The host, the reader box and the iframe all span x 0-1000.
    const proto = (window as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 1000 });
    Object.defineProperty(proto, "getBoundingClientRect", { configurable: true,
      value: () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0 }) });
    const book = {
      version: 3,
      opfPath: "book.opf",
      fixedLayout: false,
      spine: [0, 1, 2].map((i) => ({ idref: String(i), linear: true })),
      manifest: new Map([0, 1, 2].map((i) => [String(i), { href: `${i}.xhtml` }])),
    } as Book;
    props = {
      book,
      server: { revokeAll: vi.fn(), textFor: vi.fn(() => "<html></html>") } as unknown as ComponentProps<typeof ReaderView>["server"],
      settings: { ...DEFAULT_SETTINGS, turnAnimation: "none" },
      userFonts: [],
      notes: [],
      spineIndex: 0,
      anchorNonce: 0,
      startAtEnd: { nonce: 0, atEnd: false },
      onPageState: vi.fn(),
      onDisplayReady: vi.fn(),
      onRequestChapter: vi.fn(),
      onIssues: vi.fn(),
      onInternalLink: vi.fn(),
      onBeforeInternalNavigate: vi.fn(),
      onInternalNavigationSettled: vi.fn(),
      onExternalLink: vi.fn(),
      onFootnote: vi.fn(),
      onFootnoteClose: vi.fn(),
    };
  });

  afterEach(async () => {
    await dom.dispose();
    vi.useRealTimers();
  });

  const start = async (extra: Partial<ComponentProps<typeof ReaderView>>, wrap?: (node: ReturnType<typeof createElement>) => ReturnType<typeof createElement>) => {
    const node = createElement(ReaderView, { ...props, ...extra, ref: createRef<ReaderHandle>() });
    await dom.render(wrap ? wrap(node) : node);
    const active = instances[0];
    await act(async () => { active.finish(); vi.advanceTimersByTime(300); });
    return active;
  };
  const zone = (side: "left" | "right") =>
    [...dom.container.querySelectorAll(".edge-turn-zone")][side === "left" ? 0 : 1] as HTMLElement;

  it("PC: a wide custom side turns from the body, with feedback on that band; the middle does nothing", async () => {
    const onPlainTap = vi.fn();
    const active = await start({ tapRegions: { device: "pc", preferences: custom(30, 30) }, onPlainTap: undefined });
    // The transparent bands stay at the default 50px.
    expect(zone("left").style.width).toBe("50px");
    expect(zone("right").style.width).toBe("50px");

    await dom.run(() => active.tap(850));
    expect(active.setPage).toHaveBeenLastCalledWith(1, { userInitiated: true });
    expect(zone("right").classList.contains("is-holding")).toBe(true);
    expect(zone("left").classList.contains("is-holding")).toBe(false);

    await dom.run(() => active.tap(150));
    expect(active.setPage).toHaveBeenLastCalledWith(0, { userInitiated: true });

    active.setPage.mockClear();
    await dom.run(() => active.tap(500));
    expect(active.setPage).not.toHaveBeenCalled();
    expect(onPlainTap).not.toHaveBeenCalled();
  });

  it("touch: the middle toggles the menu once and never turns; left-forward turns ahead from the left", async () => {
    const onPlainTap = vi.fn();
    const active = await start({ tapRegions: { device: "touch", preferences: custom(30, 30, true) }, onPlainTap });
    await dom.run(() => active.tap(500, "touch"));
    expect(onPlainTap).toHaveBeenCalledTimes(1);
    expect(active.setPage).not.toHaveBeenCalled();

    await dom.run(() => active.tap(150, "touch"));
    expect(active.setPage).toHaveBeenLastCalledWith(1, { userInitiated: true });
    expect(onPlainTap).toHaveBeenCalledTimes(1);
    expect(zone("left").getAttribute("data-edge-action")).toBe("next");
  });

  it("without settings the body keeps the old behaviour: every plain tap goes to the host", async () => {
    const onPlainTap = vi.fn();
    const active = await start({ onPlainTap });
    await dom.run(() => active.tap(990, "touch"));
    expect(onPlainTap).toHaveBeenCalledTimes(1);
    expect(active.setPage).not.toHaveBeenCalled();
    expect(zone("left").className).toBe("edge-turn-zone edge-turn-prev");
  });

  it("a page nested in a turn owner (image spread leaf) hands the turn to the owner", async () => {
    const owner = vi.fn();
    const active = await start({ tapRegions: { device: "pc", preferences: custom(30, 30) } },
      (node) => createElement(ReaderTurnOwnerContext.Provider, { value: owner }, node));
    await dom.run(() => active.tap(900));
    expect(owner).toHaveBeenCalledWith(1);
    expect(active.setPage).not.toHaveBeenCalled();
  });
});
