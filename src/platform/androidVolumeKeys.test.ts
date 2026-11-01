import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const addPluginListener = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, addPluginListener }));

import {
  createVolumeKeyModeCoordinator,
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
