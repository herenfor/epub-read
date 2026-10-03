/** Design core: the repository owns bases and commits the result atomically. */
import {
  mergeVersions, sameJsonValue, writeObserved,
  type Json, type Stamp, type Version,
} from "./portable-register-core";

export type EntityRef =
  | { readonly bookHash: string; readonly kind: "progress" }
  | { readonly bookHash: string; readonly kind: "bookmark" | "note"; readonly id: string };

/** Internal trusted snapshot. IPC carries only its opaque handle. */
export interface ReadBasis<T extends Json> {
  readonly entity: EntityRef;
  readonly localRevision: number;
  readonly selection: "chosen" | "shown-all";
  readonly observed: readonly Version<T>[];
}

function sameEntity(a: EntityRef, b: EntityRef): boolean {
  return a.bookHash === b.bookHash && a.kind === b.kind &&
    (a.kind === "progress" || (b.kind !== "progress" && a.id === b.id));
}

function sameEvents<T extends Json>(a: readonly Version<T>[], b: readonly Version<T>[]): boolean {
  const left = mergeVersions(a);
  const right = mergeVersions(b);
  return left.length === right.length && left.every((v, i) =>
    v.stamp.deviceId === right[i].stamp.deviceId && v.stamp.counter === right[i].stamp.counter);
}

/** Capture from a verified repository read, never from caller-supplied clocks. */
export function captureReadBasis<T extends Json>(input: {
  entity: EntityRef;
  current: readonly Version<T>[];
  localRevision: number;
  selection: { kind: "chosen"; stamp?: Stamp } | { kind: "shown-all" };
}): ReadBasis<T> {
  const frontier = mergeVersions(input.current);
  let observed = frontier;
  if (input.selection.kind === "chosen") {
    const selected = input.selection.stamp;
    observed = selected ? frontier.filter((v) =>
      v.stamp.deviceId === selected.deviceId && v.stamp.counter === selected.counter) : [];
    if (selected ? observed.length !== 1 : frontier.length !== 0) {
      throw new Error("invalid-choice");
    }
  }
  return { entity: input.entity, localRevision: input.localRevision,
    selection: input.selection.kind, observed };
}

export type PreparedWrite<T extends Json> =
  | { readonly kind: "unchanged" }
  | { readonly kind: "write"; readonly versions: readonly Version<T>[]; readonly nextBasis: ReadBasis<T> };

/**
 * Caller holds the entity's short transaction, checks tombstones first and
 * allocates nextStamp from the installation clock. Apply nextBasis only after
 * durable commit. Background merges do not change localRevision.
 */
export function prepareObservedWrite<T extends Json>(input: {
  entity: EntityRef;
  current: readonly Version<T>[];
  localRevision: number;
  basis: ReadBasis<T>;
  intent: "auto" | "edit" | "resolve" | "reset";
  nextStamp: Stamp;
  value: T;
  updatedAtMs: number;
}): PreparedWrite<T> {
  const { basis, entity, current, nextStamp, value, intent } = input;
  if (!sameEntity(entity, basis.entity)) throw new Error("wrong-entity");
  if (basis.localRevision !== input.localRevision) throw new Error("stale-basis");
  if (intent === "auto" && entity.kind !== "progress") throw new Error("invalid-intent");
  if (intent === "resolve" || intent === "reset") {
    if (basis.selection !== "shown-all" || !sameEvents(current, basis.observed)) {
      throw new Error("stale-choice");
    }
    if (intent === "reset" && (entity.kind !== "progress" || value !== null)) {
      throw new Error("invalid-intent");
    }
  } else if (basis.selection !== "chosen") {
    throw new Error("invalid-basis");
  }
  if (intent === "auto" && basis.observed.length === 1 &&
      sameJsonValue(basis.observed[0].value, value)) return { kind: "unchanged" };
  if (nextStamp.counter <= input.localRevision) throw new Error("clock-not-advanced");
  const versions = writeObserved(current, basis.observed, nextStamp, value, input.updatedAtMs);
  const written = versions.find((v) => v.stamp.deviceId === nextStamp.deviceId &&
    v.stamp.counter === nextStamp.counter);
  if (!written) throw new Error("clock-not-advanced");
  return { kind: "write", versions, nextBasis: {
    entity, localRevision: nextStamp.counter, selection: "chosen", observed: [written],
  } };
}

/** Scan validated RAW input before merge/tombstones can discard event clocks. */
export function maximumReceivedCounter(input: {
  versions: Iterable<Version<Json>>;
  registerStamps: Iterable<Stamp>;
  tombstones: Iterable<Stamp>;
}): number {
  let maximum = 0;
  const observe = (counter: number) => {
    if (!Number.isSafeInteger(counter) || counter < 1) throw new Error("invalid-counter");
    maximum = Math.max(maximum, counter);
  };
  for (const version of input.versions) {
    observe(version.stamp.counter);
    for (const counter of Object.values(version.clock)) observe(counter);
  }
  for (const stamp of input.registerStamps) observe(stamp.counter);
  for (const stamp of input.tombstones) observe(stamp.counter);
  return maximum;
}

/** One installation-wide allocator, also used by existing organization writes. */
export function nextLocalCounter(localCounter: number, receivedMaximum: number): number {
  if (![localCounter, receivedMaximum].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error("invalid-counter");
  }
  const previous = Math.max(localCounter, receivedMaximum);
  if (previous === Number.MAX_SAFE_INTEGER) throw new Error("clock-exhausted");
  return previous + 1;
}
