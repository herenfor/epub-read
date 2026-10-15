import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatusBarAppearanceCoordinator, readHideReaderSystemStatusBar, writeHideReaderSystemStatusBar, setReaderSystemStatusBarHidden } from "./androidReaderSystemStatusBar";
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

describe("Android reader status bar boundary", () => {
  it("offers native control only after the Android build handshake", () => {
    clearAppBuildSession();
    expect(getRuntimeCapabilities().supportsReaderSystemStatusBar).toBe(false);
    setAppBuildSession({ source: "browser", edition: "core", debug: true });
    expect(getRuntimeCapabilities().supportsReaderSystemStatusBar).toBe(false);
    setAppBuildSession({ source: "desktop", buildInfo });
    expect(getRuntimeCapabilities().supportsReaderSystemStatusBar).toBe(true);
    setAppBuildSession({ source: "desktop", buildInfo: { ...buildInfo, target: "x86_64-pc-windows-msvc" } });
    expect(getRuntimeCapabilities().supportsReaderSystemStatusBar).toBe(false);
  });

  it("defaults to hidden and persists a device-local opt out, surfacing write failures", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    expect(readHideReaderSystemStatusBar()).toBe(true);
    writeHideReaderSystemStatusBar(false);
    expect(readHideReaderSystemStatusBar()).toBe(false);
    expect([...values.entries()]).toEqual([["epub-reader:hide-system-status-bar", "false"]]);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("quota"); } });
    expect(readHideReaderSystemStatusBar()).toBe(true);
    expect(() => writeHideReaderSystemStatusBar(false)).toThrow("quota");
  });

  it("sends the required boolean to the status-bar-only native command", async () => {
    await setReaderSystemStatusBarHidden(true);
    await setReaderSystemStatusBarHidden(false);
    expect(invoke.mock.calls).toEqual([["android_reader_system_bars", { hidden: true }], ["android_reader_system_bars", { hidden: false }]]);
  });

  it("maps the four app surfaces to legible icons without changing bar visibility", async () => {
    const appearance = createStatusBarAppearanceCoordinator();
    await appearance.requestTheme("light");
    await appearance.requestTheme("sepia");
    await appearance.requestTheme("gray");
    await appearance.requestTheme("dark");
    expect(invoke.mock.calls).toEqual([
      ["android_status_bar_appearance", { darkIcons: true }],
      ["android_status_bar_appearance", { darkIcons: false }],
    ]);
  });

  it("keeps the final app theme when an older native appearance request finishes late", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const apply = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
    const appearance = createStatusBarAppearanceCoordinator(apply);
    const pending = appearance.requestTheme("light");
    await Promise.resolve();
    appearance.requestTheme("dark");
    appearance.requestTheme("sepia");
    appearance.requestTheme("gray");
    expect(apply.mock.calls).toEqual([[true]]);
    release();
    await pending;
    expect(apply.mock.calls).toEqual([[true], [false]]);
  });
});
