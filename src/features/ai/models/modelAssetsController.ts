import { useEffect, useMemo, useState } from "react";
import {
  createTauriModelAssetPort,
  type ModelLibraryPathSetting,
  type ModelPackageRecord,
  type ModelAssetPort,
} from "./modelAssets";
import {
  createTauriModelDownloadPort,
  type ModelDownloadPort,
  type ModelDownloadTask,
} from "./modelDownloads";

export interface ModelAssetsDevelopmentState {
  supported: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  library: ModelLibraryPathSetting | null;
  packages: ModelPackageRecord[];
  tasks: ModelDownloadTask[];
}

export interface ModelAssetsDevelopmentPorts {
  assets: ModelAssetPort;
  downloads: ModelDownloadPort;
}

export const ACTIVE_MODEL_DOWNLOAD_STATES = new Set(["queued", "downloading", "verifying"]);

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createModelAssetsDevelopmentController(
  ports: ModelAssetsDevelopmentPorts,
  onState: (state: ModelAssetsDevelopmentState) => void,
  intervalMs = 1000,
) {
  let disposed = false;
  let generation = 0;
  let inFlight = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let hadActiveTasks = false;
  let state: ModelAssetsDevelopmentState = {
    supported: true,
    loading: false,
    busy: false,
    error: null,
    library: null,
    packages: [],
    tasks: [],
  };
  const publish = (patch: Partial<ModelAssetsDevelopmentState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    onState(state);
  };
  const hasActiveTasks = (tasks: ModelDownloadTask[]) =>
    tasks.some((task) => ACTIVE_MODEL_DOWNLOAD_STATES.has(task.state));
  const stopPolling = () => {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  };
  const refreshPackages = async (token: number) => {
    const packages = await ports.assets.listPackages();
    if (!disposed && token === generation) publish({ packages });
  };
  const poll = async () => {
    if (disposed || inFlight || state.busy) return;
    const token = generation;
    inFlight = true;
    try {
      const tasks = await ports.downloads.list();
      if (disposed || token !== generation) return;
      const active = hasActiveTasks(tasks);
      publish({ tasks });
      if (hadActiveTasks && !active) await refreshPackages(token);
      hadActiveTasks = active;
      if (!active) stopPolling();
    } catch (error) {
      if (!disposed && token === generation) publish({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (token === generation) inFlight = false;
    }
  };
  const syncPolling = (tasks: ModelDownloadTask[]) => {
    const active = hasActiveTasks(tasks);
    hadActiveTasks = active;
    if (active && pollTimer === null) pollTimer = setInterval(() => void poll(), intervalMs);
    if (!active) stopPolling();
  };
  const start = async () => {
    // React development StrictMode runs effect setup -> cleanup -> setup while
    // preserving memoized values. Reactivating here gives the second setup a
    // fresh generation while every promise from the disposed setup stays stale.
    if (disposed) {
      disposed = false;
      inFlight = false;
      state = { ...state, loading: false, busy: false };
    }
    if (inFlight || state.busy) return;
    const token = ++generation;
    inFlight = true;
    publish({ loading: true, busy: true, error: null });
    try {
      const [library, packages, tasks] = await Promise.all([
        ports.assets.getLibraryPath(),
        ports.assets.listPackages(),
        ports.downloads.list(),
      ]);
      if (disposed || token !== generation) return;
      publish({ loading: false, busy: false, library, packages, tasks });
      syncPolling(tasks);
    } catch (error) {
      if (!disposed && token === generation) publish({ loading: false, busy: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (token === generation) inFlight = false;
      if (!disposed && token === generation && state.busy) publish({ busy: false });
    }
  };
  const run = async (operation: () => Promise<void>) => {
    if (disposed || inFlight || state.busy) return;
    const token = ++generation;
    inFlight = true;
    publish({ busy: true, error: null });
    try {
      await operation();
      if (disposed || token !== generation) return;
      const [packages, tasks] = await Promise.all([ports.assets.listPackages(), ports.downloads.list()]);
      if (disposed || token !== generation) return;
      publish({ packages, tasks });
      syncPolling(tasks);
    } catch (error) {
      if (!disposed && token === generation) publish({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (token === generation) inFlight = false;
      if (!disposed && token === generation) publish({ busy: false });
    }
  };
  return {
    start,
    state: () => state,
    setLibraryPath: (path: string) => run(async () => { await ports.assets.setLibraryPath(path); }),
    registerLinked: (path: string) => run(async () => { await ports.assets.registerLinkedPackage(path); }),
    relocate: (packageId: string, path: string) => run(async () => { await ports.assets.relocatePackage(packageId, path); }),
    verify: (packageId: string) => run(async () => { await ports.assets.verifyPackage(packageId); }),
    remove: (packageId: string, deleteManagedFiles: boolean) => run(async () => { await ports.assets.removePackage(packageId, deleteManagedFiles); }),
    registerDevelopmentCatalog: () => run(async () => { await ports.assets.registerDevelopmentCatalog(); }),
    acceptLicense: (packageId: string) => run(async () => { await ports.downloads.acceptLicense(packageId); }),
    acceptLicenseAndEnqueue: (packageId: string) => run(async () => {
      await ports.downloads.acceptLicense(packageId);
      await ports.downloads.enqueue(packageId);
    }),
    enqueue: (packageId: string) => run(async () => { await ports.downloads.enqueue(packageId); }),
    pause: (taskId: string) => run(async () => { await ports.downloads.pause(taskId); }),
    resume: (taskId: string) => run(async () => { await ports.downloads.resume(taskId); }),
    cancel: (taskId: string) => run(async () => { await ports.downloads.cancel(taskId); }),
    dispose: () => { disposed = true; generation++; stopPolling(); },
  };
}

export function useModelAssetsDevelopmentController(): [ModelAssetsDevelopmentState, ReturnType<typeof createModelAssetsDevelopmentController>] {
  const ports = useMemo<ModelAssetsDevelopmentPorts | null>(() => {
    if (!isTauriEnvironment()) return null;
    return { assets: createTauriModelAssetPort(), downloads: createTauriModelDownloadPort() };
  }, []);
  const [state, setState] = useState<ModelAssetsDevelopmentState>(() => ({
    supported: ports !== null,
    loading: false,
    busy: false,
    error: null,
    library: null,
    packages: [],
    tasks: [],
  }));
  const controller = useMemo(() => createModelAssetsDevelopmentController(
    ports ?? { assets: createTauriModelAssetPort(), downloads: createTauriModelDownloadPort() },
    setState,
  ), [ports]);
  useEffect(() => {
    if (ports) void controller.start();
    return () => controller.dispose();
  }, [controller]);
  return [state, controller];
}
