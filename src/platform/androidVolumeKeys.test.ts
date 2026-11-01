import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const addPluginListener = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, addPluginListener }));

import {
  createVolumeKeyModeCoordinator,
  createVolumeKeyModeGate,
  readVolumeKeyReverse,
  readVolumeKeyTurn,
  setNativeVolumeKeyMode,
  volumeKeyModeFor,
  writeVolumeKeyReverse,
  writeVolumeKeyTurn,
  type VolumeKeyMode,
} from "./androidVolumeKeys";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function stubStorage(): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return values;
}

describe("Android volume-key paging boundary", () => {
  it("stores the two device-local preferences independently", () => {
    const values = stubStorage();
    expect(readVolumeKeyTurn()).toBe(false);
    expect(readVolumeKeyReverse()).toBe(false);
    writeVolumeKeyTurn(true);
    writeVolumeKeyReverse(true);
    expect(readVolumeKeyTurn()).toBe(true);
    expect(readVolumeKeyReverse()).toBe(true);
    expect([...values.keys()]).toEqual([
      "epub-reader:volume-key-turn",
      "epub-reader:volume-key-turn-reverse",
    ]);

    values.set("epub-reader:volume-key-turn", "1");
    expect(readVolumeKeyTurn()).toBe(false);
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("unavailable"); },
      setItem: () => { throw new Error("quota"); },
    });
    expect(readVolumeKeyTurn()).toBe(false);
    expect(readVolumeKeyReverse()).toBe(false);
    expect(() => writeVolumeKeyTurn(true)).toThrow("quota");
  });

  it("arms native only while the reader is visible and opted in", () => {
    expect(volumeKeyModeFor({ readerActive: true, enabled: true, reverse: false, visible: true })).toBe("on");
    expect(volumeKeyModeFor({ readerActive: true, enabled: true, reverse: true, visible: true })).toBe("reverse");
    expect(volumeKeyModeFor({ readerActive: false, enabled: true, reverse: true, visible: true })).toBe("off");
    expect(volumeKeyModeFor({ readerActive: true, enabled: false, reverse: true, visible: true })).toBe("off");
    expect(volumeKeyModeFor({ readerActive: true, enabled: true, reverse: true, visible: false })).toBe("off");
  });

  it("sends the mode through the native command", async () => {
    await setNativeVolumeKeyMode("reverse");
    expect(invoke).toHaveBeenCalledWith("android_volume_key_set_mode", { mode: "reverse" });
  });

  it("applies the latest mode after a late native write", async () => {
    const applied: VolumeKeyMode[] = [];
    let releaseFirst!: () => void;
    const apply = vi.fn((mode: VolumeKeyMode) => {
      applied.push(mode);
      return applied.length === 1 ? new Promise<void>((resolve) => { releaseFirst = resolve; }) : Promise.resolve();
    });
    const coordinator = createVolumeKeyModeCoordinator(apply);
    const first = coordinator.requestMode("on");
    await Promise.resolve();
    void coordinator.requestMode("off");
    releaseFirst();
    await first;
    expect(applied).toEqual(["on", "off"]);
  });

  it.each([false, true])("preserves native hold interruption across a quick overlay reopen (stop fails: %s)", async (stopFails) => {
    let releaseFirst!: () => void;
    let reportFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => { reportFirstWrite = resolve; });
    invoke.mockImplementationOnce(() => {
      reportFirstWrite();
      return new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const stopError = new Error("native stop failed");
    if (stopFails) invoke.mockRejectedValueOnce(stopError);

    const coordinator = createVolumeKeyModeCoordinator();
    const gate = createVolumeKeyModeGate({
      ensureSubscription: () => Promise.resolve(),
      apply: (mode, force) => coordinator.requestMode(mode, force),
      onSubscriptionFailure: vi.fn(),
    });
    const reading = { readerActive: true, enabled: true, reverse: false, visible: true };
    const entering = gate.request(reading);
    await firstWriteStarted;
    const openingOverlay = gate.request({ ...reading, readerActive: false });
    const closingOverlay = gate.request(reading);
    // Let the new "on" reach the coordinator before the old native call finishes.
    await Promise.resolve();
    const completed = Promise.allSettled([entering, openingOverlay, closingOverlay]);
    releaseFirst();
    const results = await completed;

    expect(invoke.mock.calls).toEqual((stopFails ? ["on", "off"] : ["on", "off", "on"]).map((mode) => [
      "android_volume_key_set_mode", { mode },
    ]));
    expect(results).toEqual(stopFails
      ? Array.from({ length: 3 }, () => ({ status: "rejected", reason: stopError }))
      : Array.from({ length: 3 }, () => ({ status: "fulfilled", value: undefined })));
  });

  it("keeps system volume when the native subscription fails", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const onFailure = vi.fn();
    const gate = createVolumeKeyModeGate({
      ensureSubscription: () => Promise.reject(new Error("ACL denied")),
      apply,
      onSubscriptionFailure: onFailure,
    });

    await gate.request({ readerActive: true, enabled: true, reverse: false, visible: true });
    expect(apply.mock.calls).toEqual([["off", true]]);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm when a late subscription succeeds after leaving the reader", async () => {
    let settle!: (value: undefined) => void;
    const subscription = new Promise<void>((resolve) => { settle = resolve; });
    const apply = vi.fn().mockResolvedValue(undefined);
    const gate = createVolumeKeyModeGate({
      ensureSubscription: () => subscription,
      apply,
      onSubscriptionFailure: vi.fn(),
    });

    const arming = gate.request({ readerActive: true, enabled: true, reverse: false, visible: true });
    const leaving = gate.request({ readerActive: false, enabled: true, reverse: false, visible: true });
    settle(undefined);
    await Promise.all([arming, leaving]);
    expect(apply.mock.calls).toEqual([["off", true]]);
  });

  it("turns native off for a blocking overlay without requiring the listener", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const ensureSubscription = vi.fn();
    const gate = createVolumeKeyModeGate({
      ensureSubscription,
      apply,
      onSubscriptionFailure: vi.fn(),
    });

    await gate.request({ readerActive: false, enabled: true, reverse: false, visible: true });
    expect(ensureSubscription).not.toHaveBeenCalled();
    expect(apply.mock.calls).toEqual([["off", true]]);
  });

  it("forwards only valid directions and stops after unsubscribe", async () => {
    vi.resetModules();
    let nativeCallback: ((payload: unknown) => void) | undefined;
    addPluginListener.mockImplementation((_plugin: string, _event: string, callback: (payload: unknown) => void) => {
      nativeCallback = callback;
      return Promise.resolve({ unregister: vi.fn() });
    });

    const module = await import("./androidVolumeKeys");
    const turns: number[] = [];
    const release = module.subscribeVolumeKeyTurn((direction) => turns.push(direction));

    expect(addPluginListener).toHaveBeenCalledWith("androidVolumeKey", "volume-key", expect.any(Function));
    nativeCallback?.({ direction: 1 });
    nativeCallback?.({ direction: -1 });
    nativeCallback?.({ direction: 0 });
    nativeCallback?.(null);
    nativeCallback?.({ direction: "1" });
    expect(turns).toEqual([1, -1]);

    release();
    nativeCallback?.({ direction: 1 });
    expect(turns).toEqual([1, -1]);
  });
});
