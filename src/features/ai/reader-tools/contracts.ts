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
export interface ReaderToolBackend {
  list(signal: AbortSignal): Promise<ReaderBook[]>;
  chapters(bookId: string, signal: AbortSignal): Promise<ReaderChapter[]>;
  read(bookId: string, chapterId: string, signal: AbortSignal): Promise<ReaderPassage[]>;
  search(bookId: string, query: string, limit: number, signal: AbortSignal): Promise<{
    items: ReaderPassage[]; truncated: boolean; scannedChapters: number;
  }>;
}
export class ReaderToolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}
export interface ReaderToolRequest { requestId: string; name: string; arguments: Record<string, unknown> }
export type ReaderToolReply = { apiVersion: "1"; requestId: string } & (
  { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; retryable: boolean } }
);
export interface ReaderToolDefinition {
  name: string; description: string; readOnly: true; inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}
