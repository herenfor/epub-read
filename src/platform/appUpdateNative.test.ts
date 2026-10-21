import { describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { androidUpdater } from "./appUpdateNative";

describe("Android update commands", () => {
  it("serializes start and cancel, and keeps the command queue usable after failure", async () => {
    let finishStart!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStart = resolve; }));
    const start = androidUpdater.start({ url: "https://github.com/herenfor/epub-read/releases/download/v0.3.4/a.apk", sha256: "a".repeat(64), size: 1, version: "0.3.4" });
    const cancel = androidUpdater.cancel();
    await Promise.resolve();
    expect(invoke.mock.calls.map(([, args]) => args.action)).toEqual(["start"]);
    finishStart();
    await start;
    await cancel;
    expect(invoke.mock.calls.map(([, args]) => args.action)).toEqual(["start", "cancel"]);
    invoke.mockRejectedValueOnce(new Error("failed verification"));
    await expect(androidUpdater.verify()).rejects.toThrow("failed verification");
    invoke.mockResolvedValueOnce({ state: "idle" });
    await expect(androidUpdater.status()).resolves.toEqual({ state: "idle" });
  });
});
