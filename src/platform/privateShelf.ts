import { invoke } from "@tauri-apps/api/core";

/** ER-0044 native wire. The private repository is never selected implicitly. */
export type PrivateShelfStatus = "unconfigured" | "locked" | "unlocked";

/** `locked` also means the session token was revoked by a lock or reset. */
export type PrivateShelfErrorCode =
  | "wrong-password"
  | "invalid-password"
  | "confirmation-required"
  | "already-configured"
  | "reset-required"
  | "not-configured"
  | "unlock-cancelled"
  | "locked"
  | string;

export class PrivateShelfError extends Error {
  override name = "PrivateShelfError";
  constructor(readonly code: PrivateShelfErrorCode, message: string) {
    super(message);
  }
}

/** Repository errors keep their code; anything else becomes `storage-error`. */
export function privateShelfError(error: unknown): PrivateShelfError {
  if (error instanceof PrivateShelfError) return error;
  const value = error as { code?: unknown; message?: unknown } | null;
  if (value && typeof value.code === "string") {
    return new PrivateShelfError(value.code, typeof value.message === "string" ? value.message : value.code);
  }
  return new PrivateShelfError("storage-error", String(error));
}

export type PrivateShelfMoveDirection = "toPrivate" | "toLibrary";

/** `operation.kind` is camelCase on the wire; see private_shelf/operations.rs. */
export type PrivateShelfOperation = { readonly kind: string } & Record<string, unknown>;

export interface PrivateShelfNative {
  status(): Promise<PrivateShelfStatus>;
  /** Returns `locked`; entering still needs unlock. */
  setup(password: string): Promise<PrivateShelfStatus>;
  unlock(password: string): Promise<{ status: "unlocked"; sessionId: string }>;
  lock(): Promise<void>;
  /** Clears private metadata and the password; original books stay. */
  reset(): Promise<PrivateShelfStatus>;
  library<T>(sessionId: string, operation: PrivateShelfOperation): Promise<T>;
  archiveRead(sessionId: string, archiveId: string, entryIndex: number, offset: number): Promise<ArrayBuffer>;
  /** Raw cover bytes; empty when the book has none. */
  cover(sessionId: string, bookHash: string): Promise<ArrayBuffer>;
  /** ER-0045: hands one book, with its progress, notes and favorite, to the other shelf. */
  move(sessionId: string, bookHash: string, direction: PrivateShelfMoveDirection): Promise<void>;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw privateShelfError(error);
  }
}

export const privateShelfNative: PrivateShelfNative = {
  status: () => call("private_shelf_status"),
  setup: (password) => call("private_shelf_setup", { password }),
  unlock: (password) => call("private_shelf_unlock", { password }),
  lock: () => call("private_shelf_lock"),
  reset: () => call("private_shelf_reset", { confirm: true }),
  library: (sessionId, operation) => call("private_shelf_library", { sessionId, operation }),
  archiveRead: (sessionId, archiveId, entryIndex, offset) =>
    call("private_shelf_archive_read", { sessionId, archiveId, entryIndex, offset }),
  cover: (sessionId, bookHash) => call("private_shelf_cover", { sessionId, bookHash }),
  move: (sessionId, bookHash, direction) => call("private_shelf_move", { sessionId, bookHash, direction }),
};
