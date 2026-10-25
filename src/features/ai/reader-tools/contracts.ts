/** Framework-neutral public data. No model, memory store or renderer objects. */
export const READER_TOOLS_API_VERSION = "1";
export interface ReaderBook {
  bookId: string; contentHash?: string; title: string; creator: string; available: boolean;
  favorite: boolean; folderId: string | null;
}
export interface ReaderChapter { chapterId: string; title: string; spineIndex: number }
export interface ReaderPassage {
  bookId: string; contentHash: string; chapterId: string; spineIndex: number; chunkId: string;
  corpusVersion: string; originalText: string;
  anchor: { start: number; end: number; snippet: string };
}
export interface ReaderLibraryPassage extends ReaderPassage { title: string; creator: string; chapterTitle?: string }
export interface ReaderSearchCoverage {
  scopeBooks: number; indexedBooks: number; missingIndexBooks: number; outdatedIndexBooks: number;
  unavailableBooks: number; complete: boolean;
}
export interface ReaderToolBackend {
  list(signal: AbortSignal): Promise<ReaderBook[]>;
  indexStatus?(books: ReaderBook[], signal: AbortSignal): Promise<ReaderIndexStatus[]>;
  prepareIndex?(bookId: string, signal: AbortSignal): Promise<ReaderIndexJob & { bookId: string; reused: boolean }>;
  cancelIndex?(bookId: string, taskId: string, signal: AbortSignal): Promise<ReaderIndexJob & { bookId: string }>;
  searchLibrary?(books: ReaderBook[], queries: string[], limit: number, signal: AbortSignal): Promise<{
    items: ReaderLibraryPassage[]; coverage: ReaderSearchCoverage; candidateLimitReached: boolean;
  }>;
  chapters(bookId: string, signal: AbortSignal): Promise<ReaderChapter[]>;
  read(bookId: string, chapterId: string, signal: AbortSignal): Promise<ReaderPassage[]>;
  search(bookId: string, query: string, limit: number, signal: AbortSignal): Promise<{
    items: ReaderPassage[]; truncated: boolean; scannedChapters: number;
  }>;
}
export class ReaderToolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}
export interface ReaderToolRequest {
  requestId: string; name: string; arguments: Record<string, unknown>;
  /** Supplied by the calling adapter, outside model-generated tool arguments. */
  maxResponseBytes?: number;
}
export type ReaderToolReply = { apiVersion: "1"; requestId: string; responseBudget?: { maxBytes: number; limited: boolean } } & (
  { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; retryable: boolean } }
);
export interface ReaderToolDefinition {
  name: string; description: string; readOnly: boolean; inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/** Trusted host grant. Caller arguments may narrow this scope, never enlarge it. */
export interface ReaderToolGrant { clientId: string; bookIds: string[] | null; prepareIndex: boolean }

export interface ReaderIndexJob { taskId: string | null; state: "queued" | "running" | "completed" | "cancelled" | "failed"; progress: number }
export interface ReaderIndexStatus { bookId: string; state: "current" | "missing" | "outdated" | "unavailable"; chunkCount: number; job?: ReaderIndexJob }
