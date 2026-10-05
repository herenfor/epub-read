import type { LocalProgressCheckpoint, LocalProgressCheckpoints } from "./localProgressCheckpoint";

type Stamp = NonNullable<LocalProgressCheckpoint<unknown>["shownStamp"]>;
type Stamped = { readonly stamp: Stamp };

export type CheckpointOpenPlan<P, V> =
  | { readonly kind: "use-saved"; readonly version: V; readonly checkpointId: string }
  | { readonly kind: "restore-local"; readonly basis: V | null; readonly checkpoint: LocalProgressCheckpoint<P> }
  | { readonly kind: "choose"; readonly checkpoint: LocalProgressCheckpoint<P> };

/** A valid old basis authorizes restoration; it never proves the local sample was saved. */
export function planCheckpointOpen<P, V extends Stamped>(
  checkpoint: LocalProgressCheckpoint<P>,
  currentVersions: readonly V[],
  sameLocation: (patch: P, version: V) => boolean,
): CheckpointOpenPlan<P, V> {
  // Do not bypass the existing multiple-version choice, even if one branch matches.
  if (currentVersions.length > 1) return { kind: "choose", checkpoint };
  const current = currentVersions[0];
  if (current && sameLocation(checkpoint.patch, current)) {
    return { kind: "use-saved", version: current, checkpointId: checkpoint.checkpointId };
  }
  const shown = checkpoint.shownStamp;
  if (current && shown && current.stamp.deviceId === shown.deviceId && current.stamp.counter === shown.counter) {
    return { kind: "restore-local", basis: current, checkpoint };
  }
  if (!current && shown === null) return { kind: "restore-local", basis: null, checkpoint };
  return { kind: "choose", checkpoint };
}

export interface CheckpointedSample<P> {
  readonly patch: P;
  readonly checkpointId: string;
}

function sameMediaAnchor(
  left: unknown,
  right: unknown,
): boolean {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const a = left as { index?: unknown; tag?: unknown; signature?: unknown; ratio?: unknown };
  const b = right as { index?: unknown; tag?: unknown; signature?: unknown; ratio?: unknown };
  return a.index === b.index && a.tag === b.tag && a.signature === b.signature && a.ratio === b.ratio;
}

function sameStableProgressPatch<P>(left: P, right: P): boolean {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const stableFields = [
    "chapterPath",
    "spineIndex",
    "page",
    "anchorIndex",
    "anchorRatio",
    "anchorTextOffset",
    "anchorTextSnippet",
  ] as const;
  for (const field of stableFields) {
    if (leftRecord[field] !== rightRecord[field]) return false;
  }
  return sameMediaAnchor(leftRecord.mediaAnchor, rightRecord.mediaAnchor);
}

/** Call at the stable-sample enqueue boundary, before a timer or native IPC can run. */
export function stageCheckpointSample<P>(
  checkpoints: LocalProgressCheckpoints<P>,
  bookHash: string,
  shownStamp: LocalProgressCheckpoint<P>["shownStamp"],
  patch: P,
): CheckpointedSample<P> {
  const existing = checkpoints.peek(bookHash);
  if (existing && sameStableProgressPatch(existing.patch, patch)) {
    // Same stable position: keep the existing recovery record/ID. The writer
    // will still persist the freshest patch but must not create a second record.
    return { patch, checkpointId: existing.checkpointId };
  }
  const checkpoint = checkpoints.put(bookHash, shownStamp, patch);
  return { patch: checkpoint.patch, checkpointId: checkpoint.checkpointId };
}

export type ConfirmedProgressWrite<E> =
  | { readonly status: "saved"; readonly entry: E; readonly shownStamp: Stamp | null }
  | { readonly status: "unconfirmed"; readonly code: "progress-needs-choice" | "progress-write-interrupted" };

export class ProgressWriteUnconfirmed extends Error {
  constructor(readonly code: "progress-needs-choice" | "progress-write-interrupted") {
    super("阅读位置尚未确认保存，本机恢复位置已保留");
    this.name = "ProgressWriteUnconfirmed";
  }
}

/** Only a real saved/unchanged-same-value write may acknowledge this sample. */
export async function persistCheckpointSample<P, E>(
  checkpoints: LocalProgressCheckpoints<P>,
  bookHash: string,
  sample: CheckpointedSample<P>,
  write: (patch: P) => Promise<ConfirmedProgressWrite<E>>,
): Promise<Extract<ConfirmedProgressWrite<E>, { status: "saved" }>> {
  const result = await write(sample.patch);
  if (result.status !== "saved") throw new ProgressWriteUnconfirmed(result.code);
  // A remove failure keeps recovery evidence; it does not negate a confirmed backend write.
  try {
    checkpoints.acknowledge(bookHash, sample.checkpointId);
  } catch {
    /* retain */
  }
  return result;
}
