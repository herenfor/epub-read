/**
 * Design-only core for progress and annotation values; not wired into product.
 * Decode/validate JSON DTOs before entry. Clocks are scoped to ONE entity.
 * Folder/favorite registers keep the existing libraryOrganization algorithm.
 */
export type Json = null | boolean | number | string | readonly Json[] |
  { readonly [key: string]: Json };

export interface Stamp {
  readonly deviceId: string;
  readonly counter: number;
}

export type Clock = Readonly<Record<string, number>>;

export interface Version<T extends Json> {
  readonly stamp: Stamp;
  /** Includes this event; omitted devices mean zero, not a deleted device. */
  readonly clock: Clock;
  readonly value: T;
  /** Display only; never consulted by merge. */
  readonly updatedAtMs: number;
}

const compareAscii = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function compareStamp(a: Stamp, b: Stamp): number {
  return a.counter - b.counter || compareAscii(a.deviceId, b.deviceId);
}

/** DTOs are JSON values with finite numbers and no undefined properties. */
function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => compareAscii(a, b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

/** Compare validated JSON values without depending on object key order. */
export function sameJsonValue(a: Json, b: Json): boolean {
  return canonical(a) === canonical(b);
}

function assertVersion<T extends Json>(version: Version<T>): void {
  const { stamp, clock } = version;
  if (!stamp.deviceId || !Number.isSafeInteger(stamp.counter) || stamp.counter < 1 ||
      clock[stamp.deviceId] !== stamp.counter) throw new Error("invalid-event-clock");
  for (const [device, counter] of Object.entries(clock)) {
    // A Lamport event must follow every observed event, regardless of device.
    if (!Number.isSafeInteger(counter) || counter < 1 ||
        (device !== stamp.deviceId && counter >= stamp.counter)) {
      throw new Error("invalid-event-clock");
    }
  }
}

/** True only if a has observed all of b and at least one later event. */
export function dominates(a: Clock, b: Clock): boolean {
  for (const [device, counter] of Object.entries(b)) {
    if ((a[device] ?? 0) < counter) return false;
  }
  return Object.entries(a).some(([device, counter]) => counter > (b[device] ?? 0));
}

export function joinClocks(clocks: readonly Clock[]): Clock {
  const merged = new Map<string, number>();
  for (const clock of clocks) for (const [device, counter] of Object.entries(clock)) {
    merged.set(device, Math.max(merged.get(device) ?? 0, counter));
  }
  return Object.fromEntries([...merged].sort(([a], [b]) => compareAscii(a, b)));
}

/**
 * Union minus causally superseded versions. Idempotent, commutative, associative
 * for valid event histories. Same stamp with different content is corruption.
 * Cost depends on outstanding device branches, not number of reading samples.
 */
export function mergeVersions<T extends Json>(
  ...states: readonly (readonly Version<T>[])[]
): readonly Version<T>[] {
  const unique = new Map<string, Version<T>>();
  for (const state of states) for (const version of state) {
    assertVersion(version);
    const key = `${version.stamp.deviceId}:${version.stamp.counter}`;
    const previous = unique.get(key);
    if (previous && (canonical(previous.clock) !== canonical(version.clock) ||
        canonical(previous.value) !== canonical(version.value) ||
        previous.updatedAtMs !== version.updatedAtMs)) throw new Error("event-collision");
    unique.set(key, version);
  }
  const all = [...unique.values()];
  return all.filter((candidate) => !all.some((other) =>
    other !== candidate && dominates(other.clock, candidate.clock)))
    .sort((a, b) => compareStamp(a.stamp, b.stamp));
}

/**
 * `observed` is the version frontier adopted by THIS reader/editor session.
 * It is not automatically replaced by versions received in the background.
 * Include our own previous writes to serialize the local writer, while keeping
 * unseen remote branches. Resolve explicitly by passing all current versions.
 * The repository allocates stamp and persists clock+value in one transaction.
 */
export function writeObserved<T extends Json>(
  current: readonly Version<T>[],
  observed: readonly Version<T>[],
  stamp: Stamp,
  value: T,
  updatedAtMs: number,
): readonly Version<T>[] {
  const seen = mergeVersions(observed,
    current.filter((version) => version.stamp.deviceId === stamp.deviceId));
  const context = joinClocks(seen.map((version) => version.clock));
  if (!Number.isSafeInteger(stamp.counter) || stamp.counter < 1 ||
      Object.values(context).some((counter) => stamp.counter <= counter)) {
    throw new Error("clock-not-advanced");
  }
  const next: Version<T> = {
    stamp,
    clock: { ...context, [stamp.deviceId]: stamp.counter },
    value,
    updatedAtMs,
  };
  return mergeVersions(current, [next]);
}

/** Annotations use permanent tombstones; restoring creates a NEW annotation ID. */
export interface Annotation<T extends Json> {
  readonly versions: readonly Version<T>[];
  readonly deleted?: Stamp;
}

export function mergeAnnotation<T extends Json>(
  a: Annotation<T>, b: Annotation<T>,
): Annotation<T> {
  const deleted = !a.deleted ? b.deleted : !b.deleted ? a.deleted :
    compareStamp(a.deleted, b.deleted) >= 0 ? a.deleted : b.deleted;
  // Retain the deletion identity, not the user's deleted note text.
  return deleted ? { versions: [], deleted } :
    { versions: mergeVersions(a.versions, b.versions) };
}
