import type { ModelPackageRecord } from "./modelAssets";
import type { ModelDownloadTask } from "./modelDownloads";

export interface ModelAssetActionState {
  canVerify: boolean;
  canRelocate: boolean;
  canEnqueue: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canRemove: boolean;
  disabled: boolean;
}

/** Centralizes the package/task action matrix so JSX cannot accidentally offer an unsafe action. */
export function getModelAssetActionState(
  packageRecord: ModelPackageRecord,
  task: ModelDownloadTask | undefined,
  busy: boolean,
): ModelAssetActionState {
  const managed = packageRecord.storageKind === "managed";
  const taskState = task?.state;
  const canPause = taskState === "queued" || taskState === "downloading" || taskState === "verifying";
  const canResume = taskState === "paused";
  const canCancel = canPause || canResume;
  const taskIsActiveOrRecoverable = ["queued", "downloading", "verifying", "paused"].includes(taskState ?? "");
  const canEnqueue = managed
    && packageRecord.state !== "installed"
    && (taskState === undefined || taskState === "failed" || taskState === "cancelled")
    && ["failed", "cancelled", "uninstalled"].includes(packageRecord.state);
  return {
    canVerify: !taskIsActiveOrRecoverable,
    canRelocate: packageRecord.storageKind === "linked" && !taskIsActiveOrRecoverable,
    canEnqueue,
    canPause,
    canResume,
    canCancel,
    canRemove: !taskIsActiveOrRecoverable,
    disabled: busy,
  };
}

export function formatModelDownloadProgress(task: ModelDownloadTask): string {
  const total = task.totalBytes === null ? "未知" : String(task.totalBytes);
  const file = task.currentFilePath ? ` · 当前文件：${task.currentFilePath}` : "";
  return `${task.bytesDownloaded}/${total} bytes${file}`;
}
