import type { ProgressLease } from "./portableState/ownedProgressSessions";
import type { ScopedProgressWriter } from "./progressWriter";

/** Where the user was going when the progress save failed. */
export type SaveFailureExitKind = "shelf" | "window";

export interface SaveFailurePrompt {
  readonly kind: SaveFailureExitKind;
  readonly error: string;
}

export type UnsavedLaneRelease = "checkpoint" | "kept";

/**
 * Explicit "leave anyway" after a failed flush. The lane's latest sample is
 * handed to the local checkpoint store so the next open of the book can try
 * again; the original write is never reported as saved. When the handoff
 * itself cannot run (a request still in flight, or local storage refusing the
 * record), the lane stays registered so a later flush can still retry it.
 * Leaving never depends on this succeeding.
 */
export function releaseUnsavedLane<P>(
  writer: ScopedProgressWriter<P>,
  lease: ProgressLease,
  retain: (sample: P) => void,
): UnsavedLaneRelease {
  try {
    writer.handoffToCheckpoint(lease, retain);
    return "checkpoint";
  } catch {
    return "kept";
  }
}
