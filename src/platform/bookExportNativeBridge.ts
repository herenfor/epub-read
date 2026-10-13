import { Channel, invoke } from "@tauri-apps/api/core";
import {
  saveFileErrorMessage,
  type SaveExportScope,
  type SaveFileLocation,
  type SaveFileProgress,
} from "./saveFileNativeBridge";

/** SBE-N wire DTOs for exporting the shelf's original EPUB files. */
export interface BookSourceExportResult {
  status: "written" | "cancelled" | "no-books";
  jobId: string;
  outputFormat: "epub" | "zip";
  requestedBooks: number;
  writtenBooks: number;
  bookBytes: number;
  outputBytes: number;
  exportedBooks: Array<{ contentHash: string; fileName: string }>;
  skippedBooks: Array<{ contentHash: string; title: string; reason: string }>;
}

export interface BookSourceExportError extends Error {
  readonly code: string;
  /** The saved file may hold a partial EPUB/ZIP; it is not a sign the shelf copy was lost. */
  readonly partialOutputRetained: boolean;
}

function normalizeBookExportError(error: unknown): BookSourceExportError {
  const record = error && typeof error === "object" ? error as { code?: unknown; partialOutputRetained?: unknown } : {};
  const normalized = new Error(saveFileErrorMessage(error)) as Error & { code: string; partialOutputRetained: boolean };
  normalized.code = typeof record.code === "string" ? record.code : "unknown";
  normalized.partialOutputRetained = record.partialOutputRetained === true;
  return normalized;
}

export async function exportBookSources(input: {
  jobId: string;
  scope: SaveExportScope;
  destination: SaveFileLocation;
  destinationIsNew: boolean;
  onProgress(progress: SaveFileProgress): void;
}): Promise<BookSourceExportResult> {
  try {
    return await invoke<BookSourceExportResult>("book_source_export", {
      jobId: input.jobId,
      scope: input.scope,
      destination: input.destination,
      destinationIsNew: input.destinationIsNew,
      onProgress: new Channel<SaveFileProgress>(input.onProgress),
    });
  } catch (error) {
    throw normalizeBookExportError(error);
  }
}
