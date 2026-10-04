import { invoke } from "@tauri-apps/api/core";

/**
 * Android-only QR scanner bridge for joining a LAN save session.
 *
 * The Kotlin plugin owns the camera Activity. This function resolves with the
 * scanned string, or `null` when the user cancels/denies camera permission.
 * Callers must keep the paste/connection-info path available on every failure.
 */
export async function scanAndroidQrCode(): Promise<string | null> {
  return invoke<string | null>("android_lan_scan_qr");
}
