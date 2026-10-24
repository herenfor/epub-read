import { useSyncExternalStore } from "react";
import { getRuntimeCapabilities } from "../../platform/runtimeCapabilities";
import { interactionBusy, onInteractionBusyChange } from "../../platform/cloudSyncActivity";
import {
  asCloudSyncFailure,
  cloudSyncNative,
  type CloudSyncFailure,
  type CloudSyncStatus,
  type CloudSyncStatusEvent,
  type CloudSyncTrigger,
} from "../../platform/cloudSyncNative";

/**
 * Cloud sync on the front end: status for the settings section, the
 * opportunistic triggers (startup, data/progress changes, leaving the
 * reader) and the foreground/busy edges. The backend decides when a round
 * actually runs, merges and retries; nothing here polls, retries or treats a
 * resolved trigger as a finished sync.
 */

export interface CloudSyncView {
  /** This build offers sync at all (native Windows or Android). */
  supported: boolean;
  /** Null until the first status answer. */
  status: CloudSyncStatus | null;
  /** The last status read failed; the section shows it instead of a form. */
  readError: CloudSyncFailure | null;
}

let view: CloudSyncView = { supported: false, status: null, readError: null };
const listeners = new Set<() => void>();
let started = false;
let foreground = true;
/** What the backend last heard; a sent "busy" is always followed by its "idle". */
let sentBusy = false;

function publish(next: Partial<CloudSyncView>): void {
  view = { ...view, ...next };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): CloudSyncView {
  return view;
}

export function useCloudSync(): CloudSyncView {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * A failure the backend will not retry on its own: the round stopped in
 * error with no retry time. Backoff (network, rate limit, 5xx) keeps a retry
 * time and a cancel goes back to idle, so neither asks the user for anything.
 */
export function cloudSyncNeedsAttention(status: CloudSyncStatus | null): boolean {
  return status?.phase === "error" && status.lastError !== null && status.lastError.code !== "cancelled"
    && status.retryAtMs === null;
}

export function useCloudSyncAttention(): boolean {
  return cloudSyncNeedsAttention(useCloudSync().status);
}

export function cloudSyncSupported(): boolean {
  return getRuntimeCapabilities().supportsCloudSync;
}

/** Re-reads the complete status (configuration and issue list included). */
export async function refreshCloudSyncStatus(): Promise<CloudSyncStatus | null> {
  if (!cloudSyncSupported()) return null;
  try {
    const status = await cloudSyncNative.getStatus();
    publish({ supported: true, status, readError: null });
    return status;
  } catch (error) {
    publish({ supported: true, readError: asCloudSyncFailure(error) });
    return null;
  }
}

/** Events carry lifecycle only; a different connection or issue list needs a full read. */
export function mergeStatusEvent(status: CloudSyncStatus, event: CloudSyncStatusEvent): CloudSyncStatus | null {
  if ((status.connection?.connectionId ?? null) !== event.connectionId || status.issues.length !== event.issueCount) {
    return null;
  }
  return {
    ...status,
    phase: event.phase,
    pending: event.pending,
    lastSuccessAtMs: event.lastSuccessAtMs,
    retryAtMs: event.retryAtMs,
    localChanged: event.localChanged,
    lastError: event.lastError,
    deviceCount: event.deviceCount,
    cloudOnlyBookCount: event.cloudOnlyBookCount,
  };
}

function applyStatusEvent(event: CloudSyncStatusEvent): void {
  const merged = view.status ? mergeStatusEvent(view.status, event) : null;
  if (merged) publish({ status: merged });
  else void refreshCloudSyncStatus();
}

function sendContext(edge: "foreground" | "busy"): void {
  if (!started) return;
  const busy = interactionBusy();
  // Every tap in the reader is a busy edge; without a connection nobody needs it.
  if (edge === "busy" && !sentBusy && !view.status?.connection) return;
  sentBusy = busy;
  void cloudSyncNative.setContext(foreground, busy).catch(() => undefined);
}

/**
 * A saved change worth syncing soon. Only after startup and only while a
 * connection exists; the backend coalesces bursts and throttles progress.
 */
export function noteCloudSyncChange(reason: Extract<CloudSyncTrigger, "data-changed" | "progress-changed" | "reader-closed">): void {
  if (!started || !view.status?.connection) return;
  void cloudSyncNative.trigger(reason).catch(() => undefined);
}

/**
 * Called once the shelf repository is active and the shelf is on screen.
 * Registers the native events and lifecycle edges, then asks for the
 * startup round (the backend delays it). Returns the teardown.
 */
export function startCloudSync(options: { onLibraryChanged(): void }): () => void {
  if (started || !cloudSyncSupported()) return () => undefined;
  started = true;
  publish({ supported: true });
  let stopped = false;
  const unlisten: Array<Promise<() => void>> = [
    cloudSyncNative.onStatus(applyStatusEvent),
    // Refresh shelf/folders only; the open reader keeps its own page.
    cloudSyncNative.onLibraryChanged(() => options.onLibraryChanged()),
  ];
  const onVisibility = (): void => {
    const next = document.visibilityState !== "hidden";
    if (next === foreground) return;
    foreground = next;
    sendContext("foreground");
  };
  document.addEventListener("visibilitychange", onVisibility);
  const stopBusy = onInteractionBusyChange(() => sendContext("busy"));
  foreground = document.visibilityState !== "hidden";
  void (async () => {
    if (!foreground) await cloudSyncNative.setContext(false, false).catch(() => undefined);
    const status = await cloudSyncNative.trigger("startup").catch(() => null);
    if (stopped) return;
    if (status) publish({ status, readError: null });
    else await refreshCloudSyncStatus();
  })();
  return () => {
    stopped = true;
    started = false;
    document.removeEventListener("visibilitychange", onVisibility);
    stopBusy();
    for (const promise of unlisten) void promise.then((stop) => stop()).catch(() => undefined);
  };
}

/** Runs one settings action; any failure re-reads status, since the backend may have changed state anyway. */
export async function runCloudSyncAction<T>(action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: CloudSyncFailure }> {
  try {
    const value = await action();
    return { ok: true, value };
  } catch (error) {
    await refreshCloudSyncStatus();
    return { ok: false, failure: asCloudSyncFailure(error) };
  }
}

/** Status-returning commands update the view directly. */
export function adoptCloudSyncStatus(status: CloudSyncStatus): void {
  publish({ supported: true, status, readError: null });
}

export function resetCloudSyncStoreForTest(): void {
  view = { supported: false, status: null, readError: null };
  listeners.clear();
  started = false;
  foreground = true;
  sentBusy = false;
}
