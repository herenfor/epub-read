/**
 * Typed calls for the ER-0137 KOReader sidecar commands.
 * Native owns the file/URI session, candidate digest and progress transaction.
 * This module only shapes those calls. It does not open a panel.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Locator } from "../core/portableState/portable-state-types";
import type { Version } from "../core/portableState/portable-register-core";
import type { ProgressValue } from "../core/portableState/portable-state-types";
import type { SaveFileLocation } from "./saveFileNativeBridge";
import { KOR_SIDECAR_BYTE_LIMIT } from "../render/interop/koreaderProgress";

export { KOR_SIDECAR_BYTE_LIMIT };

export type KoreaderImportScope = { kind: "public" } | { kind: "private"; sessionId: string };

export interface KoreaderSidecarInfo {
  sessionId: string;
  bytes: number;
}

export interface KoreaderLocalProgress {
  versions: Version<ProgressValue>[];
  display: Version<ProgressValue> | null;
  conflict: boolean;
}

/** Candidate row for one local EPUB. partialMd5 is not a content-hash proof. */
export interface KoreaderTargetCandidate {
  bookHash: string;
  partialMd5: string;
  targetToken: string;
  progress: KoreaderLocalProgress;
}

export interface KoreaderProgressCommit {
  bookHash: string;
  targetToken: string;
  /** Explicit confirmed locator. The hint is stored with it and is not an identity. */
  progress: { locator: Locator; progressPctHint: number };
}

export interface KoreaderProgressOutcome {
  progressWritten: number;
  progressUnchanged: number;
}

export type KoreaderCloseStatus = "closed" | "committed" | "not-found";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const call: Invoke = (command, args) => invoke(command, args);

export function openKoreaderSidecar(
  input: { sessionId: string; source: SaveFileLocation; scope: KoreaderImportScope },
  run: Invoke = call,
): Promise<KoreaderSidecarInfo> {
  return run("koreader_sidecar_open", input);
}

export async function readKoreaderSidecarText(sessionId: string, run: Invoke = call): Promise<string> {
  const buffer = await run<ArrayBuffer>("koreader_sidecar_read", { sessionId });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw Object.assign(new Error("KOReader sidecar is not UTF-8"), { code: "invalid-data" });
  }
}

export function koreaderImportTarget(
  sessionId: string,
  bookHash: string,
  run: Invoke = call,
): Promise<KoreaderTargetCandidate> {
  return run("koreader_import_target", { sessionId, bookHash });
}

export function commitKoreaderProgress(
  sessionId: string,
  book: KoreaderProgressCommit,
  run: Invoke = call,
): Promise<KoreaderProgressOutcome> {
  return run("koreader_import_commit", { sessionId, book });
}

export async function closeKoreaderSidecar(sessionId: string, run: Invoke = call): Promise<KoreaderCloseStatus> {
  const reply = await run<{ status: KoreaderCloseStatus }>("koreader_sidecar_close", { sessionId });
  return reply.status;
}
