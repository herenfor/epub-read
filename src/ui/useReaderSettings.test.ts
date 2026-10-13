import { createElement, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../render/settings";
import { createReactDomHarness } from "../test/reactDomHarness";
import { readSavedSettings, toSavedReaderSettings, writeSavedSettings } from "./storage";
import { useThemeTransition } from "./themeTransitionHost";
import { useReaderSettings, useReaderSettingsPersistence } from "./useReaderSettings";

type SettingsApi = ReturnType<typeof useReaderSettings>;
type Api = SettingsApi & { transition: ReturnType<typeof useThemeTransition> };

function Host(props: { api: { current: Api | null }; unrelated?: number }) {
  const state = useReaderSettings();
  const theme = useRef(state.settings.theme);
  theme.current = state.settings.theme;
  const transition = useThemeTransition({
    setSettings: state.setSettings,
    committedTheme: () => theme.current,
    reader: () => null,
    busy: () => false,
    onError: (error) => { throw error; },
    host: { document, isMotionReduced: () => false, isBackgrounded: () => false },
  });
  useReaderSettingsPersistence(state.settings, state.uiScale);
  props.api.current = { ...state, transition };
  return createElement("div", { "data-theme": state.settings.theme }, props.unrelated);
}

function setup() {
  const dom = createReactDomHarness();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const api: { current: Api | null } = { current: null };
  return { dom, values, api, current: () => api.current! };
}

describe("reader settings extracted from App", () => {
  it("keeps callback identities and applies retained callbacks to the latest queued state", async () => {
    const t = setup();
    try {
      await t.dom.render(createElement(Host, { api: t.api }));
      const actions = t.current().settingsActions;
      await t.dom.run(() => {
        t.current().setSettings((s) => ({ ...s, fontSizePx: 26, theme: "dark", customCss: "p{color:red}" }));
        actions.increaseFont();
        actions.increaseFont();
        actions.setGap(44);
      });
      expect(t.current().settings).toMatchObject({
        fontSizePx: 30, theme: "dark", customCss: "p{color:red}", gapPx: 44, spreadGapMode: "manual",
      });
      await t.dom.render(createElement(Host, { api: t.api, unrelated: 1 }));
      expect(t.current().settingsActions).toBe(actions);
      await t.dom.run(() => actions.setFontSize(100));
      expect(t.current().settings.fontSizePx).toBe(32);
      const before = t.current().settings;
      await t.dom.run(() => actions.increaseFont());
      expect(t.current().settings).toBe(before);
      await t.dom.run(() => { actions.setLineHeight(5); actions.setUiScale(1.2); });
      expect(t.current().settings.lineHeight).toBe(2.4);
      expect(t.current().uiScale).toBe(1.2);
      await t.dom.run(() => actions.resetLineHeight());
      expect(t.current().settings.lineHeight).toBeUndefined();
    } finally {
      await t.dom.dispose();
    }
  });

  it("restores saved settings on remount without persisting runtime font resources", async () => {
    const t = setup();
    try {
      writeSavedSettings({ theme: "sepia", fontSizePx: 22, uiScale: 1.15, readingMode: "scroll", gapPx: 36, spreadGapMode: "manual" });
      await t.dom.render(createElement(Host, { api: t.api }));
      expect(t.current().settings).toMatchObject({ theme: "sepia", fontSizePx: 22, readingMode: "scroll", gapPx: 36 });
      expect(t.current().uiScale).toBe(1.15);
      await t.dom.run(() => {
        t.current().settingsActions.selectImportedFont({ id: "font-id", family: "User font" });
        t.current().settingsActions.setForceFontOverride(true);
        t.current().setSettings((s) => ({ ...s, fontFamily: "Resolved font", customFonts: [{ family: "User font", url: "blob:session" }] }));
      });
      const saved = readSavedSettings();
      expect(saved).toEqual(toSavedReaderSettings(t.current().settings, t.current().uiScale));
      expect(saved).toMatchObject({ customFontId: "font-id", customFontName: "User font", fontSource: "imported", forceFontOverride: true });
      expect(t.values.get("epub-reader:settings")).not.toContain("blob:");
      expect(saved).not.toHaveProperty("fontFamily");
      await t.dom.render(null);
      await t.dom.render(createElement(Host, { api: t.api }));
      expect(toSavedReaderSettings(t.current().settings, t.current().uiScale)).toEqual(saved);
    } finally {
      await t.dom.dispose();
    }
  });

  it("reset and imported preferences supersede pending themes through the existing transaction", async () => {
    const t = setup();
    const updates: Array<() => void> = [];
    Object.assign(t.dom.container.ownerDocument, {
      startViewTransition: (update: () => void) => {
        updates.push(update);
        return { ready: new Promise(() => {}), finished: new Promise(() => {}), skipTransition: vi.fn() };
      },
    });
    try {
      await t.dom.render(createElement(Host, { api: t.api }));
      await t.dom.run(() => { t.current().settingsActions.setFontSize(28); t.current().settingsActions.setUiScale(1.3); });
      await t.dom.run(() => t.current().transition.changeTheme("dark"));
      expect(updates).toHaveLength(1);
      await t.dom.run(() => t.current().transition.commitSettings(t.current().settingsActions.resetDefaults));
      await t.dom.run(() => updates[0]());
      expect(t.current().settings).toEqual(DEFAULT_SETTINGS);
      expect(t.current().uiScale).toBe(1);
      expect(readSavedSettings()).toEqual(toSavedReaderSettings(DEFAULT_SETTINGS, 1));

      await t.dom.run(() => t.current().transition.changeTheme("gray"));
      await t.dom.run(() => t.current().transition.commitSettings(() => {
        t.current().settingsActions.applyPortablePreferences({ theme: "sepia", fontSizePx: 24, lineHeight: 2.8, wordSpacingPx: 7 });
      }));
      await t.dom.run(() => updates[1]());
      expect(t.current().settings).toMatchObject({ theme: "sepia", fontSizePx: 24, lineHeight: 2.8, wordSpacingPx: 7 });
      await t.dom.run(() => t.current().settingsActions.applyPortablePreferences({ fontSizePx: 100, lineHeight: 4 }));
      expect(t.current().settings).toMatchObject({ fontSizePx: 24, lineHeight: 2.8 });
    } finally {
      await t.dom.dispose();
    }
  });
});
