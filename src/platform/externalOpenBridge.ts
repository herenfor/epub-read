import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ExternalOpenSource =
  | { kind: "path"; path: string }
  | { kind: "contentUri"; uri: string };

export interface ExternalOpenRequest {
  requestId: string;
  source: ExternalOpenSource;
  /** Android resolves the provider name during native import, not on the UI thread. */
  fileName: string | null;
}

/** Subscribe first, then peek after shelf/session readiness. Events carry no file bytes. */
export async function listenForExternalOpen(
  platform: "android" | "desktop",
  onPending: () => void,
): Promise<() => Promise<void>> {
  if (platform === "android") {
    const listener = await addPluginListener("externalOpen", "pending", onPending);
    return () => listener.unregister();
  }
  const unlisten = await listen("reader-external-open-pending", onPending);
  return async () => { unlisten(); };
}

/** Reading does not consume: failures or unready UI must not silently lose the request. */
export function peekExternalOpen(): Promise<ExternalOpenRequest | null> {
  return invoke("external_open_peek");
}

/** Acknowledge only the current request after success or an explicit user dismissal. */
export function acknowledgeExternalOpen(requestId: string): Promise<boolean> {
  return invoke("external_open_ack", { requestId });
}
