import { createElement, StrictMode, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ReaderSettings, type Theme } from "../render/settings";
import { createReactDomHarness } from "../test/reactDomHarness";
import { useReadingInputStart } from "./readerPointerEdge";
import type { ReaderHandle } from "./ReaderView";
import { useThemeTransition } from "./themeTransitionHost";

/** startViewTransition whose update callbacks the test runs by hand, like a browser after the snapshot. */
function installViewTransitions(doc: Document) {
  const transitions: Array<{ update: () => void; skipTransition: ReturnType<typeof vi.fn>; finish: () => void }> = [];
  (doc as unknown as { startViewTransition: unknown }).startViewTransition = vi.fn((update: () => void) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    // A skipped transition still runs its update callback; only the decoration is dropped.
    const entry = { update, skipTransition: vi.fn(() => finish()), finish };
    transitions.push(entry);
    return { ready: new Promise(() => {}), finished, skipTransition: entry.skipTransition };
  });
  return transitions;
}

type Api = {
  transition: ReturnType<typeof useThemeTransition>;
  setSettings: Dispatch<SetStateAction<ReaderSettings>>;
};

/** App's wiring in miniature: settings state, the `.app` root that renders its theme, a live reader handle. */
function Host(props: { api: { current: Api | null }; reader: ReaderHandle | null; busy?: () => boolean; onError(error: unknown): void; doc: Document }) {
  const [settings, setSettings] = useState<ReaderSettings>({ ...DEFAULT_SETTINGS, theme: "light", fontSizePx: 18 });
  const committed = useRef(settings.theme);
  committed.current = settings.theme;
  const transition = useThemeTransition({
    setSettings,
    committedTheme: () => committed.current,
    reader: () => props.reader,
    busy: props.busy ?? (() => false),
    onError: props.onError,
    host: { document: props.doc, isMotionReduced: () => false, isBackgrounded: () => false },
  });
  useReadingInputStart(true, transition.interrupt);
  props.api.current = { transition, setSettings };
  return createElement("div", { className: "app", "data-theme": settings.theme, "data-font": settings.fontSizePx });
}

async function mount(options: { reader?: ReaderHandle | null; busy?: () => boolean } = {}) {
  const dom = createReactDomHarness({ frames: true });
  const doc = dom.container.ownerDocument;
  const win = dom.window;
  const transitions = installViewTransitions(doc);
  const api: { current: Api | null } = { current: null };
  const onError = vi.fn();
  // StrictMode runs effect setup → cleanup → setup: the first controller is disposed, the second one serves.
  await dom.render(createElement(StrictMode, null, createElement(Host, { api, reader: options.reader ?? null, busy: options.busy, onError, doc })));
  const app = () => doc.querySelector(".app")!;
  return { dom, doc, win, transitions, api: () => api.current!, onError, app };
}

describe("theme transition wired into the app", () => {
  it("leaves the React root, html/body and every live body host on the new theme when the update callback returns, writing only the theme leaf", async () => {
    const seen: Array<{ theme: Theme; app: string | null }> = [];
    let doc!: Document;
    const reader = { applyTheme: vi.fn((theme: Theme) => seen.push({ theme, app: doc.querySelector(".app")!.getAttribute("data-theme") })) } as unknown as ReaderHandle;
    const t = await mount({ reader });
    doc = t.doc;
    try {
      await t.dom.run(() => t.api().transition.changeTheme("dark"));
      expect(t.transitions).toHaveLength(1);
      // Snapshot pending: nothing committed yet, the screen still shows the old theme.
      expect(t.app().getAttribute("data-theme")).toBe("light");
      expect(t.doc.documentElement.hasAttribute("data-theme-transitioning")).toBe(true);
      // A font change lands while the snapshot is pending.
      await t.dom.run(() => t.api().setSettings((s) => ({ ...s, fontSizePx: 22 })));

      let atReturn: Record<string, string | null> = {};
      await t.dom.run(() => {
        t.transitions[0].update();
        // Read synchronously, before act or any effect could catch up.
        atReturn = {
          app: t.app().getAttribute("data-theme"),
          html: t.doc.documentElement.getAttribute("data-theme"),
          body: t.doc.body.getAttribute("data-theme"),
          font: t.app().getAttribute("data-font"),
        };
      });
      expect(atReturn).toEqual({ app: "dark", html: "dark", body: "dark", font: "22" });
      // Body hosts were recolored after the React root had already rendered the new theme.
      expect(seen).toEqual([{ theme: "dark", app: "dark" }]);

      await t.dom.run(async () => { t.transitions[0].finish(); await Promise.resolve(); });
      expect(t.doc.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
    } finally {
      await t.dom.dispose();
    }
  });

  it("rapid switches commit only the latest once; restore defaults and busy reading commit directly and supersede a pending theme", async () => {
    let busy = false;
    const reader = { applyTheme: vi.fn() } as unknown as ReaderHandle;
    const t = await mount({ reader, busy: () => busy });
    try {
      await t.dom.run(() => t.api().transition.changeTheme("dark"));
      await t.dom.run(() => t.api().transition.changeTheme("sepia"));
      expect(t.transitions[0].skipTransition).toHaveBeenCalled();
      // The superseded callback still runs (skip does not cancel it) but commits nothing.
      await t.dom.run(() => t.transitions[0].update());
      expect(t.app().getAttribute("data-theme")).toBe("light");
      await t.dom.run(() => t.transitions[1].update());
      expect(t.app().getAttribute("data-theme")).toBe("sepia");
      expect((reader.applyTheme as ReturnType<typeof vi.fn>).mock.calls).toEqual([["sepia"]]);

      // Restore defaults (theme + geometry) while a theme is pending: direct, and the late callback is void.
      await t.dom.run(() => t.api().transition.changeTheme("gray"));
      await t.dom.run(() => t.api().transition.commitSettings(() => t.api().setSettings({ ...DEFAULT_SETTINGS, fontSizePx: 30 })));
      await t.dom.run(() => t.transitions[2].update());
      expect(t.app().getAttribute("data-theme")).toBe(DEFAULT_SETTINGS.theme);
      expect(t.app().getAttribute("data-font")).toBe("30");

      // A chapter still loading: no transition, committed at once.
      busy = true;
      await t.dom.run(() => t.api().transition.changeTheme("dark"));
      expect(t.transitions).toHaveLength(3);
      expect(t.app().getAttribute("data-theme")).toBe("dark");
      expect(t.doc.body.getAttribute("data-theme")).toBe("dark");
    } finally {
      await t.dom.dispose();
    }
  });

  it("reading input inside a chapter frame commits the pending theme at once; a failed commit is reported; unmount commits nothing", async () => {
    const reader = { applyTheme: vi.fn() } as unknown as ReaderHandle;
    const t = await mount({ reader });
    const host = t.doc.createElement("div");
    host.className = "reader-presentation-host";
    t.doc.body.appendChild(host);
    const frame = t.doc.createElement("iframe");
    const chapter = parseHTML("<html><body><p>chapter</p></body></html>").document;
    Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => chapter });
    host.appendChild(frame);
    try {
      // The frame arrives after mount, as a chapter load does.
      await t.dom.run(() => { frame.dispatchEvent(new t.win.Event("load", { bubbles: true })); });
      await t.dom.run(() => t.api().transition.changeTheme("dark"));
      // A page-turn press inside the chapter: chapter events never bubble to the app document.
      await t.dom.dispatch(chapter as unknown as Element, new t.win.Event("pointerdown"));
      expect(t.app().getAttribute("data-theme")).toBe("dark");
      expect(t.transitions[0].skipTransition).toHaveBeenCalled();
      expect(t.doc.documentElement.hasAttribute("data-theme-transitioning")).toBe(false);
      // The browser's later callback finds the target already committed.
      await t.dom.run(() => t.transitions[0].update());
      expect((reader.applyTheme as ReturnType<typeof vi.fn>).mock.calls).toEqual([["dark"]]);

      // A host that fails to recolor: the error reaches the app's error entry.
      const failure = new Error("frame detached");
      (reader.applyTheme as ReturnType<typeof vi.fn>).mockImplementation(() => { throw failure; });
      await t.dom.run(() => t.api().transition.changeTheme("sepia"));
      await t.dom.run(() => { expect(() => t.transitions[1].update()).toThrow(failure); });
      expect(t.onError).toHaveBeenCalledWith(failure);

      // Unmount with a theme pending: the late callback touches nothing.
      (reader.applyTheme as ReturnType<typeof vi.fn>).mockReset();
      await t.dom.run(() => t.api().transition.changeTheme("gray"));
      const late = t.transitions[2];
      const html = t.doc.documentElement;
      await t.dom.render(null);
      late.update();
      expect(html.getAttribute("data-theme")).not.toBe("gray");
      expect(reader.applyTheme).not.toHaveBeenCalled();
      expect(html.hasAttribute("data-theme-transitioning")).toBe(false);
    } finally {
      await t.dom.dispose();
    }
  });
});
