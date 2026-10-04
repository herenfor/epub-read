import { invoke } from "@tauri-apps/api/core";

export type AndroidLanScanStatus = "scanned" | "cancelled" | "permission-denied" | "no-camera" | "camera-error";

export interface AndroidLanScanOutcome {
  status: AndroidLanScanStatus;
  contents: string | null;
}

const KNOWN_STATUSES: readonly AndroidLanScanStatus[] = [
  "scanned", "cancelled", "permission-denied", "no-camera", "camera-error",
];

/**
 * Android-only QR scanner bridge for joining a LAN save session.
 *
 * The Kotlin plugin owns the scanner Activity and its camera permission and
 * always reports a status. Callers must keep the paste/connection-info path
 * available on every outcome other than `scanned`.
 */
export async function scanAndroidQrCode(): Promise<AndroidLanScanOutcome> {
  const raw = await invoke<{ status?: unknown; contents?: unknown } | null>("android_lan_scan_qr");
  const status = KNOWN_STATUSES.includes(raw?.status as AndroidLanScanStatus)
    ? raw!.status as AndroidLanScanStatus
    : "cancelled";
  const contents = typeof raw?.contents === "string" && raw.contents.trim() ? raw.contents.trim() : null;
  if (status === "scanned" && !contents) return { status: "cancelled", contents: null };
  return { status, contents };
}

/** Opens this app's system settings page so the user can allow the camera. */
export async function openAndroidAppSettings(): Promise<void> {
  await invoke("android_lan_open_app_settings");
}
