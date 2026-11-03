import { useEffect, useRef, useSyncExternalStore } from "react";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import { watchAndroidForeground } from "../platform/androidAppTask";
import {
  folderWatchNative, isFolderWatchBusy,
  type FolderWatchAction, type FolderWatchNative, type FolderWatchResult, type FolderWatchSettings,
} from "../platform/libraryFolderWatch";

/**
 * ER-0042 automatic import folder. The native side owns the folder, its
 * permission and the incremental ledger; this keeps what the settings show
 * and decides when a scan runs: only while enabled, only from an idle shelf
 * in the foreground, one at a time, with triggers that arrive mid-scan
 * folded into one more run.
 */

export type FolderWatchLast =
  | { readonly kind: "result"; readonly result: FolderWatchResult }
  | { readonly kind: "busy" }
  | { readonly kind: "error"; readonly message: string };

export interface FolderWatchView {
  /** Null until the native settings have been read. */
  readonly settings: FolderWatchSettings | null;
  readonly scanning: boolean;
  readonly configuring: boolean;
  /** The last scan or configuration outcome the settings show. */
  readonly last: FolderWatchLast | null;
}

/** `manual`: started from the settings (立即扫描 or a new folder), so it reports even when nothing changed. */
export type FolderWatchListener = (outcome: FolderWatchLast, manual: boolean) => void;

/** A shelf that is idle and in the foreground; outside it no scan starts on its own. */
export const FOLDER_WATCH_INTERVAL_MS = 60_000;

function errorText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : String(error);
}

export function createFolderWatchController(native: FolderWatchNative) {
  let view: FolderWatchView = { settings: null, scanning: false, configuring: false, last: null };
  let loading: Promise<void> | null = null;
  let gate: () => boolean = () => false;
  let pending: { manual: boolean } | null = null;
  const views = new Set<() => void>();
  const outcomes = new Set<FolderWatchListener>();

  const publish = (next: Partial<FolderWatchView>): void => {
    view = { ...view, ...next };
    for (const listener of [...views]) listener();
  };
  const report = (last: FolderWatchLast, manual: boolean): void => {
    publish({ last });
    for (const listener of [...outcomes]) listener(last, manual);
  };

  const run = async (manual: boolean): Promise<void> => {
    publish({ scanning: true });
    try {
      report({ kind: "result", result: await native.scan() }, manual);
    } catch (error) {
      // Busy waits quietly for the next trigger; a button press still says why nothing ran.
      if (!isFolderWatchBusy(error)) report({ kind: "error", message: errorText(error) }, manual);
      else if (manual) publish({ last: { kind: "busy" } });
    } finally {
      publish({ scanning: false });
      const next = pending;
      pending = null;
      if (next) trigger(next.manual);
    }
  };

  /** Automatic triggers pass the gate; a manual one only needs the folder enabled. */
  const trigger = (manual = false): void => {
    if (!view.settings?.enabled || view.configuring) return;
    if (!manual && !gate()) return;
    if (view.scanning) {
      pending = { manual: manual || (pending?.manual ?? false) };
      return;
    }
    void run(manual);
  };

  return {
    getView: () => view,
    subscribe(listener: () => void): () => void {
      views.add(listener);
      return () => { views.delete(listener); };
    },
    onOutcome(listener: FolderWatchListener): () => void {
      outcomes.add(listener);
      return () => { outcomes.delete(listener); };
    },
    setGate(next: () => boolean): void { gate = next; },
    /** Reads the settings once; a failed read shows as an error and is retried on the next call. */
    ensure(): Promise<void> {
      if (view.settings) return Promise.resolve();
      loading ??= native.get()
        .then((settings) => publish({ settings }), (error: unknown) => publish({ last: { kind: "error", message: errorText(error) } }))
        .finally(() => { loading = null; });
      return loading;
    },
    trigger,
    async configure(action: FolderWatchAction): Promise<void> {
      if (view.configuring || view.scanning) return;
      publish({ configuring: true });
      let chosen = false;
      try {
        const settings = await native.configure(action);
        // Cancelling the picker keeps the folder that was there.
        if (settings) publish({ settings, last: null });
        chosen = settings?.enabled === true;
      } catch (error) {
        report({ kind: "error", message: errorText(error) }, true);
      } finally {
        publish({ configuring: false });
      }
      // A newly chosen folder is scanned right away, as if 立即扫描 were pressed.
      if (chosen) trigger(true);
    },
  };
}

export type FolderWatchController = ReturnType<typeof createFolderWatchController>;

export function folderWatchSupported(): boolean {
  return getRuntimeCapabilities().supportsFolderWatch;
}

let shared: FolderWatchController | null = null;
export function folderWatch(): FolderWatchController {
  shared ??= createFolderWatchController(folderWatchNative);
  return shared;
}

const EMPTY_VIEW: FolderWatchView = { settings: null, scanning: false, configuring: false, last: null };
const noSubscribe = () => () => undefined;

/** The settings card's view; null where the platform has no watched folder. */
export function useFolderWatchView(): FolderWatchView | null {
  const supported = folderWatchSupported();
  const controller = supported ? folderWatch() : null;
  const current = useSyncExternalStore(controller?.subscribe ?? noSubscribe, () => controller?.getView() ?? EMPTY_VIEW);
  useEffect(() => { void controller?.ensure(); }, [controller]);
  return controller ? current : null;
}

/**
 * Starts automatic scans while `active` (the shelf, idle): when it becomes
 * active, when the app returns to the foreground, and every minute while it
 * stays so. Nothing runs in the reader, in the background or in a browser.
 */
export function useFolderWatchTriggers(active: boolean, onOutcome: FolderWatchListener): void {
  const listener = useRef(onOutcome);
  listener.current = onOutcome;
  const supported = folderWatchSupported();
  useEffect(() => {
    if (!supported) return;
    return folderWatch().onOutcome((outcome, manual) => listener.current(outcome, manual));
  }, [supported]);
  useEffect(() => {
    if (!supported || !active) return;
    const controller = folderWatch();
    const android = getRuntimeCapabilities().platform === "android";
    // Android waits for the Activity's own answer; desktop windows only have page visibility.
    let foreground = !android;
    controller.setGate(() => foreground && !document.hidden);
    const kick = () => controller.trigger();
    void controller.ensure().then(kick);
    const onVisibility = () => { if (!document.hidden) kick(); };
    document.addEventListener("visibilitychange", onVisibility);
    const unwatch = android ? watchAndroidForeground((next) => {
      const returned = next && !foreground;
      foreground = next;
      if (returned) kick();
    }) : undefined;
    const timer = window.setInterval(kick, FOLDER_WATCH_INTERVAL_MS);
    return () => {
      controller.setGate(() => false);
      document.removeEventListener("visibilitychange", onVisibility);
      unwatch?.();
      window.clearInterval(timer);
    };
  }, [active, supported]);
}
