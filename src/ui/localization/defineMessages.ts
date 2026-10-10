/**
 * One feature's Chinese source text. Keys must start with "<namespace>." so two
 * catalogs can never claim the same key. A plain string is enough; use the
 * object form when a translator needs context or a length budget.
 */
export interface MessageEntry {
  readonly zh: string;
  /** Where/how the text appears, for translators. Not shown in the app. */
  readonly note?: string;
  /** Soft length budget for tight UI (button, phone tab bar), in characters. */
  readonly max?: number;
}

export type MessageSource = string | MessageEntry;

export type ZhOf<T> = {
  readonly [K in keyof T]: T[K] extends string ? T[K]
    : T[K] extends { readonly zh: infer S extends string } ? S : never;
};

export interface MessageNamespace<N extends string, T> {
  readonly namespace: N;
  readonly zh: ZhOf<T>;
  readonly meta: Readonly<Record<string, MessageEntry>>;
}

export function defineMessages<const N extends string, const T extends Record<`${N}.${string}`, MessageSource>>(
  namespace: N,
  // Any key outside "<namespace>." is typed never, so a misplaced key fails to compile.
  entries: T & Record<Exclude<keyof T, `${N}.${string}`>, never>,
): MessageNamespace<N, T> {
  const zh: Record<string, string> = {};
  const meta: Record<string, MessageEntry> = {};
  for (const [key, source] of Object.entries(entries) as Array<[string, MessageSource]>) {
    const entry = typeof source === "string" ? { zh: source } : source;
    zh[key] = entry.zh;
    meta[key] = entry;
  }
  return { namespace, zh: zh as ZhOf<T>, meta };
}
