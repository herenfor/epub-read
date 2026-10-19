import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { vi } from "vitest";

export type ComputedStyleStub = (element: Element) => Partial<CSSStyleDeclaration>;
export type RectStub = Partial<Pick<DOMRect, "left" | "top" | "width" | "height">>;

/**
 * linkedom parses and dispatches events but lays nothing out. Components only
 * need some browser APIs to exist (observers, frames, media queries) and need
 * fixed answers from others (computed style, element metrics); these options
 * install them. Each one is also a harness method for tests that add it later.
 */
export interface ReactDomHarnessOptions {
  /** An inert ResizeObserver: nothing is ever resized. */
  resizeObserver?: boolean;
  /** requestAnimationFrame on setTimeout (true = 16ms), so fake timers drive frames. */
  animationFrames?: boolean | number;
  /** getComputedStyle answers, on both the window and the global scope. */
  computedStyle?: ComputedStyleStub;
  /** matchMedia(query).matches; change listeners are inert. */
  matchMedia?: (query: string) => boolean;
  /** linkedom's own iframe and MutationObserver classes as globals. */
  frames?: boolean;
}

const FRAME_MS = 16;

/** Real React event/effect ordering, without pretending to measure iframe layout. */
export function createReactDomHarness(options: ReactDomHarnessOptions = {}) {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const win = window as unknown as Window & typeof globalThis;
  // linkedom shares element classes between windows, so anything patched on a
  // prototype outlives this harness unless dispose() puts it back.
  const restores: Array<() => void> = [];
  const define = (target: object, key: PropertyKey, descriptor: PropertyDescriptor): void => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restores.push(() => {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    });
  };
  /**
   * Both spellings code uses: `window.x` and the bare global `x`. linkedom's
   * window falls through to globalThis for names it lacks, so the global stub
   * goes first: dispose() then unwinds the window definition back to it before
   * unstubbing the globals.
   */
  const install = (name: string, value: unknown): void => {
    vi.stubGlobal(name, value);
    define(win, name, { value, writable: true });
  };

  // linkedom's CSSStyleDeclaration lacks priorities; real browsers always have them.
  const styleProto = Object.getPrototypeOf(window.document.body.style) as {
    getPropertyPriority?: (property: string) => string;
  };
  if (typeof styleProto.getPropertyPriority !== "function") styleProto.getPropertyPriority = () => "";
  window.innerWidth = 1024;
  window.innerHeight = 768;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("Element", window.Element);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = window.document.getElementById("root") as unknown as HTMLElement;
  const root = createRoot(container);

  const harness = {
    container,
    window: win,
    async render(node: ReactNode) { await act(async () => root.render(node)); },
    async click(element: Element) {
      await act(async () => { element.dispatchEvent(new window.Event("click", { bubbles: true })); });
    },
    async dispatch(element: Element, event: Event) {
      await act(async () => { element.dispatchEvent(event); });
    },
    async run(fn: () => void | Promise<void>) {
      await act(async () => { await fn(); });
    },

    /** Object.defineProperty that dispose() undoes, for any one-off layout answer. */
    define,
    /** Fixed numeric getters such as clientWidth or offsetTop. */
    metrics(target: object, values: Readonly<Record<string, number>>) {
      for (const [key, value] of Object.entries(values)) define(target, key, { get: () => value });
    },
    /** getBoundingClientRect from a box (or per element); right/bottom/x/y are derived. */
    rect(target: object, box: RectStub | ((element: HTMLElement) => RectStub)) {
      define(target, "getBoundingClientRect", {
        writable: true,
        value(this: HTMLElement) { return domRect(typeof box === "function" ? box(this) : box); },
      });
    },
    resizeObserver() {
      install("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    },
    animationFrames(delay = FRAME_MS) {
      install("requestAnimationFrame", (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), delay) as unknown as number);
      install("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
    },
    computedStyle(styles: ComputedStyleStub) {
      install("getComputedStyle", (element: Element) => computedStyle(styles(element)));
    },
    matchMedia(matches: (query: string) => boolean) {
      define(win, "matchMedia", {
        writable: true,
        value: (media: string) => ({
          media, matches: matches(media), onchange: null,
          addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
          dispatchEvent: () => false,
        }),
      });
    },
    frames() {
      vi.stubGlobal("HTMLIFrameElement", win.HTMLIFrameElement);
      vi.stubGlobal("MutationObserver", win.MutationObserver);
    },

    async dispose() {
      await act(async () => root.unmount());
      while (restores.length > 0) restores.pop()!();
      vi.unstubAllGlobals();
    },
  };

  if (options.resizeObserver) harness.resizeObserver();
  if (options.animationFrames !== undefined && options.animationFrames !== false) {
    harness.animationFrames(options.animationFrames === true ? FRAME_MS : options.animationFrames);
  }
  if (options.computedStyle) harness.computedStyle(options.computedStyle);
  if (options.matchMedia) harness.matchMedia(options.matchMedia);
  if (options.frames) harness.frames();
  return harness;
}

function domRect({ left = 0, top = 0, width = 0, height = 0 }: RectStub): DOMRect {
  const box = { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  return { ...box, toJSON: () => box } as DOMRect;
}

/** Unlisted properties read as "", as a real declaration's unset ones do. */
function computedStyle(styles: Partial<CSSStyleDeclaration>): CSSStyleDeclaration {
  if (typeof styles.getPropertyValue === "function") return styles as CSSStyleDeclaration;
  const values = styles as Record<string, unknown>;
  return {
    ...styles,
    getPropertyValue: (property: string) => {
      const value = values[property] ?? values[property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())];
      return typeof value === "string" ? value : "";
    },
  } as CSSStyleDeclaration;
}
