import { useSyncExternalStore } from "react";
import { asCloudSyncFailure, type CloudSyncFailure } from "../../platform/cloudSyncNative";
import {
  cloudBookUploadNative,
  type CloudBookUploadPreview,
  type CloudBookUploadProgress,
  type CloudBookUploadResult,
} from "../../platform/cloudBookUploadNative";
import { cloudSyncView } from "./cloudSyncStore";

/**
 * ER-0151: one manual original-book upload at a time. The backend reads,
 * hashes, deduplicates and publishes; this store only shows what it reports.
 * Every progress event and result is owned by its jobId: a late one from an
 * older job never touches the current panel. A batch is also tied to the
 * connection it was confirmed for: when that changes, the books go back to a
 * fresh confirmation for the new target. A new batch only starts once the
 * backend has said no other job is running. Nothing here retries, polls or
 * reads book files.
 */

export type CloudBookUploadPanel =
  | { kind: "closed" }
  /**
   * Preview loading (preview and failure both null), ready, or failed.
   * `connectionId` is the target the panel was confirmed against; a change
   * sets `targetChanged` and asks once more.
   */
  | {
    kind: "confirm";
    hashes: string[];
    preview: CloudBookUploadPreview | null;
    failure: CloudSyncFailure | null;
    connectionId: string | null;
    targetChanged: boolean;
  }
  | {
    kind: "running";
    jobId: string;
    connectionId: string;
    /** Titles from the preview, for the current book's name. */
    titles: ReadonlyMap<string, string>;
    count: number;
    progress: CloudBookUploadProgress | null;
    canceling: boolean;
  }
  /** A job this page did not start (e.g. before a reload): no live progress or result reaches it. */
  | { kind: "detached"; jobId: string; progress: CloudBookUploadProgress | null; canceling: boolean; ended: boolean }
  | { kind: "result"; result: CloudBookUploadResult }
  /** The upload command itself was refused (no connection, busy, bridge gone). */
  | { kind: "failed"; failure: CloudSyncFailure };

/**
 * What cloud_book_upload_current last said: not asked yet, being asked,
 * answered, or unreadable. Only "known" lets a new batch start.
 */
export type CloudBookUploadCurrentState = "unread" | "reading" | "known" | "unknown";

export interface CloudBookUploadView {
  panel: CloudBookUploadPanel;
  /** The panel is collapsed to the small floating card (running or finished). */
  collapsed: boolean;
  /** This run of the app's last finished result, for the settings row. Memory only. */
  last: CloudBookUploadResult | null;
  current: CloudBookUploadCurrentState;
}

const INITIAL: CloudBookUploadView = { panel: { kind: "closed" }, collapsed: false, last: null, current: "unread" };
let view: CloudBookUploadView = INITIAL;
const listeners = new Set<() => void>();
let previewToken = 0;
/** Only the newest current() read may change the state. */
let currentToken = 0;

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

/** A new batch may start: no job in flight and the backend confirmed none is running. */
export function cloudBookUploadCanStart(state: CloudBookUploadView = view): boolean {
  return state.current === "known" && !cloudBookUploadBusy(state);
}

function currentConnectionId(): string | null {
  return cloudSyncView().status?.connection?.connectionId ?? null;
}

function newJobId(): string {
  return crypto.randomUUID();
}

/**
 * Asks the backend which job is running. A job this page does not own
 * becomes the detached panel (over a confirmation, never over this page's
 * own running job); no job ends a detached one. A failed read leaves the
 * state unknown until the user asks again.
 */
function readCurrent(): Promise<void> {
  const token = ++currentToken;
  publish({ current: "reading" });
  return cloudBookUploadNative.current().then(
    (job) => {
      if (token !== currentToken) return;
      const panel = view.panel;
      if (panel.kind === "running") {
        // Starting waits for "known", so a job here is this page's own.
        publish({ current: "known" });
      } else if (job && panel.kind === "detached" && panel.jobId === job.jobId) {
        publish({ current: "known", panel: { ...panel, progress: job.progress } });
      } else if (job) {
        previewToken++;
        publish({
          current: "known",
          panel: { kind: "detached", jobId: job.jobId, progress: job.progress, canceling: false, ended: false },
          // Shown to a user who was confirming a batch; otherwise only the card.
          collapsed: panel.kind === "closed" ? true : panel.kind === "confirm" ? false : view.collapsed,
        });
      } else if (panel.kind === "detached") {
        publish({ current: "known", panel: { ...panel, ended: true, canceling: false } });
      } else {
        publish({ current: "known" });
      }
    },
    () => {
      if (token === currentToken) publish({ current: "unknown" });
    },
  );
}

function openConfirm(hashes: string[], connectionId: string | null, targetChanged: boolean): void {
  if (view.current === "unread" || view.current === "unknown") void readCurrent();
  const token = ++previewToken;
  publish({ panel: { kind: "confirm", hashes, preview: null, failure: null, connectionId, targetChanged }, collapsed: false });
  void cloudBookUploadNative.preview(hashes).then(
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

/** Opens the confirm panel for these books and reads the offline preview. */
export function requestCloudBookUpload(hashes: string[]): void {
  const unique = [...new Set(hashes.filter((hash) => hash !== ""))];
  if (unique.length === 0) return;
  if (cloudBookUploadBusy()) {
    // The entry is disabled while busy; a stray request just shows the job.
    publish({ collapsed: false });
    return;
  }
  openConfirm(unique, currentConnectionId(), false);
}

/** The books the confirm panel would send: only those the snapshot can upload. */
export function readyHashes(preview: CloudBookUploadPreview): string[] {
  return preview.books.filter((book) => book.ready).map((book) => book.contentHash);
}

function startJob(hashes: string[], titles: ReadonlyMap<string, string>, connectionId: string): void {
  if (hashes.length === 0 || !cloudBookUploadCanStart()) return;
  previewToken++;
  const jobId = newJobId();
  publish({ panel: { kind: "running", jobId, connectionId, titles, count: hashes.length, progress: null, canceling: false }, collapsed: false });
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

/**
 * Starts the confirmed batch. Waits while the running job is unknown; a
 * target that changed since the panel was confirmed is shown and asked
 * once more instead of uploading to it.
 */
export function confirmCloudBookUpload(): void {
  const panel = view.panel;
  if (panel.kind !== "confirm" || !panel.preview || !cloudBookUploadCanStart()) return;
  const target = currentConnectionId();
  if (!target) return;
  if (panel.connectionId !== null && panel.connectionId !== target) {
    publish({ panel: { ...panel, connectionId: target, targetChanged: true } });
    return;
  }
  const titles = new Map(panel.preview.books.map((book) => [book.contentHash, book.title || book.fileName]));
  startJob(readyHashes(panel.preview), titles, target);
}

/** The failed books of a finished batch, as a new user-started batch. */
export function failedHashes(result: CloudBookUploadResult): string[] {
  return result.books.filter((book) => book.outcome === "failed").map((book) => book.contentHash);
}

/** The finished batch went to another connection than the current one. */
export function cloudBookUploadOtherTarget(result: CloudBookUploadResult): boolean {
  const target = currentConnectionId();
  return target !== null && target !== result.connectionId;
}

/**
 * Sends the failed books again to the same connection. If the connection
 * changed (or the running job is not known), they go back to a confirmation
 * for the current target instead.
 */
export function retryFailedCloudBookUpload(): void {
  const panel = view.panel;
  if (panel.kind !== "result") return;
  const hashes = failedHashes(panel.result);
  if (hashes.length === 0) return;
  const target = currentConnectionId();
  if (target !== panel.result.connectionId || !cloudBookUploadCanStart()) {
    openConfirm(hashes, target, target !== panel.result.connectionId);
    return;
  }
  const titles = new Map(panel.result.books.map((book) => [book.contentHash, book.title]));
  startJob(hashes, titles, target);
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
      if (!accepted && view.panel.kind === "detached" && view.panel.jobId === jobId) void readCurrent();
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
  if (view.panel.kind === "detached") await readCurrent();
}

/** The user asks again after the running job could not be read. */
export async function rereadCloudBookUpload(): Promise<void> {
  if (view.current !== "reading") await readCurrent();
}

/**
 * Once per page load: a job this page did not start (the WebView reloaded
 * mid-upload) is shown as detached so a new batch is not offered over it.
 */
export async function recoverCloudBookUpload(): Promise<void> {
  if (view.current === "unread") await readCurrent();
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
  currentToken = 0;
}
