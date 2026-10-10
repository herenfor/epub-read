import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { MessageKey } from "./catalog";
import {
  createUiLanguageStore,
  translate,
  translatePlural,
  type PluralKey,
  UI_LANGUAGE_STORAGE_KEY,
  type MessageArguments,
  type UiLanguagePreference,
  type UiLanguageSnapshot,
  type UiLocale,
} from "./core";

export type UiLanguageStore = ReturnType<typeof createUiLanguageStore>;

function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
}

/** The app's one store: device-local storage, independent of reader settings and saves. */
export function createAppUiLanguageStore(): UiLanguageStore {
  return createUiLanguageStore({
    // A host that refuses storage still gets a usable Chinese UI; writes then fail visibly.
    read: () => {
      try { return localStorage.getItem(UI_LANGUAGE_STORAGE_KEY); } catch { return null; }
    },
    write: (preference) => localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, preference),
    systemLanguages,
  });
}

/** Chinese, in memory: used when nothing mounted a provider (tests, isolated renders). */
const fallbackStore = createUiLanguageStore({ read: () => null, write: () => {}, systemLanguages: () => [] });
let activeStore: UiLanguageStore | null = null;

const UiLanguageContext = createContext<UiLanguageStore | null>(null);

export function UiLanguageProvider({ store, children }: { store: UiLanguageStore; children: ReactNode }) {
  activeStore = store;
  const { locale } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    // EPUB iframes keep their own lang; only the app document follows the UI.
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const refresh = () => store.refreshSystemLanguages();
    window.addEventListener("languagechange", refresh);
    return () => window.removeEventListener("languagechange", refresh);
  }, [store]);
  return <UiLanguageContext.Provider value={store}>{children}</UiLanguageContext.Provider>;
}

export type Translate = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
export type TranslatePlural = <B extends PluralKey>(base: B, count: number, ...args: MessageArguments<`${B}.other` & MessageKey>) => string;

export interface UiText extends UiLanguageSnapshot {
  t: Translate;
  /** Count-dependent text: tn("search.results", n, { count: n }). */
  tn: TranslatePlural;
  /** Throws when the choice cannot be stored; callers show that failure. */
  setPreference(preference: UiLanguagePreference): void;
}

/** Subscribe a component to the UI language. Every component that renders app text calls this. */
export function useUiText(): UiText {
  const store = useContext(UiLanguageContext) ?? fallbackStore;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => ({
    ...snapshot,
    t: ((key, ...args) => translate(snapshot.locale, key, ...args)) as Translate,
    tn: ((base, count, ...args) => translatePlural(snapshot.locale, base, count, ...args)) as TranslatePlural,
    setPreference: store.setPreference,
  }), [snapshot, store]);
}

/** Current UI locale for code outside React render (notices, helpers, Intl formatting). */
export function currentUiLocale(): UiLocale {
  return (activeStore ?? fallbackStore).getSnapshot().locale;
}

/**
 * Translate outside a component. The text is fixed at call time, so use it for
 * one-shot messages (notices, errors) or inside a render that already called useUiText().
 */
export const uiText: Translate = (key, ...args) => translate(currentUiLocale(), key, ...args);
export const uiPlural: TranslatePlural = (base, count, ...args) => translatePlural(currentUiLocale(), base, count, ...args);
