import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReaderKeepScreenOnCoordinator,
  readReaderKeepScreenOn,
  setReaderKeepScreenOn,
  shouldKeepReaderScreenOn,
  writeReaderKeepScreenOn,
} from "./androidReaderKeepScreenOn";
import { getRuntimeCapabilities } from "./runtimeCapabilities";
import { clearAppBuildSession, setAppBuildSession } from "../config/appBuildSession";
import type { AppBuildInfo } from "../config/appBuildInfo";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const buildInfo: AppBuildInfo = {
  version: "0.3.1", edition: "core", protocolVersion: 1,
  target: "aarch64-linux-android", profile: "dev", debug: true,
};

afterEach(() => { clearAppBuildSession(); vi.unstubAllGlobals(); invoke.mockClear(); });

describe("Android reader keep-screen-on boundary", () => {
  it("is offered only in an established Android native session", () => {
    clearAppBuildSession();
    expect(getRuntimeCapabilities().supportsReaderKeepScreenOn).toBe(false);
    setAppBuildSession({ source: "browser", edition: "core", debug: true });
    expect(getRuntimeCapabilities().supportsReaderKeepScreenOn).toBe(false);
    setAppBuildSession({ source: "desktop", buildInfo: { ...buildInfo, target: "x86_64-pc-windows-msvc" } });
    expect(getRuntimeCapabilities().supportsReaderKeepScreenOn).toBe(false);
    setAppBuildSession({ source: "desktop", buildInfo });
    expect(getRuntimeCapabilities().supportsReaderKeepScreenOn).toBe(true);
  });

  it("defaults off, turns on only for exactly \"true\", and surfaces write failures", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    expect(readReaderKeepScreenOn()).toBe(false);
    writeReaderKeepScreenOn(true);
    expect(readReaderKeepScreenOn()).toBe(true);
    expect([...values.entries()]).toEqual([["epub-reader:keep-screen-on", "true"]]);
    values.set("epub-reader:keep-screen-on", "1");
    expect(readReaderKeepScreenOn()).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("quota"); } });
    expect(readReaderKeepScreenOn()).toBe(false);
    expect(() => writeReaderKeepScreenOn(true)).toThrow("quota");
  });

  it("asks native only while reading, opted in and visible", () => {
    expect(shouldKeepReaderScreenOn({ readerActive: true, keepWhileReading: true, visible: true })).toBe(true);
    expect(shouldKeepReaderScreenOn({ readerActive: false, keepWhileReading: true, visible: true })).toBe(false);
    expect(shouldKeepReaderScreenOn({ readerActive: true, keepWhileReading: false, visible: true })).toBe(false);
    expect(shouldKeepReaderScreenOn({ readerActive: true, keepWhileReading: true, visible: false })).toBe(false);
  });

  it("sends the required boolean and applies the latest intent after a late write", async () => {
    await setReaderKeepScreenOn(true);
    expect(invoke.mock.calls).toEqual([["reader_set_keep_screen_on", { enabled: true }]]);

    const applied: boolean[] = [];
    let releaseFirst!: () => void;
    const apply = vi.fn((enabled: boolean) => {
      applied.push(enabled);
      return applied.length === 1 ? new Promise<void>((resolve) => { releaseFirst = resolve; }) : Promise.resolve();
    });
    const coordinator = createReaderKeepScreenOnCoordinator(apply);
    const first = coordinator.requestEnabled(true);
    await Promise.resolve();
    void coordinator.requestEnabled(false);
    releaseFirst();
    await first;
    expect(applied).toEqual([true, false]);
  });
});
