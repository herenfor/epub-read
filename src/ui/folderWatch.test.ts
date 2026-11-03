import { describe, expect, it, vi } from "vitest";
import { createFolderWatchController, type FolderWatchLast } from "./folderWatch";
import type { FolderWatchNative, FolderWatchResult } from "../platform/libraryFolderWatch";

const RESULT: FolderWatchResult = {
  scanned: 3, unchanged: 1, unreadableDirectories: 0,
  counts: { completed: 2, imported: 2, duplicates: 0, failed: 0, placementSkipped: 0, createdFolders: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function setup(enabled = true) {
  const scans: Array<ReturnType<typeof deferred<FolderWatchResult>>> = [];
  const native: FolderWatchNative = {
    get: vi.fn(async () => ({ enabled, directory: enabled ? "D:\\Books\\Inbox" : null })),
    configure: vi.fn(async () => ({ enabled: true, directory: "D:\\New" })),
    scan: vi.fn(() => { const next = deferred<FolderWatchResult>(); scans.push(next); return next.promise; }),
  };
  const controller = createFolderWatchController(native);
  const outcomes: Array<[FolderWatchLast, boolean]> = [];
  controller.onOutcome((outcome, manual) => outcomes.push([outcome, manual]));
  return { native, controller, scans, outcomes };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("automatic import folder", () => {
  it("scans on its own only through the gate, and only when enabled", async () => {
    const off = setup(false);
    await off.controller.ensure();
    off.controller.setGate(() => true);
    off.controller.trigger(true);
    expect(off.native.scan).not.toHaveBeenCalled();

    const { native, controller } = setup();
    await controller.ensure();
    controller.trigger();
    expect(native.scan).not.toHaveBeenCalled();
    controller.setGate(() => true);
    controller.trigger();
    expect(native.scan).toHaveBeenCalledTimes(1);
  });

  it("folds triggers during a scan into one more run", async () => {
    const { native, controller, scans, outcomes } = setup();
    await controller.ensure();
    controller.setGate(() => true);
    controller.trigger();
    controller.trigger();
    controller.trigger(true);
    expect(native.scan).toHaveBeenCalledTimes(1);
    scans[0].resolve(RESULT);
    await flush();
    expect(native.scan).toHaveBeenCalledTimes(2);
    scans[1].resolve(RESULT);
    await flush();
    expect(outcomes.map(([, manual]) => manual)).toEqual([false, true]);
    expect(controller.getView().scanning).toBe(false);
  });

  it("waits quietly when busy, but says so after a button press", async () => {
    const { controller, scans, outcomes } = setup();
    await controller.ensure();
    controller.setGate(() => true);
    controller.trigger();
    scans[0].reject("busy: 自动扫描操作正在进行");
    await flush();
    expect(outcomes).toEqual([]);
    expect(controller.getView().last).toBeNull();
    controller.trigger(true);
    scans[1].reject("busy: 自动扫描操作正在进行");
    await flush();
    expect(outcomes).toEqual([]);
    expect(controller.getView().last).toEqual({ kind: "busy" });
  });

  it("scans a newly chosen folder right away, and nothing after a cancelled picker", async () => {
    const { native, controller } = setup(false);
    await controller.ensure();
    vi.mocked(native.configure).mockResolvedValueOnce(null);
    await controller.configure("pick");
    expect(native.scan).not.toHaveBeenCalled();
    expect(controller.getView().settings).toEqual({ enabled: false, directory: null });
    await controller.configure("pick");
    expect(controller.getView().settings).toEqual({ enabled: true, directory: "D:\\New" });
    expect(native.scan).toHaveBeenCalledTimes(1);
  });

  it("reports a failed scan with its reason", async () => {
    const { controller, scans, outcomes } = setup();
    await controller.ensure();
    controller.setGate(() => true);
    controller.trigger();
    scans[0].reject(new Error("目录授权已撤销"));
    await flush();
    expect(outcomes).toEqual([[{ kind: "error", message: "目录授权已撤销" }, false]]);
  });
});
