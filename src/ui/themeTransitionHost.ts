import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import type { ReaderSettings, Theme } from "../render/settings";
import type { ReaderHandle } from "./ReaderView";
import { createThemeTransitionController, type ThemeTransitionController, type ThemeTransitionHost } from "./themeTransition";
import { isDarkReaderTheme } from "../config/readerPalette";
import { customThemeTokens, isCustomThemeKey, parseCustomThemeKey } from "../config/customThemes";

/**
 * data-theme names the token block in styles.css ("custom" for a user theme,
 * none for light); data-tone="dark" marks every dark theme for the few rules
 * that only depend on darkness.
 */
export function documentThemeAttributes(theme: Theme): { theme?: string; tone?: "dark" } {
  const tone = isDarkReaderTheme(theme) ? "dark" as const : undefined;
  if (isCustomThemeKey(theme)) return { theme: "custom", tone };
  return { theme: theme !== "light" ? theme : undefined, tone };
}

const CUSTOM_THEME_STYLE_ID = "custom-theme-tokens";

/** The token block of a user theme, generated like the built-in ones in styles.css. */
export function customThemeCss(theme: Theme): string {
  const colors = isCustomThemeKey(theme) ? parseCustomThemeKey(theme) : null;
  if (!colors) return "";
  const tokens = customThemeTokens(colors);
  const block = (vars: Record<string, string>) => Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`).join("\n");
  return `[data-theme="custom"] {\n${block(tokens.root)}\n}\n.app[data-theme="custom"] {\n${block(tokens.app)}\n}`;
}

/** html/body carry the theme so the whole window background follows it (light has no attribute). */
export function applyDocumentTheme(doc: Document, theme: Theme): void {
  const attributes = documentThemeAttributes(theme);
  // The user theme's variables are in place before its attribute selects them.
  const css = customThemeCss(theme);
  let style = doc.getElementById(CUSTOM_THEME_STYLE_ID);
  if (css && !style && doc.head) {
    style = doc.createElement("style");
    style.id = CUSTOM_THEME_STYLE_ID;
    doc.head.appendChild(style);
  }
  if (style && style.textContent !== css) style.textContent = css;
  for (const element of [doc.documentElement, doc.body]) {
    if (!element) continue;
    if (attributes.theme) element.setAttribute("data-theme", attributes.theme);
    else element.removeAttribute("data-theme");
    if (attributes.tone) element.setAttribute("data-tone", attributes.tone);
    else element.removeAttribute("data-tone");
  }
}

export interface ThemeTransitionWiring {
  setSettings: Dispatch<SetStateAction<ReaderSettings>>;
  /** Theme of the latest committed settings. */
  committedTheme(): Theme;
  /** Live reader, if any; its body hosts are recolored in place. */
  reader(): ReaderHandle | null;
  /** Book or chapter still loading: commit directly, the load picks up the latest theme. */
  busy(): boolean;
  /** Observable error entry for a failed commit; a failure is never reported as a finished theme change. */
  onError(error: unknown): void;
  /** Test seams for the controller environment (document, motion, background). */
  host?: Pick<ThemeTransitionHost, "document" | "isMotionReduced" | "isBackgrounded">;
}

/**
 * App side of the whole-screen theme transition. One controller per mount
 * (StrictMode setup/cleanup creates and disposes its own); settings.theme stays
 * the only persisted truth.
 *
 * - changeTheme: the shelf settings and reader Aa entry. Only the theme leaf is
 *   written onto the latest settings. Inside the transition's update callback
 *   the commit is synchronous: React (app root, panels) is flushed, html/body
 *   are set, and every live body host is recolored through ReaderHandle.applyTheme.
 *   No change, busy reading, reduced motion, background or no API → direct commit.
 * - commitSettings: writes that also move geometry (restore defaults, imported
 *   preferences) commit directly through the same controller, so a pending
 *   theme request is superseded instead of landing after them; their layout
 *   transaction is the existing one.
 * - interrupt: reading input commits the pending target at once and drops the decoration.
 */
export function useThemeTransition(wiring: ThemeTransitionWiring) {
  const wiringRef = useRef(wiring);
  wiringRef.current = wiring;
  const controllerRef = useRef<ThemeTransitionController | null>(null);

  useEffect(() => {
    const controller = createThemeTransitionController({
      ...wiringRef.current.host,
      onCommitError: (error) => wiringRef.current.onError(error),
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  // Commit errors of direct and interrupted commits surface here; those inside
  // the update callback reach onError through the controller's onCommitError.
  const guarded = useCallback((run: (controller: ThemeTransitionController) => void) => {
    const controller = controllerRef.current;
    if (!controller) return; // unmounted: nothing commits
    try {
      run(controller);
    } catch (error) {
      wiringRef.current.onError(error);
    }
  }, []);

  /** animate: false for live edits (a theme being designed), which must follow each change at once. */
  const changeTheme = useCallback((theme: Theme, options?: { animate?: boolean }) => {
    guarded((controller) => {
      const current = wiringRef.current;
      controller.request({
        animate: options?.animate !== false && current.committedTheme() !== theme && !current.busy(),
        commit: () => {
          const latest = wiringRef.current;
          flushSync(() => latest.setSettings((s) => (s.theme === theme ? s : { ...s, theme })));
          const doc = latest.host?.document ?? document;
          applyDocumentTheme(doc, theme);
          latest.reader()?.applyTheme(theme);
        },
      });
    });
  }, [guarded]);

  const commitSettings = useCallback((commit: () => void) => {
    guarded((controller) => controller.request({ animate: false, commit }));
  }, [guarded]);

  const interrupt = useCallback(() => {
    guarded((controller) => {
      if (controller.isTransitioning) controller.interrupt();
    });
  }, [guarded]);

  return { changeTheme, commitSettings, interrupt };
}
