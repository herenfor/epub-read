import { Channel, invoke } from "@tauri-apps/api/core";
import type { ShelfEntry } from "../ui/shelf";

export interface AndroidDocumentSelection {
  /** Full content:// URI returned by the Android picker; never a local path. */
  uri: string;
  /** Display/fallback name; does not decide validity. */
  fileName?: string;
}

export type AndroidImportPhase = "preparing" | "committing";

export interface AndroidImportProgress {
  requestId: string;
  phase: AndroidImportPhase;
  completed: number;
  total: number;
}

export type AndroidImportItemStatus = "saved" | "duplicate" | "failed" | "cancelled";

export interface AndroidImportItemResult {
  inputIndex: number;
  status: AndroidImportItemStatus;
  contentHash: string | null;
  record: ShelfEntry | null;
  error: string | null;
}

export interface AndroidImportBatchResult {
  results: AndroidImportItemResult[];
}

export type AndroidImportErrorCode =
  | "invalid_request"
  | "unsupported_platform"
  | "busy"
  | "storage_error"
  | "commit_failed"
  | "internal_error";

export interface AndroidNativeImportError {
  code: AndroidImportErrorCode;
  message: string;
  requiresReload: boolean;
}

export type AndroidCancelStatus = "requested" | "too_late" | "not_running";

function normalizeImportError(error: unknown): AndroidNativeImportError {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : null;
  if (record && typeof record.code === "string" && typeof record.message === "string") {
    return {
      code: record.code as AndroidImportErrorCode,
      message: record.message,
      requiresReload: record.requiresReload === true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "internal_error", message, requiresReload: false };
}

export async function importDocuments(
  requestId: string,
  documents: AndroidDocumentSelection[],
  onProgress: (progress: AndroidImportProgress) => void,
): Promise<AndroidImportBatchResult> {
  const channel = new Channel<AndroidImportProgress>(onProgress);
  try {
    return await invoke<AndroidImportBatchResult>("linked_library_import_documents", {
      requestId,
      documents,
      onProgress: channel,
    });
  } catch (error) {
    throw normalizeImportError(error);
  }
}

export async function cancelDocumentImport(requestId: string): Promise<AndroidCancelStatus> {
  const reply = await invoke<{ status: AndroidCancelStatus }>("linked_library_cancel_document_import", {
    requestId,
  });
  return reply.status;
}

export async function readContentUriBytes(uri: string, maxBytes?: number): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("android_read_content_uri", {
    uri,
    maxBytes: maxBytes ?? null,
  });
  return new Uint8Array(buffer);
}

export async function readContentUriText(uri: string, maxBytes?: number): Promise<string> {
  const bytes = await readContentUriBytes(uri, maxBytes);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function writeTextContentUri(uri: string, text: string): Promise<void> {
  await invoke("android_write_text_content_uri", { uri, text });
}
