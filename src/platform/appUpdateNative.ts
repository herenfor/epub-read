import { Channel, invoke } from "@tauri-apps/api/core";
import type { InstallKind } from "../config/appUpdate";
import { getAppBuildSession } from "../config/appBuildSession";

const INSTALL_KINDS: readonly InstallKind[] = ["installer", "portable", "android", "unsupported"];

/** The native side decides how this copy may update; a browser or an unknown answer never updates itself. */
export async function readInstallKind(): Promise<InstallKind> {
  if (getAppBuildSession()?.source !== "desktop") return "unsupported";
  try {
    const kind = await invoke<string>("app_update_install_kind");
    return (INSTALL_KINDS as readonly string[]).includes(kind) ? kind as InstallKind : "unsupported";
  } catch {
    return "unsupported";
  }
}

/* ---- Windows installed copy: tauri-plugin-updater 2.11.0, called through its IPC commands ---- */

interface UpdaterMetadata {
  rid: number;
  version: string;
}

type UpdaterDownloadEvent =
  | { event: "Started"; data: { contentLength?: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface WindowsUpdate {
  readonly version: string;
  /** Downloads and verifies the signed installer in the native process. */
  download(onProgress: (received: number, total: number | null) => void): Promise<void>;
  /** Runs the installer, which ends this process; save everything first. */
  install(): Promise<void>;
  /** Releases the native handles. Does not stop a download already under way. */
  close(): Promise<void>;
}

async function closeResource(rid: number | null): Promise<void> {
  if (rid === null) return;
  await invoke("plugin:resources|close", { rid }).catch(() => undefined);
}

/** The plugin's own check against latest.json (signature source); null when it offers nothing newer. */
export async function checkWindowsUpdate(): Promise<WindowsUpdate | null> {
  const metadata = await invoke<UpdaterMetadata | null>("plugin:updater|check", {});
  if (!metadata) return null;
  const updateRid = metadata.rid;
  let bytesRid: number | null = null;
  let closed = false;
  return {
    version: metadata.version,
    async download(onProgress) {
      let received = 0;
      let total: number | null = null;
      const channel = new Channel<UpdaterDownloadEvent>();
      channel.onmessage = (message) => {
        if (message.event === "Started") total = message.data.contentLength ?? null;
        else if (message.event === "Progress") received += message.data.chunkLength;
        onProgress(received, total);
      };
      const rid = await invoke<number>("plugin:updater|download", { rid: updateRid, onEvent: channel });
      // Abandoned while downloading: the late result is released, never installed.
      if (closed) { await closeResource(rid); throw new Error("abandoned"); }
      await closeResource(bytesRid);
      bytesRid = rid;
    },
    async install() {
      if (closed || bytesRid === null) throw new Error("not downloaded");
      await invoke("plugin:updater|install", { updateRid, bytesRid, restartAfterInstall: true });
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeResource(bytesRid);
      bytesRid = null;
      await closeResource(updateRid);
    },
  };
}

/* ---- Android: AppUpdatePlugin (DownloadManager + package checks + system installer) ---- */

export type AndroidDownloadState = "idle" | "running" | "done" | "failed";

export interface AndroidDownloadStatus {
  state: AndroidDownloadState;
  received: number;
  total: number | null;
  /** Native reason code when failed (download, sha256, package, certificate, version, missing). */
  reason?: string;
}

export interface AndroidVerifyResult {
  ok: boolean;
  reason?: string;
}

export type AndroidInstallPermission = "granted" | "denied" | "unknown";

function androidUpdate<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("android_app_update", { action, args });
}

export const androidUpdater = {
  start: (asset: { url: string; sha256: string; size: number; version: string }) =>
    androidUpdate<void>("start", asset),
  status: () => androidUpdate<AndroidDownloadStatus>("status"),
  cancel: () => androidUpdate<void>("cancel"),
  verify: () => androidUpdate<AndroidVerifyResult>("verify"),
  canInstall: async (): Promise<AndroidInstallPermission> =>
    (await androidUpdate<{ permission: AndroidInstallPermission }>("canInstall")).permission,
  openInstallPermission: () => androidUpdate<void>("openInstallPermission"),
  install: () => androidUpdate<void>("install"),
  cleanup: () => androidUpdate<void>("cleanup"),
};
