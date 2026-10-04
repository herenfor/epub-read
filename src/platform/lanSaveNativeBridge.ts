import { Channel, invoke } from "@tauri-apps/api/core";
import {
  saveFileErrorCode,
  saveFileErrorMessage,
  type SaveExportScope,
  type SaveFileCommitResult,
  type SaveFilePrepareResult,
  type SkippedBook,
} from "./saveFileNativeBridge";

export { saveFileErrorCode as lanSaveErrorCode, saveFileErrorMessage as lanSaveErrorMessage };
export type { SaveExportScope, SaveFileCommitResult, SaveFilePrepareResult, SkippedBook };

export interface LanHostResult {
  sessionId: string;
  pairingInfo: string;
}

export interface LanJoinResult {
  sessionId: string;
}

export interface LanProgress {
  phase: string;
  processedBytes: number;
  totalBytes: number | null;
}

export type LanTransferStatus = "completed" | "cancelled" | "failed" | "unconfirmed";

export interface LanSendResult {
  status: LanTransferStatus;
  transferId: string;
  archiveBytes: number;
  packageId: string;
  writtenBooks: number;
  attachedBookCount: number;
  skippedBooks: SkippedBook[];
  remoteCommit: SaveFileCommitResult | null;
  resultDelivered: boolean;
  code: string | null;
  message: string | null;
}

export type LanCloseStatus = "cancelled" | "too-late" | "already-finished";

export interface LanCloseResult {
  status: LanCloseStatus;
}

export interface LanOfferSummary {
  archiveBytes: number;
  bookCount: number;
  attachedBookCount: number;
  includeBooks: boolean;
  hasPreferences: boolean;
  skippedBookCount: number;
}

export interface LanSaveEvent {
  event: string;
  sessionId: string;
  transferId?: string;
  code?: string;
  message?: string;
  progress?: LanProgress;
  summary?: unknown;
}

interface NativeError extends Error {
  readonly code: string;
}

function normalizeLanSaveError(error: unknown): NativeError {
  const normalized = new Error(saveFileErrorMessage(error)) as NativeError & { code: string };
  Object.defineProperty(normalized, "code", {
    value: saveFileErrorCode(error) ?? "unknown",
    enumerable: true,
  });
  return normalized;
}

async function invokeLan<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeLanSaveError(error);
  }
}

export interface StartLanSaveHostInput {
  bindIp?: string;
  onEvent(event: LanSaveEvent): void;
}

export async function hostLanSave(input: StartLanSaveHostInput): Promise<LanHostResult> {
  const channel = new Channel<LanSaveEvent>(input.onEvent);
  return invokeLan<LanHostResult>("lan_save_host", {
    bindIp: input.bindIp ?? null,
    onEvent: channel,
  });
}

export interface JoinLanSaveInput {
  pairingInfo: string;
  onEvent(event: LanSaveEvent): void;
}

export async function joinLanSave(input: JoinLanSaveInput): Promise<LanJoinResult> {
  const channel = new Channel<LanSaveEvent>(input.onEvent);
  return invokeLan<LanJoinResult>("lan_save_join", {
    pairingInfo: input.pairingInfo,
    onEvent: channel,
  });
}

export async function sendLanSave(
  sessionId: string,
  scope: SaveExportScope,
  includeBooks: boolean,
): Promise<LanSendResult> {
  return invokeLan<LanSendResult>("lan_save_send", {
    sessionId,
    scope,
    includeBooks,
  });
}

export async function acceptLanSave(
  sessionId: string,
  transferId: string,
): Promise<SaveFilePrepareResult> {
  return invokeLan<SaveFilePrepareResult>("lan_save_accept", {
    sessionId,
    transferId,
  });
}

export async function commitLanSave(
  sessionId: string,
  transferId: string,
  applyPreferences: boolean,
): Promise<SaveFileCommitResult> {
  return invokeLan<SaveFileCommitResult>("lan_save_commit", {
    sessionId,
    transferId,
    applyPreferences,
  });
}

export async function closeLanSave(sessionId: string): Promise<LanCloseResult> {
  return invokeLan<LanCloseResult>("lan_save_close", { sessionId });
}
