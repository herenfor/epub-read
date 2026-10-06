/** Frozen FI native/Web facade; jobs, roots and bindings are LOCAL ONLY. */
import type { DirectoryBinding, ImportOptions, ImportRoot, ScannedEpub } from "./planner";

export interface ScanResult {
  readonly jobId: string;
  readonly root: ImportRoot;
  readonly inputCount: number;
  readonly skippedDirectoryCount: number;
  readonly unreadableDirectoryCount: number;
}
export interface InputPage {
  readonly items: readonly ScannedEpub[];
  /** Relevant live local source bindings; first page also includes root binding. */
  readonly bindings: readonly DirectoryBinding[];
  readonly nextCursor: string | null;
}
export type FolderTarget =
  | { readonly groupKey: string; readonly kind: "reuse"; readonly folderId: string }
  | { readonly groupKey: string; readonly kind: "create"; readonly folderId: string; readonly name: string };
export interface ImportCounts {
  readonly completed: number;
  readonly imported: number;
  readonly duplicates: number;
  readonly failed: number;
  readonly placementSkipped: number;
  readonly createdFolders: number;
}
export interface DirectoryProgress {
  readonly jobId: string;
  readonly phase: "scanning" | "preparing" | "committing" | "cleaning";
  readonly scannedInputs: number;
  readonly totalInputs: number | null;
  readonly counts: ImportCounts;
}
export interface DirectoryImportResult {
  readonly jobId: string;
  readonly status: "completed" | "cancelled" | "failed";
  readonly counts: ImportCounts;
  readonly issueCount: number;
}
export interface ImportIssue {
  readonly inputId: string;
  readonly kind: "source-failed" | "placement-changed" | "target-deleted" | "multiple-sources";
  readonly message: string;
}
export interface IssuePage {
  readonly items: readonly ImportIssue[];
  readonly nextCursor: string | null;
}
export interface DirectoryImportPort {
  scan(onProgress: (event: DirectoryProgress) => void): Promise<ScanResult | null>;
  page(jobId: string, cursor?: string): Promise<InputPage>;
  start(input: {
    readonly jobId: string;
    readonly options: ImportOptions;
    readonly targets: readonly FolderTarget[];
    readonly onProgress: (event: DirectoryProgress) => void;
  }): Promise<DirectoryImportResult>;
  issues(jobId: string, cursor?: string): Promise<IssuePage>;
  cancel(jobId: string): Promise<"requested" | "settling" | "already-finished">;
  dispose(jobId: string): Promise<void>;
}
// Missing fields stay missing. Explicit null is reserved for cursor/unknown total.
// This port's closure owns native source handles or Web File references.
