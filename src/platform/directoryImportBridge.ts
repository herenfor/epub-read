import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  DirectoryImportPort,
  DirectoryImportResult,
  DirectoryProgress,
  InputPage,
  IssuePage,
  ScanResult,
} from "../core/folderImport/contract";

/** What `directory_import_pick` returns: the user's chosen source, no job yet. */
export type NativeDirectorySource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "treeUri"; readonly uri: string };

function newJobId(): string {
  return crypto.randomUUID();
}

/** Progress channel that drops events from any other (older) job. */
function progressChannel(jobId: string, onProgress: (event: DirectoryProgress) => void): Channel<DirectoryProgress> {
  const channel = new Channel<DirectoryProgress>();
  channel.onmessage = (event) => {
    if (event.jobId === jobId) onProgress(event);
  };
  return channel;
}

/** Omit an absent cursor instead of sending explicit null (missing stays missing). */
function cursorArgs(jobId: string, cursor: string | undefined): Record<string, string> {
  return cursor === undefined ? { jobId } : { jobId, cursor };
}

/**
 * Windows/Android directory import through the FI-N commands. Source handles,
 * staging and the job slot live in the native job; this port only carries IDs,
 * light metadata pages and progress.
 */
export function createNativeDirectoryImportPort(): DirectoryImportPort {
  return {
    async scan(onProgress): Promise<ScanResult | null> {
      const source = await invoke<NativeDirectorySource | null>("directory_import_pick");
      if (!source) return null;
      const jobId = newJobId();
      // Only native progress proves the job has been registered and its worker
      // admitted. A synthetic event here could release a not-yet-existing job.
      return invoke<ScanResult>("directory_import_scan", {
        jobId,
        source,
        onProgress: progressChannel(jobId, onProgress),
      });
    },
    page(jobId, cursor): Promise<InputPage> {
      return invoke<InputPage>("directory_import_page", cursorArgs(jobId, cursor));
    },
    start(input): Promise<DirectoryImportResult> {
      return invoke<DirectoryImportResult>("directory_import_start", {
        jobId: input.jobId,
        options: input.options,
        targets: input.targets,
        onProgress: progressChannel(input.jobId, input.onProgress),
      });
    },
    issues(jobId, cursor): Promise<IssuePage> {
      return invoke<IssuePage>("directory_import_issues", cursorArgs(jobId, cursor));
    },
    async cancel(jobId) {
      const result = await invoke<{ status: "requested" | "settling" | "already-finished" }>(
        "directory_import_cancel",
        { jobId },
      );
      return result.status;
    },
    async dispose(jobId): Promise<void> {
      await invoke("directory_import_dispose", { jobId });
    },
  };
}
