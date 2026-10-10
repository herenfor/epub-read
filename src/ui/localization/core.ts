import { en, zhCN, type MessageKey } from "./catalog";

export type UiLocale = "zh-CN" | "en";
export type UiLanguagePreference = UiLocale | "system";
export const UI_LANGUAGE_STORAGE_KEY = "epub-reader:ui-language";

/** Existing installations stay Chinese until the user explicitly chooses a language. */
export function readUiLanguagePreference(value: unknown): UiLanguagePreference {
  return value === "en" || value === "system" ? value : "zh-CN";
}

export function resolveUiLocale(preference: UiLanguagePreference, systemLanguages: readonly string[]): UiLocale {
  if (preference !== "system") return preference;
  const primary = systemLanguages.find((value) => value.trim().length > 0);
  return primary?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

// Mirrors the runtime /\{(\w+)\}/ pattern: braces around non-identifiers (CSS examples) are literal text.
type Identifier<S extends string> = S extends "" | `${string}${" " | ":" | ";" | "!" | "-" | "." | "{"}${string}` ? never : S;
type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Tail}`
  ? Identifier<Name> | Placeholders<Tail>
  : never;
/** Keys without placeholders: safe to store in tables and pass to t() as a variable. */
export type PlainMessageKey = { [K in MessageKey]: [Placeholders<(typeof zhCN)[K]>] extends [never] ? K : never }[MessageKey];

export type MessageArguments<K extends MessageKey> = [Placeholders<(typeof zhCN)[K]>] extends [never]
  ? []
  : [values: Record<Placeholders<(typeof zhCN)[K]>, string | number>];

/** Produces text, never HTML. React must render the result as a normal text child. */
export function translate<K extends MessageKey>(locale: UiLocale, key: K, ...args: MessageArguments<K>): string {
  const template = (locale === "en" ? en[key] : zhCN[key]) || zhCN[key];
  const values = args[0] as Record<string, string | number> | undefined;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values?.[name];
    if (value === undefined) throw new Error(`Missing UI message argument: ${name}`);
    return String(value);
  });
}

/** Base keys that have a "<base>.other" plural form (and optionally "<base>.one"). */
export type PluralKey = { [K in MessageKey]: K extends `${infer Base}.other` ? Base : never }[MessageKey];
type PluralArguments<B extends PluralKey> = MessageArguments<`${B}.other` & MessageKey>;

const pluralRules = new Map<UiLocale, Intl.PluralRules>();

/**
 * Count-dependent text. Picks "<base>.<category>" by Intl.PluralRules for the
 * UI locale (English: one/other), falling back to "<base>.other". Chinese
 * catalogs keep the same text in every form.
 */
export function translatePlural<B extends PluralKey>(locale: UiLocale, base: B, count: number, ...args: PluralArguments<B>): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  const specific = `${base}.${rules.select(count)}`;
  const key = (specific in zhCN ? specific : `${base}.other`) as MessageKey;
  return (translate as (locale: UiLocale, key: MessageKey, ...rest: unknown[]) => string)(locale, key, ...args);
}

export interface UiLanguageSnapshot {
  readonly preference: UiLanguagePreference;
  readonly locale: UiLocale;
}

export interface UiLanguagePorts {
  read(): unknown;
  write(preference: UiLanguagePreference): void;
  systemLanguages(): readonly string[];
}

/** Inactive until bootstrap supplies storage and a UI provider. No reading-settings dependency. */
export function createUiLanguageStore(ports: UiLanguagePorts) {
  let preference = readUiLanguagePreference(ports.read());
  let snapshot: UiLanguageSnapshot = { preference, locale: resolveUiLocale(preference, ports.systemLanguages()) };
  const listeners = new Set<() => void>();
  function publish(): void {
    const locale = resolveUiLocale(preference, ports.systemLanguages());
    if (snapshot.preference === preference && snapshot.locale === locale) return;
    snapshot = { preference, locale };
    for (const listener of [...listeners]) listener();
  }
  return {
    getSnapshot: (): UiLanguageSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setPreference(next: UiLanguagePreference): void {
      if (next === preference) return;
      ports.write(next); // Failed persistence must not be reported as a saved choice.
      preference = next;
      publish();
    },
    refreshSystemLanguages: publish,
  };
}
