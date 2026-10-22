import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * WebDAV sync commands (A25, backend in src-tauri/src/cloud_sync). The
 * backend owns transport, merging, scheduling and retries; this file only
 * names the frozen command and event shapes.
 */

export type CloudSyncPhase = "disconnected" | "idle" | "queued" | "syncing" | "waiting" | "error";

export type CloudSyncTrigger = "manual" | "startup" | "foreground" | "reader-closed" | "data-changed" | "progress-changed";

export interface CloudSyncFailure {
  code: string;
  remote: null | {
    code: string;
    httpStatus: number | null;
    retryAfterSeconds: number | null;
    cleanupFailed: boolean;
  };
  repositoryCode: string | null;
}

export interface CloudSyncDevice {
  installationId: string;
  deviceLabel: string;
  appVersion: string;
  publishedAtMs: number;
}

export interface CloudSyncIssue {
  installationId: string;
  code: string;
}

export interface CloudSyncBook {
  contentHash: string;
  title: string;
  creator: string;
}

export interface CloudSyncConnection {
  connectionId: string;
  baseUrl: string;
  remoteRoot: string;
  username: string;
  spaceId: string;
  deviceLabel: string;
}

export interface CloudSyncStatus {
  nativeReady: boolean;
  connection: CloudSyncConnection | null;
  phase: CloudSyncPhase;
  lastSuccessAtMs: number | null;
  retryAtMs: number | null;
  lastError: CloudSyncFailure | null;
  pending: boolean;
  localChanged: boolean;
  issues: CloudSyncIssue[];
  deviceCount: number;
  cloudOnlyBookCount: number;
  localRecoverySaved: boolean;
}

/** The broadcast part of Status: no server, account or issue list. */
export interface CloudSyncStatusEvent {
  connectionId: string | null;
  phase: CloudSyncPhase;
  pending: boolean;
  lastSuccessAtMs: number | null;
  retryAtMs: number | null;
  localChanged: boolean;
  lastError: CloudSyncFailure | null;
  deviceCount: number;
  cloudOnlyBookCount: number;
  issueCount: number;
}

export interface CloudSyncPreview {
  probeId: string;
  existingSpaceId: string | null;
  cloudBookCount: number;
  devices: CloudSyncDevice[];
  issues: CloudSyncIssue[];
  capabilities: { moveFile: boolean; conditionalCreate: boolean; moveNoReplace: boolean };
}

export interface CloudSyncConnectionInput {
  baseUrl: string;
  remoteRoot: string;
  username: string;
  appPassword: string;
}

/** A rejected command carries a Failure; anything else (IPC loss) is reported as unavailable. */
export function asCloudSyncFailure(error: unknown): CloudSyncFailure {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    const value = error as Partial<CloudSyncFailure> & { code: string };
    return { code: value.code, remote: value.remote ?? null, repositoryCode: value.repositoryCode ?? null };
  }
  return { code: "native-bridge-unavailable", remote: null, repositoryCode: null };
}

export const cloudSyncNative = {
  getStatus: () => invoke<CloudSyncStatus>("cloud_sync_get_status"),
  testConnection: (input: CloudSyncConnectionInput) => invoke<CloudSyncPreview>("cloud_sync_test_connection", { input }),
  connect: (probeId: string, mergeExisting: boolean, deviceLabel: string) =>
    invoke<CloudSyncStatus>("cloud_sync_connect", { probeId, mergeExisting, deviceLabel }),
  trigger: (reason: CloudSyncTrigger) => invoke<CloudSyncStatus>("cloud_sync_trigger", { reason }),
  setContext: (foreground: boolean, interactionBusy: boolean) =>
    invoke<CloudSyncStatus>("cloud_sync_set_context", { context: { foreground, interactionBusy } }),
  cancel: () => invoke<CloudSyncStatus>("cloud_sync_cancel"),
  disconnect: () => invoke<CloudSyncStatus>("cloud_sync_disconnect"),
  resetIdentity: () => invoke<CloudSyncStatus>("cloud_sync_reset_identity"),
  devices: () => invoke<CloudSyncDevice[]>("cloud_sync_devices"),
  cloudBooks: () => invoke<CloudSyncBook[]>("cloud_sync_cloud_books"),
  onStatus: (handler: (event: CloudSyncStatusEvent) => void): Promise<UnlistenFn> =>
    listen<CloudSyncStatusEvent>("cloud-sync-status", (event) => handler(event.payload)),
  onLibraryChanged: (handler: () => void): Promise<UnlistenFn> =>
    listen<null>("cloud-sync-library-changed", () => handler()),
};
