import { invoke } from "@tauri-apps/api/core";

export const MODEL_DOWNLOAD_STATES = [
  "queued",
  "downloading",
  "paused",
  "verifying",
  "completed",
  "cancelled",
  "failed",
] as const;

export type ModelDownloadState = (typeof MODEL_DOWNLOAD_STATES)[number];

export interface ModelDownloadTask {
  id: string;
  packageId: string;
  state: ModelDownloadState;
  bytesDownloaded: number;
  totalBytes: number | null;
  currentFilePath: string | null;
  currentFileIndex: number | null;
  packageTotalBytes: number | null;
  currentSourceUrl: string | null;
  sourceIndex: number | null;
  error: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ModelDownloadEnqueueResult {
  task: ModelDownloadTask;
  existing: boolean;
}

export interface ModelDownloadPort {
  enqueue(packageId: string): Promise<ModelDownloadEnqueueResult>;
  list(): Promise<ModelDownloadTask[]>;
  pause(taskId: string): Promise<ModelDownloadTask>;
  resume(taskId: string): Promise<ModelDownloadTask>;
  cancel(taskId: string): Promise<ModelDownloadTask>;
  acceptLicense(packageId: string): Promise<void>;
}

export function createTauriModelDownloadPort(): ModelDownloadPort {
  return {
    enqueue: (packageId) => invoke<ModelDownloadEnqueueResult>("ai_model_download_enqueue", { packageId }),
    list: () => invoke<ModelDownloadTask[]>("ai_model_download_list"),
    pause: (taskId) => invoke<ModelDownloadTask>("ai_model_download_pause", { taskId }),
    resume: (taskId) => invoke<ModelDownloadTask>("ai_model_download_resume", { taskId }),
    cancel: (taskId) => invoke<ModelDownloadTask>("ai_model_download_cancel", { taskId }),
    acceptLicense: (packageId) => invoke<void>("ai_model_license_accept", { packageId }),
  };
}
