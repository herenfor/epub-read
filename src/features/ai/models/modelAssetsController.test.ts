import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelAssetsDevelopmentController, isTauriEnvironment, type ModelAssetsDevelopmentState } from "./modelAssetsController";
import type { ModelAssetPort, ModelPackageRecord } from "./modelAssets";
import type { ModelDownloadPort, ModelDownloadTask } from "./modelDownloads";

const pkg = { packageId: "probe", state: "installed", storageKind: "managed", capabilities: ["embedding"], files: [], license: "Apache-2.0" } as unknown as ModelPackageRecord;
const task = (state: ModelDownloadTask["state"]): ModelDownloadTask => ({
  id: "task", packageId: "probe", state, bytesDownloaded: 0, totalBytes: 1,
  currentFilePath: null, currentFileIndex: null, packageTotalBytes: 1,
  currentSourceUrl: null, sourceIndex: null, error: null, startedAtMs: null,
  completedAtMs: null, createdAtMs: 1, updatedAtMs: 1,
});

function fakePorts(tasks: ModelDownloadTask[] = []): ModelAssetsDevelopmentPortsLike {
  const calls: string[] = [];
  let currentTasks = tasks;
  const assets = {
    getLibraryPath: async () => { calls.push("library"); return { path: null, exists: false, isDirectory: false }; },
    setLibraryPath: async () => ({ path: null, exists: false, isDirectory: false }),
    scan: async () => {
      calls.push("scan");
      return {
        root: { path: null, exists: false, isDirectory: false },
        packages: [],
        defaultPackageId: null,
        scanError: null,
      };
    },
    listPackages: async () => { calls.push("packages"); return [pkg]; },
    registerPackage: async () => pkg,
    registerLinkedPackage: async () => pkg,
    relocatePackage: async () => pkg,
    removePackage: async () => undefined,
    registerDevelopmentCatalog: async () => pkg,
    verifyPackage: async () => pkg,
  } as unknown as ModelAssetPort;
  const downloads = {
    enqueue: async () => { calls.push("enqueue"); return { task: currentTasks[0] ?? task("queued"), existing: false }; },
    list: async () => { calls.push("tasks"); return currentTasks; },
    pause: async () => task("paused"), resume: async () => task("queued"), cancel: async () => task("cancelled"),
    acceptLicense: async () => { calls.push("accept"); },
  } as unknown as ModelDownloadPort;
  return { ports: { assets, downloads }, calls, setTasks: (next: ModelDownloadTask[]) => { currentTasks = next; } };
}

interface ModelAssetsDevelopmentPortsLike {
  ports: { assets: ModelAssetPort; downloads: ModelDownloadPort };
  calls: string[];
  setTasks(next: ModelDownloadTask[]): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("model assets development controller", () => {
  afterEach(() => vi.useRealTimers());

  it("initializes with only library, package list and download list", async () => {
    const fake = fakePorts();
    const states: unknown[] = [];
    const controller = createModelAssetsDevelopmentController(fake.ports, (state) => states.push(state));
    await controller.start();
    expect(fake.calls).toEqual(["library", "packages", "tasks"]);
    expect(fake.calls).not.toContain("scan");
    controller.dispose();
  });

  it("polls active tasks and refreshes packages once after completion, but not paused tasks", async () => {
    vi.useFakeTimers();
    const fake = fakePorts([task("downloading")]);
    const controller = createModelAssetsDevelopmentController(fake.ports, () => undefined, 1000);
    await controller.start();
    fake.setTasks([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls.filter((call) => call === "tasks")).toHaveLength(2);
    expect(fake.calls.filter((call) => call === "packages")).toHaveLength(2);
    const paused = fakePorts([task("paused")]);
    const pausedController = createModelAssetsDevelopmentController(paused.ports, () => undefined, 1000);
    await pausedController.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(paused.calls.filter((call) => call === "tasks")).toHaveLength(1);
    controller.dispose();
    pausedController.dispose();
  });

  it("treats browser mode without Tauri internals as unsupported", () => {
    expect(isTauriEnvironment()).toBe(false);
  });

  it("restarts safely after StrictMode cleanup and ignores the disposed generation", async () => {
    const firstLibrary = deferred<{ path: string | null; exists: boolean; isDirectory: boolean }>();
    const secondLibrary = deferred<{ path: string | null; exists: boolean; isDirectory: boolean }>();
    const firstPackages = deferred<ModelPackageRecord[]>();
    const secondPackages = deferred<ModelPackageRecord[]>();
    const firstTasks = deferred<ModelDownloadTask[]>();
    const secondTasks = deferred<ModelDownloadTask[]>();
    const libraryReads = [firstLibrary.promise, secondLibrary.promise];
    const packageReads = [firstPackages.promise, secondPackages.promise];
    const taskReads = [firstTasks.promise, secondTasks.promise];
    const ports = {
      assets: {
        getLibraryPath: vi.fn(() => libraryReads.shift()!),
        listPackages: vi.fn(() => packageReads.shift()!),
      } as unknown as ModelAssetPort,
      downloads: {
        list: vi.fn(() => taskReads.shift()!),
      } as unknown as ModelDownloadPort,
    };
    const states: ModelAssetsDevelopmentState[] = [];
    const controller = createModelAssetsDevelopmentController(ports, (state) => states.push(state));

    const disposedStart = controller.start();
    controller.dispose();
    const activeStart = controller.start();
    secondLibrary.resolve({ path: "D:/models/new", exists: true, isDirectory: true });
    secondPackages.resolve([pkg]);
    secondTasks.resolve([]);
    await activeStart;
    expect(controller.state()).toMatchObject({ loading: false, busy: false, library: { path: "D:/models/new" } });

    firstLibrary.resolve({ path: "D:/models/stale", exists: true, isDirectory: true });
    firstPackages.resolve([]);
    firstTasks.resolve([task("downloading")]);
    await disposedStart;
    expect(controller.state()).toMatchObject({ loading: false, busy: false, library: { path: "D:/models/new" }, packages: [pkg], tasks: [] });
    expect(ports.assets.getLibraryPath).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("allows only one action while busy and clears busy after the late response", async () => {
    const fake = fakePorts();
    let release!: () => void;
    const operation = vi.fn(() => new Promise<void>((resolve) => { release = () => resolve(); }));
    fake.ports.downloads.enqueue = operation as unknown as ModelDownloadPort["enqueue"];
    const states: ModelAssetsDevelopmentState[] = [];
    const controller = createModelAssetsDevelopmentController(fake.ports, (state) => states.push(state));
    const first = controller.enqueue("probe");
    const second = controller.enqueue("probe");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.busy).toBe(true);
    release();
    await first;
    await second;
    expect(states.at(-1)?.busy).toBe(false);
    controller.dispose();
  });

  it("refreshes metadata by scanning the library first, then re-listing packages", async () => {
    const fake = fakePorts();
    const controller = createModelAssetsDevelopmentController(fake.ports, () => undefined);
    await controller.refresh();
    expect(fake.calls).toEqual(["scan", "packages", "tasks"]);
    controller.dispose();
  });

  it("surfaces a scan failure instead of showing a stale package list", async () => {
    const fake = fakePorts();
    fake.ports.assets.scan = vi.fn(async () => {
      throw new Error("模型库目录不可写");
    }) as unknown as ModelAssetPort["scan"];
    const states: ModelAssetsDevelopmentState[] = [];
    const controller = createModelAssetsDevelopmentController(fake.ports, (state) => states.push(state));
    await controller.refresh();
    expect(states.at(-1)?.error).toBe("模型库目录不可写");
    expect(states.at(-1)?.busy).toBe(false);
    controller.dispose();
  });

  it("reports a backend scan error carried inside a successful response", async () => {
    const fake = fakePorts();
    fake.ports.assets.scan = vi.fn(async () => ({
      root: { path: "D:/models", exists: true, isDirectory: true },
      packages: [],
      defaultPackageId: null,
      scanError: "模型库路径不是目录",
    })) as unknown as ModelAssetPort["scan"];
    const states: ModelAssetsDevelopmentState[] = [];
    const controller = createModelAssetsDevelopmentController(fake.ports, (state) => states.push(state));
    await controller.refresh();
    expect(states.at(-1)?.error).toBe("模型库路径不是目录");
    controller.dispose();
  });

  it("accepts the license before enqueueing, and never enqueues when acceptance fails", async () => {
    const success = fakePorts();
    const successController = createModelAssetsDevelopmentController(success.ports, () => undefined);
    await successController.acceptLicenseAndEnqueue("probe");
    expect(success.calls.slice(0, 2)).toEqual(["accept", "enqueue"]);
    successController.dispose();

    const failure = fakePorts();
    const enqueue = vi.fn(failure.ports.downloads.enqueue);
    failure.ports.downloads.acceptLicense = vi.fn(async () => { throw new Error("license rejected"); });
    failure.ports.downloads.enqueue = enqueue;
    const failureController = createModelAssetsDevelopmentController(failure.ports, () => undefined);
    await failureController.acceptLicenseAndEnqueue("probe");
    expect(enqueue).not.toHaveBeenCalled();
    failureController.dispose();
  });
});
