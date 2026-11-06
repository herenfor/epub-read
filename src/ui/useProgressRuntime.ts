import { useCallback, useRef, type MutableRefObject } from "react";
import { getAppBuildSession } from "../config/appBuildSession";
import { stageCheckpointSample, type CheckpointedSample } from "./checkpointProgressRepair";
import { LocalProgressCheckpoints, type LocalProgressCheckpoint } from "./localProgressCheckpoint";
import { checkThenRecoverProgressRuntime } from "./progressOpenOrder";
import { ScopedProgressWriter } from "./progressWriter";
import { ProgressRuntimeGate, type ProgressRuntimeStatus } from "./portableState/progressRuntimeGate";
import type { ProgressLease } from "./portableState/ownedProgressSessions";
import { ensurePortableRepositoryReady, getShelfStore, portableShelfStateActive, type ShelfEntry, type ShelfProgressPatch } from "./shelf";
import { shelfSpaceStorage } from "./shelfSpaces";

const DIAGNOSTIC_ERROR_CODES = new Set([
  "invalid-data",
  "invalid-entity",
  "invalid-choice",
  "invalid-intent",
  "stale-basis",
  "stale-choice",
  "deleted-entity",
  "clock-exhausted",
  "storage-error",
  "progress-needs-choice",
  "progress-write-interrupted",
  "runtime-not-ready",
  "runtime-check-timeout",
  "runtime-check-interrupted",
  "shelf-record-missing",
]);

function diagnosticErrorCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && DIAGNOSTIC_ERROR_CODES.has(value) ? value : "unknown";
}

function parseLocalProgressCheckpoint(value: unknown): LocalProgressCheckpoint<ShelfProgressPatch> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("本机进度恢复记录格式无效");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.checkpointId !== "string" ||
    candidate.checkpointId.length === 0 ||
    typeof candidate.bookHash !== "string" ||
    candidate.bookHash.length === 0 ||
    !Object.prototype.hasOwnProperty.call(candidate, "shownStamp") ||
    !Object.prototype.hasOwnProperty.call(candidate, "patch")
  ) {
    throw new Error("本机进度恢复记录字段不完整");
  }
  const shown = candidate.shownStamp;
  let shownStamp: LocalProgressCheckpoint<ShelfProgressPatch>["shownStamp"] = null;
  if (shown !== null) {
    if (
      typeof shown !== "object" ||
      typeof (shown as { deviceId?: unknown }).deviceId !== "string" ||
      typeof (shown as { counter?: unknown }).counter !== "number" ||
      !Number.isSafeInteger((shown as { counter: number }).counter)
    ) {
      throw new Error("本机进度恢复记录的选择戳无效");
    }
    shownStamp = {
      deviceId: (shown as { deviceId: string }).deviceId,
      counter: (shown as { counter: number }).counter,
    };
  }
  const rawPatch = candidate.patch;
  if (typeof rawPatch !== "object" || rawPatch === null || Array.isArray(rawPatch)) {
    throw new Error("本机进度恢复记录的阅读位置无效");
  }
  const patch = rawPatch as Partial<ShelfProgressPatch>;
  if (
    typeof patch.lastReadAtMs !== "number" ||
    !Number.isSafeInteger(patch.lastReadAtMs) ||
    patch.lastReadAtMs < 0 ||
    typeof patch.spineIndex !== "number" ||
    !Number.isSafeInteger(patch.spineIndex) ||
    typeof patch.page !== "number" ||
    !Number.isSafeInteger(patch.page) ||
    typeof patch.progressPct !== "number" ||
    !Number.isFinite(patch.progressPct) ||
    (patch.anchorIndex !== null && typeof patch.anchorIndex !== "number") ||
    (patch.anchorRatio !== null && typeof patch.anchorRatio !== "number") ||
    (patch.anchorTextOffset !== null && typeof patch.anchorTextOffset !== "number") ||
    (patch.anchorTextSnippet !== null && typeof patch.anchorTextSnippet !== "string")
  ) {
    throw new Error("本机进度恢复记录的位置字段无效");
  }
  return {
    schemaVersion: 1,
    checkpointId: candidate.checkpointId,
    bookHash: candidate.bookHash,
    shownStamp,
    patch: patch as ShelfProgressPatch,
  };
}

export function useProgressRuntime({
  contentHashByIdRef,
  shelfEntriesRef,
  sessionGenerationRef,
}: {
  contentHashByIdRef: MutableRefObject<Map<string, string>>;
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  sessionGenerationRef: MutableRefObject<number>;
}) {
  const progressWriterRef = useRef<ScopedProgressWriter<CheckpointedSample<ShelfProgressPatch>> | null>(null);
  if (!progressWriterRef.current) {
    // Exact-session lanes are registered per open; no book ID alone may flush
    // or retire another book's unsaved sample. Each lane owns a staged local
    // checkpoint ID captured before native IPC can start.
    progressWriterRef.current = new ScopedProgressWriter<CheckpointedSample<ShelfProgressPatch>>();
  }
  const activeProgressLeaseRef = useRef<ProgressLease | null>(null);
  const progressRuntimeGateRef = useRef<ProgressRuntimeGate | null>(null);
  if (!progressRuntimeGateRef.current) {
    progressRuntimeGateRef.current = new ProgressRuntimeGate(async () => {
      const store = getShelfStore();
      // Health checks stay read-only. Explicit first activation/recovery is
      // performed outside the 5s race by ensureProgressRuntimeReady.
      if (store.runtimeStatus) return store.runtimeStatus();
      return { repositoryGeneration: "legacy", repositoryReady: true };
    });
  }
  const ensureProgressRuntimeReady = useCallback(async () => {
    const status = await checkThenRecoverProgressRuntime(
      progressRuntimeGateRef.current!, ensurePortableRepositoryReady,
    );
    lastNativeRecordsReadRef.current = status.lastRecordsRead ?? null;
    if (status.repositoryGeneration) lastRepositoryGenerationRef.current = status.repositoryGeneration;
    return status;
  }, []);
  const localCheckpointsRef = useRef<LocalProgressCheckpoints<ShelfProgressPatch> | null>(null);
  if (!localCheckpointsRef.current) {
    // A shelf that must not persist (the private shelf) keeps these in memory.
    localCheckpointsRef.current = new LocalProgressCheckpoints(
      shelfSpaceStorage,
      parseLocalProgressCheckpoint,
      () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : `progress-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
  }
  // Re-stage a lane's latest sample as the book's local recovery record before
  // the lane is dropped; throws (keeping the lane) when that is impossible.
  const retainUnsavedSample = useCallback((lease: ProgressLease) => (sample: CheckpointedSample<ShelfProgressPatch>): void => {
    const checkpoints = localCheckpointsRef.current;
    const store = getShelfStore();
    const bookHash = store.progressSessionBookHash?.(lease) ?? contentHashByIdRef.current.get(lease.bookId);
    if (!checkpoints || !bookHash) throw new Error("本机进度检查点不可用");
    stageCheckpointSample(checkpoints, bookHash, store.progressSessionChosenStamp?.(lease) ?? null, sample.patch);
  }, []);
  const lifecycleDiagnosticsRef = useRef<string[]>([]);
  const firstSampleFailureRecordedRef = useRef(false);
  const jsBootIdRef = useRef<string | null>(null);
  if (!jsBootIdRef.current) {
    jsBootIdRef.current = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : `js-boot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  const lastRepositoryGenerationRef = useRef<string>("unknown");
  const lastNativeRecordsReadRef = useRef<ProgressRuntimeStatus["lastRecordsRead"] | null>(null);
  const recordLifecycleDiagnostic = useCallback((
    event: string,
    detail: {
      readonly stage?: string;
      readonly result?: string;
      readonly candidate?: boolean;
      readonly repositoryGeneration?: string;
      readonly errorCode?: string;
      readonly backend?: string;
      readonly count?: number;
      readonly targetFound?: boolean;
    } = {},
  ): void => {
    if (!(getAppBuildSession()?.debug ?? import.meta.env.DEV)) return;
    const lease = activeProgressLeaseRef.current;
    const store = getShelfStore();
    const repositoryGeneration = detail.repositoryGeneration
      ?? (lease ? store.progressSessionRepositoryGeneration?.(lease) : undefined)
      ?? lastRepositoryGenerationRef.current;
    if (repositoryGeneration && repositoryGeneration !== "unknown") {
      lastRepositoryGenerationRef.current = repositoryGeneration;
    }
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      stage: detail.stage ?? null,
      result: detail.result ?? null,
      candidate: detail.candidate ?? false,
      errorCode: diagnosticErrorCode(detail.errorCode),
      repositoryGeneration,
      jsBoot: jsBootIdRef.current,
      backend: detail.backend ?? null,
      count: detail.count ?? null,
      targetFound: detail.targetFound ?? null,
      lastNativeRecordsRead: lastNativeRecordsReadRef.current,
      portableFacade: portableShelfStateActive(),
      jsSession: sessionGenerationRef.current,
      activeLease: Boolean(activeProgressLeaseRef.current),
      shelfCount: shelfEntriesRef.current.length,
    });
    const lines = lifecycleDiagnosticsRef.current;
    lines.push(line);
    if (lines.length > 20) lines.splice(0, lines.length - 20);
    if (event === "open_failed") {
      // Read only the cached native diagnostic, through the bounded health
      // gate. Do not delay the failed operation or read/migrate shelf data.
      void progressRuntimeGateRef.current?.check().then((status) => {
        lastNativeRecordsReadRef.current = status.lastRecordsRead ?? null;
        recordLifecycleDiagnostic("native_after_failure", {
          stage: detail.stage, result: "sampled",
          repositoryGeneration: status.repositoryGeneration,
        });
      }).catch(() => undefined);
    }
  }, []);
  return {
    progressWriterRef,
    activeProgressLeaseRef,
    progressRuntimeGateRef,
    ensureProgressRuntimeReady,
    localCheckpointsRef,
    retainUnsavedSample,
    lifecycleDiagnosticsRef,
    recordLifecycleDiagnostic,
    firstSampleFailureRecordedRef,
    lastRepositoryGenerationRef,
    lastNativeRecordsReadRef,
  };
}
