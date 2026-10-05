/** Progress opening order and confirmation across suspend/resume boundaries. */
import { ProgressRuntimeUnavailable, type ProgressRuntimeStatus } from "./portableState/progressRuntimeGate";
import { sameJsonValue, type Stamp, type Version } from "../core/portableState/portable-register-core";
import type { ProgressValue } from "../core/portableState/portable-state-types";
import { ProgressWriteUnconfirmed } from "./checkpointProgressRepair";

/** Match a native write without assuming JSON object key order. */
export function confirmedWrittenStamp(
  versions: readonly Version<ProgressValue>[],
  value: ProgressValue,
  updatedAtMs: number,
): Stamp {
  const matches = versions.filter((version) =>
    version.updatedAtMs === updatedAtMs && sameJsonValue(version.value, value));
  if (matches.length !== 1) throw new ProgressWriteUnconfirmed("progress-write-interrupted");
  return matches[0].stamp;
}

/** The first read-only query must use the bounded gate too. Activation is a separate mutation. */
export async function checkThenRecoverProgressRuntime(
  gate: { check(): Promise<ProgressRuntimeStatus> },
  recover: () => Promise<unknown>,
): Promise<ProgressRuntimeStatus> {
  try {
    return await gate.check();
  } catch (error) {
    if (!(error instanceof ProgressRuntimeUnavailable) || error.code !== "runtime-not-ready") {
      throw error;
    }
  }
  // A timeout/interruption is not evidence that the repository needs activation.
  // Do not race this mutation against a timer or silently retry it in a loop.
  await recover();
  return gate.check();
}

/** Flush first, then choose from a fresh repository read; keep old ownership until publication. */
export async function planFreshProgressOpen<
  E,
  D extends { readonly explicitPositionChoice: boolean },
  R extends { readonly status: "saved" } | { readonly status: "failed"; readonly error: unknown },
>(
  port: {
    readonly flushTarget: () => Promise<R | null>;
    readonly readCurrent: () => Promise<E>;
    readonly choose: (entry: E) => Promise<D | null>;
  },
): Promise<{ readonly entry: E; readonly decision: D; readonly targetSave: R | null } | null> {
  const targetSave = await port.flushTarget();
  const entry = await port.readCurrent();
  const decision = await port.choose(entry);
  if (!decision) return null;
  if (targetSave?.status === "failed" && !decision.explicitPositionChoice) {
    throw targetSave.error;
  }
  // prepare/adopt still checks the selected stamp against the repository.
  // No close, retire, handoff or checkpoint acknowledgement here.
  return { entry, decision, targetSave };
}
