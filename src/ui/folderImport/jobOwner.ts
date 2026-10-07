import type {
  DirectoryImportPort,
  DirectoryImportResult,
  DirectoryProgress,
  FolderTarget,
} from "../../core/folderImport/contract";
import type { ImportOptions } from "../../core/folderImport/planner";

export interface ImportRunHandlers {
  onProgress(event: DirectoryProgress): void;
  onResult(result: DirectoryImportResult): void;
  onError(error: unknown): void;
  /** Exactly once after start() settles, on success, cancel or failure alike. */
  onSettled(): void;
}

/**
 * Owns the panel's single directory-import job. A job is adopted from its
 * first scan event, so closing during a scan can cancel it; a late result of a
 * superseded or closed scan is only cleaned up. While start() runs, closing
 * requests a cancel and keeps ownership until the run settles, then releases.
 */
export class FolderImportJobOwner {
  private jobId: string | null = null;
  private scanToken = 0;
  private importing = false;
  private closed = false;
  private readonly released = new Map<string, Promise<void>>();
  private closing: Promise<void> | null = null;
  private runSettled: Promise<void> | null = null;
  private releasing: Promise<void> = Promise.resolve();

  constructor(private readonly port: DirectoryImportPort) {}

  get currentJobId(): string | null {
    return this.jobId;
  }

  get isImporting(): boolean {
    return this.importing;
  }

  /** Starts a new scan attempt; any previous job is released. */
  async beginScan(): Promise<number> {
    const token = ++this.scanToken;
    await this.releaseCurrent();
    return token;
  }

  /**
   * Called from every scan event and the scan result. True when the job
   * belongs to the live attempt; otherwise the job is released and the caller
   * must not update the UI.
   */
  adopt(token: number, jobId: string): boolean {
    if (this.closed || token !== this.scanToken) {
      void this.release(jobId);
      return false;
    }
    if (this.jobId === null) this.jobId = jobId;
    if (this.jobId === jobId) return true;
    void this.release(jobId);
    return false;
  }

  /** The scan of `token` is still the live attempt. */
  isLive(token: number, jobId?: string): boolean {
    return !this.closed && token === this.scanToken && (jobId === undefined || this.jobId === jobId);
  }

  run(
    input: { readonly options: ImportOptions; readonly targets: readonly FolderTarget[] },
    handlers: ImportRunHandlers,
  ): boolean {
    const jobId = this.jobId;
    if (!jobId || this.importing || this.closed) return false;
    this.importing = true;
    this.runSettled = this.port.start({ jobId, options: input.options, targets: input.targets, onProgress: handlers.onProgress })
      .then(handlers.onResult, handlers.onError)
      .finally(async () => {
        this.importing = false;
        // Books may have landed even when start() rejected: refresh regardless.
        handlers.onSettled();
        if (this.closed) await this.releaseCurrent();
      });
    return true;
  }

  async cancel(): Promise<"requested" | "settling" | "already-finished"> {
    const jobId = this.jobId;
    if (!jobId) return "already-finished";
    return this.port.cancel(jobId).catch(() => "already-finished" as const);
  }

  /** Panel close or unmount. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.scanToken++;
    if (this.importing) {
      // Ownership stays until the run settles; it releases afterwards.
      void this.cancel();
      return this.closing = this.runSettled!;
    }
    return this.closing = this.releaseCurrent();
  }

  /** Cancel, then dispose the current job (not while start() runs). */
  releaseCurrent(): Promise<void> {
    if (this.importing) return Promise.resolve();
    const jobId = this.jobId;
    this.jobId = null;
    if (jobId) this.releasing = this.release(jobId);
    return this.releasing;
  }

  private release(jobId: string): Promise<void> {
    const existing = this.released.get(jobId);
    if (existing) return existing;
    const cleanup = (async () => {
      await this.port.cancel(jobId).catch(() => undefined);
      await this.port.dispose(jobId).catch(() => undefined);
    })();
    this.released.set(jobId, cleanup);
    return cleanup;
  }
}
