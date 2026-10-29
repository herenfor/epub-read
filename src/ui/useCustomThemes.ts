import { useCallback, useMemo, useState } from "react";
import {
  CUSTOM_THEME_PRESETS,
  MAX_CUSTOM_THEMES,
  MAX_CUSTOM_THEME_NAME,
  clampThemeName,
  customThemeKey,
  isCustomThemeKey,
  newCustomThemeId,
  parseCustomThemeKey,
  sanitizeCustomThemes,
  type CustomTheme,
  type CustomThemeColors,
} from "../config/customThemes";
import { isDarkReaderTheme } from "../config/readerPalette";
import type { Theme } from "../render/settings";

const STORAGE_KEY = "epub-reader-custom-themes-v1";

export interface StoredCustomThemes {
  themes: CustomTheme[];
  /** The theme last chosen, so two themes with the same colors keep the right one highlighted. */
  selectedId: string | null;
}

/** Local to this device. Storage is validated and capped on every read. */
export function readCustomThemes(): StoredCustomThemes {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<StoredCustomThemes> | null;
    const themes = sanitizeCustomThemes(parsed?.themes);
    const selectedId = typeof parsed?.selectedId === "string" && themes.some((theme) => theme.id === parsed.selectedId)
      ? parsed.selectedId
      : null;
    return { themes, selectedId };
  } catch {
    return { themes: [], selectedId: null };
  }
}

function writeCustomThemes(state: StoredCustomThemes): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota or blocked storage: the themes still work for this session.
  }
}

/** Colors of the theme on screen, as a starting point for a new one. */
export function themeColorsOf(theme: Theme): CustomThemeColors {
  if (isCustomThemeKey(theme)) {
    const colors = parseCustomThemeKey(theme);
    if (colors) return colors;
  }
  const preset = CUSTOM_THEME_PRESETS.find((item) => item.id === theme) ?? CUSTOM_THEME_PRESETS[0];
  return { background: preset.background, foreground: preset.foreground, accent: preset.accent };
}

/** What the theme cards and the editor work with. */
export interface CustomThemeControls {
  themes: readonly CustomTheme[];
  /** The custom theme on screen, or null while a built-in theme is. */
  activeId: string | null;
  canCreate: boolean;
  select(id: string): void;
  /** Copies the theme on screen and selects it; null when the limit is reached. */
  create(): string | null;
  setColors(id: string, colors: CustomThemeColors): void;
  rename(id: string, name: string): void;
  remove(id: string): void;
}

/**
 * Custom themes and the theme setting kept in step: selecting or editing the
 * theme on screen goes through changeTheme (edits without the transition).
 */
export function useCustomThemes(
  theme: Theme,
  changeTheme: (theme: Theme, options?: { animate?: boolean }) => void,
  defaultName: (n: number) => string,
): CustomThemeControls {
  const [state, setState] = useState<StoredCustomThemes>(readCustomThemes);
  const commit = useCallback((next: StoredCustomThemes) => {
    setState(next);
    writeCustomThemes(next);
  }, []);

  const activeId = useMemo(() => {
    if (!isCustomThemeKey(theme)) return null;
    const selected = state.themes.find((item) => item.id === state.selectedId);
    if (selected && customThemeKey(selected) === theme) return selected.id;
    return state.themes.find((item) => customThemeKey(item) === theme)?.id ?? null;
  }, [state, theme]);

  const select = useCallback((id: string) => {
    const target = state.themes.find((item) => item.id === id);
    if (!target) return;
    if (state.selectedId !== id) commit({ ...state, selectedId: id });
    changeTheme(customThemeKey(target));
  }, [state, commit, changeTheme]);

  const create = useCallback((): string | null => {
    if (state.themes.length >= MAX_CUSTOM_THEMES) return null;
    const id = newCustomThemeId(state.themes.map((item) => item.id));
    let n = state.themes.length + 1;
    const names = new Set(state.themes.map((item) => item.name));
    while (names.has(defaultName(n))) n++;
    const created: CustomTheme = { id, name: clampThemeName(defaultName(n)), ...themeColorsOf(theme) };
    commit({ themes: [...state.themes, created], selectedId: id });
    // Same colors as the screen: selecting it changes nothing visible.
    changeTheme(customThemeKey(created), { animate: false });
    return id;
  }, [state, commit, changeTheme, theme, defaultName]);

  const setColors = useCallback((id: string, colors: CustomThemeColors) => {
    const index = state.themes.findIndex((item) => item.id === id);
    if (index < 0) return;
    const updated = { ...state.themes[index], ...colors };
    const themes = state.themes.slice();
    themes[index] = updated;
    commit({ ...state, themes });
    if (id === activeId) changeTheme(customThemeKey(updated), { animate: false });
  }, [state, commit, activeId, changeTheme]);

  const rename = useCallback((id: string, name: string) => {
    // Not trimmed while typing (a space may come before the next word); storage trims on read.
    const limited = Array.from(name).slice(0, MAX_CUSTOM_THEME_NAME).join("");
    commit({ ...state, themes: state.themes.map((item) => item.id === id ? { ...item, name: limited } : item) });
  }, [state, commit]);

  const remove = useCallback((id: string) => {
    const target = state.themes.find((item) => item.id === id);
    if (!target) return;
    commit({ themes: state.themes.filter((item) => item.id !== id), selectedId: state.selectedId === id ? null : state.selectedId });
    // Deleting the theme on screen falls back to the built-in of the same darkness.
    if (id === activeId) changeTheme(isDarkReaderTheme(customThemeKey(target)) ? "dark" : "light");
  }, [state, commit, activeId, changeTheme]);

  return useMemo(() => ({
    themes: state.themes,
    activeId,
    canCreate: state.themes.length < MAX_CUSTOM_THEMES,
    select,
    create,
    setColors,
    rename,
    remove,
  }), [state.themes, activeId, select, create, setColors, rename, remove]);
}
