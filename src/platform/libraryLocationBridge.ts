import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * A34 P2 (Windows): moving the book library's EPUB copies to another folder,
 * reconnecting an existing library, and finishing a change that was cut
 * short. Shapes follow Codex's frozen contract
 * (docs/tasks/active/library-location-native-contract.md); every check is
 * redone natively at start, so a plan is only something to show.
 */

/** "move" copies and verifies; "reconnect" adopts a library already there. Default location = move to null. */
export type LibraryLocationMode = "move" | "reconnect";

export interface LibraryLocationPlan {
  readonly sourceDirectory: string;
  readonly targetDirectory: string;
  readonly bookCount: number;
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly recoveryPending: boolean;
}

export interface LibraryLocationProgress {
  readonly jobId: string;
  readonly phase: "copying" | "verifying" | "committing" | "cleaning";
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly completedBooks: number;
  readonly totalBooks: number;
}

export interface LibraryLocationResult {
  readonly jobId: string;
  /** cleanup-pending: the new location is in use, old leftovers remain. */
  readonly status: "completed" | "cancelled" | "cleanup-pending";
  readonly libraryDirectory: string;
  readonly bookCount: number;
  /** At least 1 while something is left; not an exact file count. */
  readonly cleanupPendingCount: number;
}

/** A native refusal; `code` picks the shown text, `message` is diagnostic. */
export class LibraryLocationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LibraryLocationError";
    this.code = code;
  }
}

function asLocationError(error: unknown): LibraryLocationError {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return new LibraryLocationError(
    typeof code === "string" ? code : "failed",
    typeof message === "string" && message ? message : String(error),
  );
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw asLocationError(error);
  }
}

export function planLibraryLocation(baseDirectory: string | null, mode: LibraryLocationMode): Promise<LibraryLocationPlan> {
  return call("linked_library_location_plan", { baseDirectory, mode });
}

export function startLibraryLocation(
  jobId: string,
  baseDirectory: string | null,
  mode: LibraryLocationMode,
  onProgress: (event: LibraryLocationProgress) => void,
): Promise<LibraryLocationResult> {
  const channel = new Channel<LibraryLocationProgress>();
  channel.onmessage = (event) => {
    if (event.jobId === jobId) onProgress(event);
  };
  return call("linked_library_location_start", { jobId, baseDirectory, mode, onProgress: channel });
}

/** "requested" only means the request was taken; the start result is the outcome. */
export async function cancelLibraryLocation(jobId: string): Promise<"requested" | "too-late" | "not-running"> {
  return (await call<{ status: "requested" | "too-late" | "not-running" }>("linked_library_location_cancel", { jobId })).status;
}

export function recoverLibraryLocation(): Promise<LibraryLocationResult> {
  return call("linked_library_location_recover");
}
