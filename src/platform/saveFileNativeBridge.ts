import { Channel, invoke } from "@tauri-apps/api/core";

/** Wire DTOs for the F-N `.epubsave` commands. */
export interface SaveFileProgress {
  phase: string;
  processedBytes: number;
  totalBytes: number | null;
}

export type SaveFileLocation =
  | { kind: "path"; path: string }
  | { kind: "uri"; uri: string };

export type SaveExportScope =
  | { kind: "all" }
  | { kind: "selected"; bookHashes: string[] };

export interface SkippedBook {
  contentHash: string;
  title: string;
  reason: string;
}

export interface SaveFileExportResult {
  status: "written" | "cancelled";
  jobId: string;
  packageId: string | null;
  writtenBooks: number;
  bookBytes: number;
  archiveBytes: number | null;
  skippedBooks: SkippedBook[];
}

export interface MissingBook {
  contentHash: string;
  title: string;
}

export interface SaveFilePrepareResult {
  status: "prepared";
  jobId: string;
  packageId: string;
  scopeKind: "all" | "selected";
  bookCount: number;
  attachedBooks: string[];
  missingBooks: MissingBook[];
  progressConflictCount: number;
  newBookCount: number;
  hasPreferences: boolean;
  sourceBytes: number;
  totalUncompressedBytes: number;
}

export interface SaveFileCommitResult {
  status: "committed";
  jobId: string;
  mergedBooks: number;
  importedBooks: string[];
  newVisibleBooks: string[];
  missingBooks: MissingBook[];
  progressConflictBooks: string[];
  appliedPreferences: boolean;
}

export type SaveFileCancelResult = "cancelled" | "too-late" | "already-finished";

export interface SaveFileNativeError extends Error {
  readonly code: string;
}

/** Preserve the backend `{ code, message }` contract instead of stringifying objects. */
export function saveFileErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    if (typeof record.code === "string" && typeof record.message === "string") {
      return record.message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function saveFileErrorCode(error: unknown): string | null {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function normalizeSaveFileError(error: unknown): SaveFileNativeError {
  const message = saveFileErrorMessage(error);
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "unknown";
  const normalized = new Error(message) as SaveFileNativeError & { code: string };
  Object.defineProperty(normalized, "code", { value: code, enumerable: true });
  return normalized;
}

export interface ExportSaveFileInput {
  jobId: string;
  destination: SaveFileLocation;
  scope: SaveExportScope;
  includeBooks: boolean;
  onProgress(progress: SaveFileProgress): void;
}

export async function exportSaveFile(input: ExportSaveFileInput): Promise<SaveFileExportResult> {
  const channel = new Channel<SaveFileProgress>(input.onProgress);
  try {
    return await invoke<SaveFileExportResult>("save_file_export", {
      jobId: input.jobId,
      destination: input.destination,
      scope: input.scope,
      includeBooks: input.includeBooks,
      onProgress: channel,
    });
  } catch (error) {
    throw normalizeSaveFileError(error);
  }
}

export interface PrepareSaveFileImportInput {
  jobId: string;
  source: SaveFileLocation;
  onProgress(progress: SaveFileProgress): void;
}

export async function prepareSaveFileImport(
  input: PrepareSaveFileImportInput,
): Promise<SaveFilePrepareResult> {
  const channel = new Channel<SaveFileProgress>(input.onProgress);
  try {
    return await invoke<SaveFilePrepareResult>("save_file_prepare_import", {
      jobId: input.jobId,
      source: input.source,
      onProgress: channel,
    });
  } catch (error) {
    throw normalizeSaveFileError(error);
  }
}

export interface CommitSaveFileImportInput {
  jobId: string;
  applyPreferences: boolean;
  onProgress(progress: SaveFileProgress): void;
}

export async function commitSaveFileImport(
  input: CommitSaveFileImportInput,
): Promise<SaveFileCommitResult> {
  const channel = new Channel<SaveFileProgress>(input.onProgress);
  try {
    return await invoke<SaveFileCommitResult>("save_file_commit_import", {
      jobId: input.jobId,
      applyPreferences: input.applyPreferences,
      onProgress: channel,
    });
  } catch (error) {
    throw normalizeSaveFileError(error);
  }
}

export async function cancelSaveFile(jobId: string): Promise<SaveFileCancelResult> {
  try {
    const reply = await invoke<{ status: SaveFileCancelResult }>("save_file_cancel", { jobId });
    return reply.status;
  } catch (error) {
    throw normalizeSaveFileError(error);
  }
}
