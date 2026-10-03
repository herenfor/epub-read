import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelSaveFile,
  commitSaveFileImport,
  exportSaveFile,
  prepareSaveFileImport,
  type SaveFileCancelResult,
  type SaveFileCommitResult,
  type SaveFileExportResult,
  type SaveFileLocation,
  type SaveFilePrepareResult,
  type SaveFileProgress,
  type SaveExportScope,
} from "../platform/saveFileNativeBridge";

export type SaveFileJobState =
  | { kind: "idle" }
  | {
      kind: "exporting";
      jobId: string;
      progress: SaveFileProgress;
      canceling: boolean;
      cancelTooLate: boolean;
    }
  | {
      kind: "preparing";
      jobId: string;
      progress: SaveFileProgress;
      canceling: boolean;
      cancelTooLate: boolean;
      sourceLabel: string;
    }
  | {
      kind: "prepared";
      jobId: string;
      preview: SaveFilePrepareResult;
      sourceLabel: string;
      canceling: boolean;
    }
  | {
      kind: "committing";
      jobId: string;
      progress: SaveFileProgress;
      sourceLabel: string;
    };

interface ActiveJob {
  jobId: string;
  generation: number;
  operation: "export" | "import";
  cancelRequested: boolean;
}

export interface UseSaveFileJobResult {
  state: SaveFileJobState;
  active: boolean;
  beginExport(input: {
    destination: SaveFileLocation;
    scope: SaveExportScope;
    includeBooks: boolean;
  }): Promise<SaveFileExportResult>;
  beginPrepare(input: {
    source: SaveFileLocation;
    sourceLabel: string;
  }): Promise<SaveFilePrepareResult>;
  commit(applyPreferences: boolean): Promise<SaveFileCommitResult>;
  cancelCurrent(): Promise<SaveFileCancelResult | "noop">;
}

function initialProgress(phase: string): SaveFileProgress {
  return { phase, processedBytes: 0, totalBytes: null };
}

export function useSaveFileJob(): UseSaveFileJobResult {
  const [state, setState] = useState<SaveFileJobState>({ kind: "idle" });
  const stateRef = useRef<SaveFileJobState>({ kind: "idle" });
  const activeRef = useRef<ActiveJob | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const replaceState = useCallback((next: SaveFileJobState): void => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const isCurrent = useCallback((generation: number): boolean => (
    activeRef.current?.generation === generation
  ), []);

  const finish = useCallback((generation: number): void => {
    if (activeRef.current?.generation !== generation) return;
    activeRef.current = null;
    replaceState({ kind: "idle" });
  }, [replaceState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = activeRef.current;
      activeRef.current = null;
      if (active) void cancelSaveFile(active.jobId).catch(() => undefined);
    };
  }, []);

  const beginExport = useCallback(async (input: {
    destination: SaveFileLocation;
    scope: SaveExportScope;
    includeBooks: boolean;
  }): Promise<SaveFileExportResult> => {
    if (activeRef.current) throw new Error("已有存档文件任务正在进行");
    const jobId = crypto.randomUUID();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    activeRef.current = { jobId, generation, operation: "export", cancelRequested: false };
    replaceState({
      kind: "exporting",
      jobId,
      progress: initialProgress("preparing"),
      canceling: false,
      cancelTooLate: false,
    });
    try {
      return await exportSaveFile({
        jobId,
        destination: input.destination,
        scope: input.scope,
        includeBooks: input.includeBooks,
        onProgress: (progress) => {
          if (!isCurrent(generation)) return;
          const current = stateRef.current;
          if (current.kind !== "exporting") return;
          replaceState({ ...current, progress });
        },
      });
    } finally {
      finish(generation);
    }
  }, [finish, isCurrent, replaceState]);

  const beginPrepare = useCallback(async (input: {
    source: SaveFileLocation;
    sourceLabel: string;
  }): Promise<SaveFilePrepareResult> => {
    if (activeRef.current) throw new Error("已有存档文件任务正在进行");
    const jobId = crypto.randomUUID();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    activeRef.current = { jobId, generation, operation: "import", cancelRequested: false };
    replaceState({
      kind: "preparing",
      jobId,
      progress: initialProgress("preparing"),
      canceling: false,
      cancelTooLate: false,
      sourceLabel: input.sourceLabel,
    });
    try {
      const preview = await prepareSaveFileImport({
        jobId,
        source: input.source,
        onProgress: (progress) => {
          if (!isCurrent(generation)) return;
          const current = stateRef.current;
          if (current.kind !== "preparing") return;
          replaceState({ ...current, progress });
        },
      });
      if (isCurrent(generation)) {
        const prepared: SaveFileJobState = {
          kind: "prepared",
          jobId,
          preview,
          sourceLabel: input.sourceLabel,
          canceling: false,
        };
        if (activeRef.current?.cancelRequested) {
          replaceState({ ...prepared, canceling: true });
          try {
            await cancelSaveFile(jobId);
          } catch (error) {
            replaceState(prepared);
            throw error;
          }
          finish(generation);
          const cancelled = new Error("已取消存档导入") as Error & { code: string };
          cancelled.code = "cancelled";
          throw cancelled;
        }
        replaceState(prepared);
      }
      return preview;
    } catch (error) {
      // A failed cancel still owns native prepared resources and can be retried.
      if (stateRef.current.kind !== "prepared") finish(generation);
      throw error;
    }
  }, [finish, isCurrent, replaceState]);

  const commit = useCallback(async (applyPreferences: boolean): Promise<SaveFileCommitResult> => {
    const active = activeRef.current;
    const current = stateRef.current;
    if (
      !active ||
      active.operation !== "import" ||
      current.kind !== "prepared" ||
      current.canceling ||
      current.jobId !== active.jobId
    ) {
      throw new Error("当前没有待确认的存档导入");
    }
    const generation = active.generation;
    replaceState({
      kind: "committing",
      jobId: active.jobId,
      progress: initialProgress("committing"),
      sourceLabel: current.sourceLabel,
    });
    try {
      return await commitSaveFileImport({
        jobId: active.jobId,
        applyPreferences,
        onProgress: (progress) => {
          if (!isCurrent(generation)) return;
          const next = stateRef.current;
          if (next.kind !== "committing") return;
          replaceState({ ...next, progress });
        },
      });
    } finally {
      finish(generation);
    }
  }, [finish, isCurrent, replaceState]);

  const cancelCurrent = useCallback(async (): Promise<SaveFileCancelResult | "noop"> => {
    const active = activeRef.current;
    if (!active) return "noop";
    const current = stateRef.current;
    if (current.kind === "prepared") {
      if (current.canceling) return "noop";
      replaceState({ ...current, canceling: true });
      try {
        const status = await cancelSaveFile(active.jobId);
        finish(active.generation);
        return status;
      } catch (error) {
        if (isCurrent(active.generation)) replaceState({ ...current, canceling: false });
        throw error;
      }
    }
    if (current.kind === "exporting" || current.kind === "preparing") {
      activeRef.current = { ...active, cancelRequested: true };
      replaceState({ ...current, canceling: true });
      try {
        const status = await cancelSaveFile(active.jobId);
        if (status === "too-late") {
          const next = stateRef.current;
          if (
            (next.kind === "exporting" || next.kind === "preparing") &&
            next.jobId === active.jobId
          ) {
            replaceState({ ...next, cancelTooLate: true });
          }
        }
        return status;
      } catch (error) {
        // The original command still owns the active slot; report the cancel
        // failure but keep waiting for its real result.
        throw error;
      }
    }
    if (current.kind === "committing") {
      return cancelSaveFile(active.jobId);
    }
    return "noop";
  }, [finish, isCurrent, replaceState]);

  return {
    state,
    active: state.kind !== "idle",
    beginExport,
    beginPrepare,
    commit,
    cancelCurrent,
  };
}
