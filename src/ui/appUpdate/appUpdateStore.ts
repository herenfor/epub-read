import { useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  launchNotice,
  noticeFor,
  parseLatestRelease,
  recordCheck,
  shouldAutoCheck,
  type InstallKind,
  type LatestRelease,
  type UpdateAsset,
  type UpdateState,
} from "../../config/appUpdate";
import { APP_UPDATE_SOURCE } from "../../config/appUpdateSource";
import { APP_VERSION } from "../../config/appVersion";
import { getAppBuildSession } from "../../config/appBuildSession";
import { RELEASES_PAGE_URL } from "../../config/releaseNotes";
import {
  androidUpdater,
  checkWindowsUpdate,
  readInstallKind,
  type WindowsUpdate,
} from "../../platform/appUpdateNative";

/**
 * App update: one store shared by the About card, the settings toggle and
 * the red dots. Checking talks only to GitHub's anonymous release API;
 * downloading and installing always wait for the user's tap.
 */

const STORAGE_KEY = "epub-reader:app-update-v1";
const FIRST_CHECK_DELAY_MS = 10_000;
const RECHECK_INTERVAL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const ANDROID_POLL_MS = 700;

export type UpdateFailure =
  /** The plugin's signed manifest is missing or names another version. */
  | "unavailable"
  | "download"
  /** Android: digest, package, certificate or version check refused the file. */
  | "verify"
  /** Progress or notes could not be saved; nothing was installed. */
  | "save"
  | "install";

export type UpdateFlow =
  | { step: "idle" }
  | { step: "downloading"; received: number; total: number | null }
  | { step: "needsPermission" }
  | { step: "ready" }
  | { step: "installing" }
  | { step: "failed"; reason: UpdateFailure };

export interface AppUpdateView {
  /** Null until the native side answered. */
  kind: InstallKind | null;
  currentVersion: string;
  autoCheck: boolean;
  lastSuccessAt?: number;
  checking: boolean;
  /** Result of the last manual check, shown under the button until the next one. */
  manualResult: "latest" | "failed" | null;
  release: LatestRelease | null;
  /** The file this copy would download; null means "open the release page". */
  asset: UpdateAsset | null;
  flow: UpdateFlow;
}

/* ---- Stored state: validated at the boundary, defaults on anything odd ---- */

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** Re-runs the release parser on the cached copy, so a tampered cache cannot point anywhere new. */
function readCachedLatest(value: unknown): UpdateState["cachedLatest"] {
  if (!value || typeof value !== "object") return undefined;
  const cached = value as Record<string, unknown>;
  const fetchedAt = optionalNumber(cached.fetchedAt);
  if (fetchedAt === undefined || !Array.isArray(cached.assets)) return undefined;
  const release = parseLatestRelease({
    draft: false,
    prerelease: false,
    tag_name: cached.tag,
    published_at: cached.publishedAt,
    html_url: cached.htmlUrl,
    body: cached.important === true ? "<!-- epub-reader:update important -->" : null,
    assets: cached.assets.map((raw) => {
      const asset = (raw ?? {}) as Record<string, unknown>;
      return {
        name: asset.name,
        size: asset.size,
        browser_download_url: asset.url,
        digest: typeof asset.sha256 === "string" ? `sha256:${asset.sha256}` : null,
      };
    }),
  });
  if (!release || release.version !== cached.version) return undefined;
  return { ...release, fetchedAt };
}

export function readStoredUpdateState(raw: string | null): UpdateState {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { autoCheck: true };
    input = parsed as Record<string, unknown>;
  } catch {
    return { autoCheck: true };
  }
  const state: UpdateState = { autoCheck: input.autoCheck !== false };
  const lastSuccessAt = optionalNumber(input.lastSuccessAt);
  const lastFailureAt = optionalNumber(input.lastFailureAt);
  const failureCount = optionalNumber(input.failureCount);
  const skippedVersion = optionalString(input.skippedVersion);
  const lastLaunchedVersion = optionalString(input.lastLaunchedVersion);
  const cachedLatest = readCachedLatest(input.cachedLatest);
  if (lastSuccessAt !== undefined) state.lastSuccessAt = lastSuccessAt;
  if (lastFailureAt !== undefined) state.lastFailureAt = lastFailureAt;
  if (failureCount !== undefined) state.failureCount = failureCount;
  if (skippedVersion) state.skippedVersion = skippedVersion;
  if (lastLaunchedVersion) state.lastLaunchedVersion = lastLaunchedVersion;
  if (cachedLatest) state.cachedLatest = cachedLatest;
  return state;
}

function loadState(): UpdateState {
  try {
    return readStoredUpdateState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { autoCheck: true };
  }
}

function saveState(state: UpdateState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Storage unavailable: this run still works from memory. */
  }
}

/* ---- Store ---- */

function currentVersion(): string {
  return getAppBuildSession()?.buildInfo?.version ?? APP_VERSION;
}

let stored: UpdateState = { autoCheck: true };
let kind: InstallKind | null = null;
let checking = false;
let manualResult: AppUpdateView["manualResult"] = null;
let flow: UpdateFlow = { step: "idle" };
/** Bumped on abandon, so a late download or poll from the old attempt does nothing. */
let attempt = 0;
let windowsUpdate: WindowsUpdate | null = null;
let saveGate: (() => Promise<void>) | null = null;
let isReading: () => boolean = () => false;
let started = false;

const listeners = new Set<() => void>();
let view: AppUpdateView = buildView();

function buildView(): AppUpdateView {
  const version = currentVersion();
  const notice = kind === null ? { kind: "none" as const } : noticeFor(stored, version, kind);
  return {
    kind,
    currentVersion: version,
    autoCheck: stored.autoCheck,
    lastSuccessAt: stored.lastSuccessAt,
    checking,
    manualResult,
    release: notice.kind === "available" ? notice.release : null,
    asset: notice.kind === "available" ? notice.asset : null,
    flow,
  };
}

function publish(): void {
  view = buildView();
  for (const listener of listeners) listener();
}

function setStored(next: UpdateState): void {
  stored = next;
  saveState(next);
}

function setFlow(next: UpdateFlow): void {
  flow = next;
  publish();
}

async function fetchLatest(): Promise<LatestRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(APP_UPDATE_SOURCE.checkUrl, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseLatestRelease(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(manual: boolean): Promise<void> {
  if (checking) return;
  checking = true;
  if (manual) manualResult = null;
  publish();
  const release = await fetchLatest();
  checking = false;
  setStored(recordCheck(stored, Date.now(), release ?? "failed"));
  if (manual) {
    manualResult = !release ? "failed" : noticeFor(stored, currentVersion(), kind ?? "unsupported").kind === "available" ? null : "latest";
  }
  publish();
}

function maybeAutoCheck(): void {
  if (kind === null || isReading() || checking) return;
  if (shouldAutoCheck(stored, Date.now(), kind)) void runCheck(false);
}

/**
 * Starts the background part once per app run: reads the install kind,
 * records the launched version, clears finished Android downloads and checks
 * about 10 s later (then re-evaluates every 10 min; no request while reading).
 * Returns the running version when this is the first launch after an update.
 */
export function startAppUpdates(options: { isReading(): boolean }): string | null {
  isReading = options.isReading;
  if (started) return null;
  started = true;
  stored = loadState();
  const launch = launchNotice(stored, currentVersion());
  setStored(launch.next);
  publish();
  void readInstallKind().then((value) => {
    kind = value;
    publish();
    if (value === "android") void androidUpdater.cleanup().catch(() => undefined);
    setTimeout(maybeAutoCheck, FIRST_CHECK_DELAY_MS);
    setInterval(maybeAutoCheck, RECHECK_INTERVAL_MS);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && flow.step === "needsPermission") void recheckInstallPermission();
  });
  return launch.show ? currentVersion() : null;
}

/** App registers its full save (progress, notes, settings); installing waits for it. */
export function registerAppUpdateSaveGate(gate: (() => Promise<void>) | null): void {
  saveGate = gate;
}

export function checkForUpdatesNow(): Promise<void> {
  return runCheck(true);
}

export function setAutoCheckUpdates(enabled: boolean): void {
  setStored({ ...stored, autoCheck: enabled });
  publish();
}

export function skipUpdateVersion(version: string): void {
  abandonUpdate();
  setStored({ ...stored, skippedVersion: version });
  publish();
}

export function openExternalPage(url: string = RELEASES_PAGE_URL): void {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void openUrl(url).catch(() => undefined);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Gives up the current download or prepared update; a late result is discarded. */
export function abandonUpdate(): void {
  attempt += 1;
  const handle = windowsUpdate;
  windowsUpdate = null;
  void handle?.close();
  if (kind === "android" && (flow.step === "downloading" || flow.step === "ready" || flow.step === "needsPermission")) {
    void androidUpdater.cancel().catch(() => undefined);
  }
  if (flow.step !== "idle") setFlow({ step: "idle" });
}

export async function startUpdateDownload(): Promise<void> {
  const { release, asset } = view;
  if (!release || flow.step === "downloading" || flow.step === "installing") return;
  abandonUpdate();
  const mine = attempt;
  const current = () => mine === attempt;
  setFlow({ step: "downloading", received: 0, total: asset?.size ?? null });
  if (kind === "installer") {
    let handle: WindowsUpdate | null = null;
    try {
      handle = await checkWindowsUpdate();
    } catch {
      handle = null;
    }
    if (!current()) { void handle?.close(); return; }
    if (!handle || handle.version !== release.version) {
      void handle?.close();
      setFlow({ step: "failed", reason: "unavailable" });
      return;
    }
    windowsUpdate = handle;
    try {
      await handle.download((received, total) => {
        if (current()) setFlow({ step: "downloading", received, total: total ?? asset?.size ?? null });
      });
    } catch {
      if (current()) {
        windowsUpdate = null;
        void handle.close();
        setFlow({ step: "failed", reason: "download" });
      }
      return;
    }
    if (current()) setFlow({ step: "ready" });
    return;
  }
  if (kind === "android" && asset?.sha256) {
    try {
      await androidUpdater.start({ url: asset.url, sha256: asset.sha256, size: asset.size, version: release.version });
    } catch {
      if (current()) setFlow({ step: "failed", reason: "download" });
      return;
    }
    await pollAndroidDownload(current);
    return;
  }
  setFlow({ step: "idle" });
  openExternalPage(release.htmlUrl);
}

async function pollAndroidDownload(current: () => boolean): Promise<void> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, ANDROID_POLL_MS));
    if (!current()) return;
    let status;
    try {
      status = await androidUpdater.status();
    } catch {
      if (current()) setFlow({ step: "failed", reason: "download" });
      return;
    }
    if (!current()) return;
    if (status.state === "running" || status.state === "idle") {
      setFlow({ step: "downloading", received: status.received, total: status.total });
      continue;
    }
    if (status.state === "failed") {
      setFlow({ step: "failed", reason: "download" });
      return;
    }
    break;
  }
  let verified;
  try {
    verified = await androidUpdater.verify();
  } catch {
    verified = { ok: false };
  }
  if (!current()) return;
  if (!verified.ok) {
    setFlow({ step: "failed", reason: "verify" });
    return;
  }
  await recheckInstallPermission();
}

async function recheckInstallPermission(): Promise<void> {
  const mine = attempt;
  let permission: Awaited<ReturnType<typeof androidUpdater.canInstall>>;
  try {
    permission = await androidUpdater.canInstall();
  } catch {
    permission = "unknown";
  }
  if (mine !== attempt) return;
  setFlow(permission === "denied" ? { step: "needsPermission" } : { step: "ready" });
}

export function openInstallPermission(): void {
  void androidUpdater.openInstallPermission().catch(() => undefined);
}

/**
 * Saves everything first; the Windows installer ends this process and the
 * Android system installer replaces it. A failed save installs nothing.
 */
export async function installUpdate(): Promise<void> {
  if (flow.step !== "ready") return;
  const mine = attempt;
  setFlow({ step: "installing" });
  try {
    await saveGate?.();
  } catch {
    if (mine === attempt) setFlow({ step: "failed", reason: "save" });
    return;
  }
  if (mine !== attempt) return;
  try {
    if (kind === "installer") {
      if (!windowsUpdate) throw new Error("not downloaded");
      await windowsUpdate.install();
    } else if (kind === "android") {
      await androidUpdater.install();
      // The system dialog may be cancelled; the verified file stays ready.
      if (mine === attempt) setFlow({ step: "ready" });
    }
  } catch {
    if (mine === attempt) setFlow({ step: "failed", reason: "install" });
  }
}

export function useAppUpdate(): AppUpdateView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => view,
    () => view,
  );
}

/** True while a newer, not-skipped version is waiting: drives the settings red dots. */
export function useAppUpdateDot(): boolean {
  return useAppUpdate().release !== null;
}
