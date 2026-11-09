import { useSyncExternalStore } from "react";
import { asCloudSyncFailure, type CloudSyncFailure } from "../../platform/cloudSyncNative";
import {
  cloudBookUploadNative,
  type CloudBookUploadPreview,
  type CloudBookUploadProgress,
  type CloudBookUploadResult,
} from "../../platform/cloudBookUploadNative";

/**
 * ER-0151: one manual original-book upload at a time. The backend reads,
 * hashes, deduplicates and publishes; this store only shows what it reports.
 * Every progress event and result is owned by its jobId: a late one from an
 * older job never touches the current panel. Nothing here retries, polls or
 * reads book files.
 */

export type CloudBookUploadPanel =
  | { kind: "closed" }
  /** Preview loading (preview and failure both null), ready, or failed. */
  | { kind: "confirm"; hashes: string[]; preview: CloudBookUploadPreview | null; failure: CloudSyncFailure | null }
  | {
    kind: "running";
    jobId: string;
    /** Titles from the preview, for the current book's name. */
    titles: ReadonlyMap<string, string>;
    count: number;
    progress: CloudBookUploadProgress | null;
    canceling: boolean;
  }
  /** A job started before this page loaded: no live progress or result reaches it. */
  | { kind: "detached"; jobId: string; progress: CloudBookUploadProgress | null; canceling: boolean; ended: boolean }
  | { kind: "result"; result: CloudBookUploadResult }
  /** The upload command itself was refused (no connection, busy, bridge gone). */
  | { kind: "failed"; failure: CloudSyncFailure };

export interface CloudBookUploadView {
  panel: CloudBookUploadPanel;
  /** The panel is collapsed to the small floating card (running or finished). */
  collapsed: boolean;
  /** This run of the app's last finished result, for the settings row. Memory only. */
  last: CloudBookUploadResult | null;
  /** cloud_book_upload_current could not be read: the state is unknown, not idle. */
  currentUnknown: boolean;
}

const INITIAL: CloudBookUploadView = { panel: { kind: "closed" }, collapsed: false, last: null, currentUnknown: false };
let view: CloudBookUploadView = INITIAL;
const listeners = new Set<() => void>();
let previewToken = 0;
let recovered = false;

function publish(next: Partial<CloudBookUploadView>): void {
  view = { ...view, ...next };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): CloudBookUploadView {
  return view;
}

export function useCloudBookUpload(): CloudBookUploadView {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function cloudBookUploadView(): CloudBookUploadView {
  return view;
}

/** A job is in flight (or may be): new uploads wait for it. */
export function cloudBookUploadBusy(state: CloudBookUploadView = view): boolean {
  return state.panel.kind === "running" || (state.panel.kind === "detached" && !state.panel.ended);
}

function newJobId(): string {
  return crypto.randomUUID();
}

/** Opens the confirm panel for these books and reads the offline preview. */
export function requestCloudBookUpload(hashes: string[]): void {
  const unique = [...new Set(hashes.filter((hash) => hash !== ""))];
  if (unique.length === 0) return;
  if (cloudBookUploadBusy()) {
    // The entry is disabled while busy; a stray request just shows the job.
    publish({ collapsed: false });
    return;
  }
  const token = ++previewToken;
  publish({ panel: { kind: "confirm", hashes: unique, preview: null, failure: null }, collapsed: false });
  void cloudBookUploadNative.preview(unique).then(
    (preview) => {
      if (token !== previewToken || view.panel.kind !== "confirm") return;
      publish({ panel: { ...view.panel, preview, failure: null } });
    },
    (error: unknown) => {
      if (token !== previewToken || view.panel.kind !== "confirm") return;
      publish({ panel: { ...view.panel, preview: null, failure: asCloudSyncFailure(error) } });
    },
  );
}

/** The books the confirm panel would send: only those the snapshot can upload. */
export function readyHashes(preview: CloudBookUploadPreview): string[] {
  return preview.books.filter((book) => book.ready).map((book) => book.contentHash);
}

function startJob(hashes: string[], titles: ReadonlyMap<string, string>): void {
  if (hashes.length === 0 || cloudBookUploadBusy()) return;
  previewToken++;
  const jobId = newJobId();
  publish({ panel: { kind: "running", jobId, titles, count: hashes.length, progress: null, canceling: false }, collapsed: false });
  const owns = (): boolean => view.panel.kind === "running" && view.panel.jobId === jobId;
  void cloudBookUploadNative.upload(jobId, hashes, (progress) => {
    if (progress.jobId !== jobId || !owns() || view.panel.kind !== "running") return;
    publish({ panel: { ...view.panel, progress } });
  }).then(
    (result) => {
      if (result.jobId !== jobId || !owns()) return;
      publish({ panel: { kind: "result", result }, last: result });
    },
    (error: unknown) => {
      if (!owns()) return;
      publish({ panel: { kind: "failed", failure: asCloudSyncFailure(error) }, collapsed: false });
    },
  );
}

export function confirmCloudBookUpload(): void {
  const panel = view.panel;
  if (panel.kind !== "confirm" || !panel.preview) return;
  const titles = new Map(panel.preview.books.map((book) => [book.contentHash, book.title || book.fileName]));
  startJob(readyHashes(panel.preview), titles);
}

/** The failed books of a finished batch, as a new user-started batch. */
export function failedHashes(result: CloudBookUploadResult): string[] {
  return result.books.filter((book) => book.outcome === "failed").map((book) => book.contentHash);
}

export function retryFailedCloudBookUpload(): void {
  const panel = view.panel;
  if (panel.kind !== "result") return;
  const titles = new Map(panel.result.books.map((book) => [book.contentHash, book.title]));
  startJob(failedHashes(panel.result), titles);
}

/** Asks the backend to stop; the panel waits for the real result. */
export function cancelCloudBookUpload(): void {
  const panel = view.panel;
  if ((panel.kind !== "running" && panel.kind !== "detached") || panel.canceling) return;
  const jobId = panel.jobId;
  publish({ panel: { ...panel, canceling: true } });
  void cloudBookUploadNative.cancel(jobId).then(
    (accepted) => {
      // False: the job had already ended. A live job's result still arrives on
      // its own; a detached one has none, so re-read whether it is gone.
      if (!accepted && view.panel.kind === "detached" && view.panel.jobId === jobId) void refreshDetached();
    },
    () => {
      const current = view.panel;
      if ((current.kind === "running" || current.kind === "detached") && current.jobId === jobId) {
        publish({ panel: { ...current, canceling: false } });
      }
    },
  );
}

/** A detached job only learns it ended by asking again, on the user's request. */
export async function refreshDetached(): Promise<void> {
  const panel = view.panel;
  if (panel.kind !== "detached") return;
  try {
    const current = await cloudBookUploadNative.current();
    const now = view.panel;
    if (now.kind !== "detached" || now.jobId !== panel.jobId) return;
    if (current && current.jobId === panel.jobId) publish({ panel: { ...now, progress: current.progress }, currentUnknown: false });
    else publish({ panel: { ...now, ended: true, canceling: false }, currentUnknown: false });
  } catch {
    publish({ currentUnknown: true });
  }
}

/**
 * Once per page load: a job this page did not start (the WebView reloaded
 * mid-upload) is shown as detached so a new batch is not offered over it.
 */
export async function recoverCloudBookUpload(): Promise<void> {
  if (recovered) return;
  recovered = true;
  try {
    const current = await cloudBookUploadNative.current();
    publish({ currentUnknown: false });
    if (!current || view.panel.kind !== "closed") return;
    publish({ panel: { kind: "detached", jobId: current.jobId, progress: current.progress, canceling: false, ended: false }, collapsed: true });
  } catch {
    publish({ currentUnknown: true });
  }
}

export function collapseCloudBookUpload(): void {
  const kind = view.panel.kind;
  if (kind === "running" || kind === "detached") publish({ collapsed: true });
}

export function expandCloudBookUpload(): void {
  if (view.panel.kind !== "closed") publish({ collapsed: false });
}

/** Closes a panel that holds no live job; a running job can only collapse. */
export function closeCloudBookUpload(): void {
  if (cloudBookUploadBusy()) {
    publish({ collapsed: true });
    return;
  }
  previewToken++;
  publish({ panel: { kind: "closed" }, collapsed: false });
}

export function resetCloudBookUploadStoreForTest(): void {
  view = INITIAL;
  listeners.clear();
  previewToken = 0;
  recovered = false;
}
