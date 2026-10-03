/**
 * Thin native-wire adapter.
 *
 * It is deliberately not imported by App/shelf in CP-W. CP-I decides when the
 * commands are registered; this module exists so the Web and native paths have
 * the same command shape and only storage/file capabilities differ.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  PortableStateError,
  type PortableDeleteResult,
  type PortableReadResult,
  type PortableStateCommandService,
  type PortableStateErrorCode,
  type PortableWriteResult,
  type PortableAdoptSelection,
  type PortableWriteIntent,
} from "./service";
import type { EntityRef } from "../../core/portableState/portable-write-core";

const ERROR_CODES = new Set<PortableStateErrorCode>([
  "invalid-data",
  "invalid-entity",
  "invalid-choice",
  "invalid-intent",
  "stale-basis",
  "stale-choice",
  "deleted-entity",
  "clock-exhausted",
  "storage-error",
]);

function isErrorPayload(value: unknown): value is { code: PortableStateErrorCode; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === "string" && ERROR_CODES.has(candidate.code as PortableStateErrorCode) &&
    typeof candidate.message === "string";
}

function nativeError(error: unknown): never {
  if (isErrorPayload(error)) throw new PortableStateError(error.code, error.message);
  throw error;
}

export class TauriPortableStateService implements PortableStateCommandService {
  async read(input: { readonly bookHash: string }): Promise<PortableReadResult> {
    try {
      return await invoke<PortableReadResult>("portable_state_read", input);
    } catch (error) {
      return nativeError(error);
    }
  }

  async adopt(input: {
    readonly readId: string;
    readonly entity: EntityRef;
    readonly selection: PortableAdoptSelection;
  }): Promise<{ readonly basisId: string }> {
    try {
      return await invoke<{ basisId: string }>("portable_state_adopt", input);
    } catch (error) {
      return nativeError(error);
    }
  }

  async write(input: {
    readonly basisId: string;
    readonly intent: PortableWriteIntent;
    readonly value: unknown;
    readonly updatedAtMs: number;
  }): Promise<PortableWriteResult> {
    try {
      return await invoke<PortableWriteResult>("portable_state_write", input);
    } catch (error) {
      return nativeError(error);
    }
  }

  async createAnnotation(input: {
    readonly bookHash: string;
    readonly kind: "bookmark" | "note";
    readonly id: string;
    readonly value: unknown;
    readonly updatedAtMs: number;
  }): Promise<PortableWriteResult> {
    try {
      return await invoke<PortableWriteResult>("portable_state_create_annotation", input);
    } catch (error) {
      return nativeError(error);
    }
  }

  async deleteAnnotation(input: { readonly entity: EntityRef }): Promise<PortableDeleteResult> {
    try {
      return await invoke<PortableDeleteResult>("portable_state_delete_annotation", input);
    } catch (error) {
      return nativeError(error);
    }
  }

  async release(input: {
    readonly basisId?: string;
    readonly readId?: string;
    readonly bookHash?: string;
  }): Promise<null> {
    try {
      return await invoke<null>("portable_state_release", input);
    } catch (error) {
      return nativeError(error);
    }
  }
}
