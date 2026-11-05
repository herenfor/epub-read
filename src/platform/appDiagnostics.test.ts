import { describe, expect, it, vi } from "vitest";
import { copyAppDiagnostics, projectAppDiagnostics, type CopyAppDiagnosticsDependencies } from "./appDiagnostics";

const build = { version: "0.4.1", edition: "core", protocolVersion: 1, target: "x86_64-unknown-linux-gnu", profile: "release", debug: false };
const native = {
  schemaVersion: 1,
  build,
  platform: "linux",
  arch: "x86_64",
  distributionChannel: "unknown",
  runtime: { name: "WebKitGTK", version: "2.48.3" },
  linuxSession: { display: "wayland", source: "native", wsl: false },
  compatibilityMode: "unavailable",
};

function deps(overrides: Partial<CopyAppDiagnosticsDependencies> = {}) {
  return {
    isNativeHost: () => true,
    readNative: vi.fn(async () => native as unknown),
    writeText: vi.fn(async (_text: string) => {}),
    ...overrides,
  };
}

describe("copyAppDiagnostics", () => {
  it("copies only whitelisted fields, even when the backend returns more", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    const d = deps({
      writeText,
      readNative: vi.fn(async () => ({
        ...native,
        hostname: "my-pc",
        books: [{ title: "私人书名", path: "/home/me/书.epub" }],
        build: { ...build, userAgent: "Mozilla/5.0 Chrome/131" },
        runtime: { name: "WebKitGTK", version: "/home/me/lib", raw: "x" },
        arch: "x86_64 /home/me",
        linuxSession: { display: "wayland", source: "native", wsl: false, env: "WAYLAND_DISPLAY=wayland-0" },
      })),
    });
    expect(await copyAppDiagnostics(d)).toBe("copied");
    const text = writeText.mock.calls[0][0];
    expect(JSON.parse(text)).toEqual({
      ...native,
      arch: "unknown",
      runtime: { name: "WebKitGTK", version: null },
    });
    expect(text).toContain("\n  \"schemaVersion\": 1");
    for (const secret of ["my-pc", "私人书名", "/home/me", "Mozilla", "WAYLAND_DISPLAY"]) expect(text).not.toContain(secret);
  });

  it("collapses unknown enum values instead of copying them", () => {
    const projected = projectAppDiagnostics({ ...native, platform: "C:\\Users\\me", runtime: { name: "Chrome 131" }, compatibilityMode: "gpu-off" });
    expect(projected.platform).toBe("unknown");
    expect(projected.runtime).toEqual({ name: "unknown", version: null });
    expect(projected.compatibilityMode).toBe("unavailable");
  });

  it("reports unavailable without a native host and never calls the backend", async () => {
    const d = deps({ isNativeHost: () => false });
    expect(await copyAppDiagnostics(d)).toBe("unavailable");
    expect(d.readNative).not.toHaveBeenCalled();
    expect(d.writeText).not.toHaveBeenCalled();
  });

  it("keeps native errors and malformed payloads off the clipboard", async () => {
    const failed = deps({ readNative: vi.fn(async () => { throw new Error("Command app_diagnostics not found /home/me"); }) });
    expect(await copyAppDiagnostics(failed)).toBe("collect-failed");
    expect(failed.writeText).not.toHaveBeenCalled();

    const malformed = deps({ readNative: vi.fn(async () => ({ ...native, schemaVersion: 2 })) });
    expect(await copyAppDiagnostics(malformed)).toBe("collect-failed");
    expect(malformed.writeText).not.toHaveBeenCalled();
  });

  it("reports a refused clipboard as its own failure", async () => {
    const d = deps({ writeText: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) });
    expect(await copyAppDiagnostics(d)).toBe("clipboard-failed");
  });
});
