import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Manual original-book upload to the connected WebDAV space (ER-0018
 * backend, src-tauri/src/cloud_sync/books.rs). The backend reads, hashes,
 * deduplicates and publishes; this file only names the frozen command and
 * DTO shapes. A rejected command carries the cloud sync Failure shape.
 */

export type CloudBookUploadPhase = "preparing" | "checking" | "uploading" | "verifying" | "publishing";
export type CloudBookUploadStatus = "completed" | "partial" | "cancelled" | "stopped";
export type CloudBookUploadOutcome = "uploaded" | "already-present" | "failed" | "cancelled" | "not-attempted";

export interface CloudBookUploadPreviewBook {
  contentHash: string;
  title: string;
  fileName: string;
  /** The shelf binding's stored size; no file is opened for the preview. */
  bytes: number;
  ready: boolean;
  code: string | null;
}

export interface CloudBookUploadPreview {
  books: CloudBookUploadPreviewBook[];
  totalBytes: number;
}

export interface CloudBookUploadProgress {
  jobId: string;
  connectionId: string;
  phase: CloudBookUploadPhase;
  /** 0-based position of the current book in the batch. */
  index: number;
  count: number;
  contentHash: string;
  bookSent: number;
  bookTotal: number;
  /** Bytes processed so far, not bytes known to be on the server. */
  batchSent: number;
  batchTotal: number;
}

export interface CloudBookUploadItem {
  contentHash: string;
  title: string;
  outcome: CloudBookUploadOutcome;
  code: string | null;
  bytes: number;
}

export interface CloudBookUploadResult {
  jobId: string;
  connectionId: string;
  status: CloudBookUploadStatus;
  books: CloudBookUploadItem[];
  uploaded: number;
  alreadyPresent: number;
  failed: number;
  cancelled: number;
  notAttempted: number;
  cleanupPending: boolean;
}

export interface CloudBookUploadCurrent {
  jobId: string;
  connectionId: string;
  progress: CloudBookUploadProgress | null;
}

export const cloudBookUploadNative = {
  preview: (bookHashes: string[]) => invoke<CloudBookUploadPreview>("cloud_book_upload_preview", { bookHashes }),
  upload: (jobId: string, bookHashes: string[], onProgress: (progress: CloudBookUploadProgress) => void) => {
    const channel = new Channel<CloudBookUploadProgress>(onProgress);
    return invoke<CloudBookUploadResult>("cloud_book_upload", { jobId, bookHashes, onProgress: channel });
  },
  cancel: (jobId: string) => invoke<boolean>("cloud_book_upload_cancel", { jobId }),
  current: () => invoke<CloudBookUploadCurrent | null>("cloud_book_upload_current"),
};
