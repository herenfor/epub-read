import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("../../platform/runtimeCapabilities", () => ({
  getRuntimeCapabilities: () => ({ platform: "android", supportsCloudSync: true }),
}));

import { holdInteractionBusy } from "../../platform/cloudSyncActivity";
import type { CloudSyncStatus } from "../../platform/cloudSyncNative";
import { mergeStatusEvent, noteCloudSyncChange, resetCloudSyncStoreForTest, startCloudSync } from "./cloudSyncStore";
import { cloudSyncFailureText } from "./CloudSyncPanel";

const connected: CloudSyncStatus = {
  nativeReady: true,
  connection: { connectionId: "c1", baseUrl: "https://dav.example/dav/", remoteRoot: "EPUBReader", username: "u", spaceId: "s", deviceLabel: "phone" },
  phase: "idle",
  lastSuccessAtMs: null,
  retryAtMs: null,
  lastError: null,
  pending: false,
  localChanged: false,
  issues: [],
  deviceCount: 1,
  cloudOnlyBookCount: 0,
  localRecoverySaved: false,
};

const handlers = new Map<string, (event: { payload: unknown }) => void>();
const visibility = { state: "visible" as DocumentVisibilityState, listener: null as null | (() => void) };

beforeEach(() => {
  resetCloudSyncStoreForTest();
  invoke.mockReset();
  listen.mockReset();
  handlers.clear();
  listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  });
  invoke.mockImplementation(async (command: string) => command === "cloud_sync_devices" ? [] : connected);
  vi.stubGlobal("document", {
    get visibilityState() { return visibility.state; },
    addEventListener: (_: string, listener: () => void) => { visibility.listener = listener; },
    removeEventListener: () => { visibility.listener = null; },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const calls = () => invoke.mock.calls.map(([command, args]) => [command, args]);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("cloud sync triggers", () => {
  it("sends nothing before startup, then the startup round and saved changes only while connected", async () => {
    noteCloudSyncChange("data-changed");
    expect(invoke).not.toHaveBeenCalled();

    const stop = startCloudSync({ onLibraryChanged: () => undefined });
    await flush();
    expect(calls()).toEqual([["cloud_sync_trigger", { reason: "startup" }]]);

    noteCloudSyncChange("progress-changed");
    noteCloudSyncChange("reader-closed");
    expect(calls().slice(1)).toEqual([
      ["cloud_sync_trigger", { reason: "progress-changed" }],
      ["cloud_sync_trigger", { reason: "reader-closed" }],
    ]);
    stop();
    await flush();
    expect(handlers.size).toBe(0);
    noteCloudSyncChange("data-changed");
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("reports only busy and foreground edges, and refreshes the shelf on library changes", async () => {
    const refreshed = vi.fn();
    const stop = startCloudSync({ onLibraryChanged: refreshed });
    await flush();
    invoke.mockClear();

    const drag = holdInteractionBusy();
    const turn = holdInteractionBusy();
    drag();
    drag();
    turn();
    visibility.state = "hidden";
    visibility.listener?.();
    visibility.listener?.();
    expect(calls()).toEqual([
      ["cloud_sync_set_context", { context: { foreground: true, interactionBusy: true } }],
      ["cloud_sync_set_context", { context: { foreground: true, interactionBusy: false } }],
      ["cloud_sync_set_context", { context: { foreground: false, interactionBusy: false } }],
    ]);

    // Not connected: taps in the reader stay local.
    invoke.mockClear();
    visibility.state = "visible";
    visibility.listener?.();
    invoke.mockResolvedValueOnce({ ...connected, connection: null });
    await import("./cloudSyncStore").then((store) => store.refreshCloudSyncStatus());
    invoke.mockClear();
    holdInteractionBusy()();
    expect(invoke).not.toHaveBeenCalled();

    handlers.get("cloud-sync-library-changed")!({ payload: null });
    expect(refreshed).toHaveBeenCalledTimes(1);
    stop();
    visibility.state = "visible";
  });

  it("merges lifecycle events and asks for a full read when the connection or issues differ", () => {
    const event = {
      connectionId: "c1", phase: "syncing" as const, pending: true, lastSuccessAtMs: 5, retryAtMs: null,
      localChanged: false, lastError: null, deviceCount: 2, cloudOnlyBookCount: 3, issueCount: 0,
    };
    expect(mergeStatusEvent(connected, event)).toMatchObject({ phase: "syncing", deviceCount: 2, connection: connected.connection });
    expect(mergeStatusEvent(connected, { ...event, connectionId: "c2" })).toBeNull();
    expect(mergeStatusEvent(connected, { ...event, issueCount: 1 })).toBeNull();
  });
});

describe("cloud sync failure text", () => {
  const t = ((key: string, args?: Record<string, unknown>) => args ? `${key}:${JSON.stringify(args)}` : key) as never;

  it("names remote, repository and unknown codes without guessing", () => {
    expect(cloudSyncFailureText(t, { code: "remote", repositoryCode: null,
      remote: { code: "authentication", httpStatus: 401, retryAfterSeconds: null, cleanupFailed: false } })).toBe("cloudSync.remote.authentication");
    expect(cloudSyncFailureText(t, { code: "repository-error", remote: null, repositoryCode: "stale-basis" }))
      .toBe('cloudSync.error.repository-error:{"code":"stale-basis"}');
    expect(cloudSyncFailureText(t, { code: "toString", remote: null, repositoryCode: null }))
      .toBe('cloudSync.error.unknown:{"code":"toString"}');
  });
});
