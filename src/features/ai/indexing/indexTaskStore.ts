import { invoke } from "@tauri-apps/api/core";

export const LIBRARY_TEXT_INDEX_TASK_KIND = "library-text-index";

export type NativeTaskState = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface NativeIndexTask {
  id: string;
  kind: string;
  contentHash?: string;
  state: NativeTaskState;
  progress: number;
  error?: string;
  cancelRequested: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export async function createLibraryIndexTask(): Promise<NativeIndexTask> {
  return invoke<NativeIndexTask>("ai_task_acquire_library_index");
}

export function updateLibraryIndexTask(id: string, progress: number): Promise<NativeIndexTask> {
  return invoke<NativeIndexTask>("ai_task_update_progress", {
    id,
    progress: Math.max(0, Math.min(1, progress)),
  });
}

export function completeLibraryIndexTask(id: string): Promise<NativeIndexTask> {
  return invoke<NativeIndexTask>("ai_task_complete", { id });
}

export function failLibraryIndexTask(id: string, error: string): Promise<NativeIndexTask> {
  return invoke<NativeIndexTask>("ai_task_fail", { id, error });
}

export function cancelLibraryIndexTask(id: string): Promise<NativeIndexTask> {
  return invoke<NativeIndexTask>("ai_task_cancel", { id });
}

export function listLibraryIndexTasks(): Promise<NativeIndexTask[]> {
  return invoke<NativeIndexTask[]>("ai_task_list").then((tasks) =>
    tasks.filter((task) => task.kind === LIBRARY_TEXT_INDEX_TASK_KIND),
  );
}

/** A cancelled active task with the startup-reclaim message represents an unclean exit. */
export function latestInterruptedLibraryIndexTask(
  tasks: readonly NativeIndexTask[],
): NativeIndexTask | undefined {
  const latest = [...tasks]
    .filter((task) => task.kind === LIBRARY_TEXT_INDEX_TASK_KIND)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  return latest?.state === "cancelled"
    && latest.cancelRequested
    && latest.error?.includes("应用退出")
    ? latest
    : undefined;
}
