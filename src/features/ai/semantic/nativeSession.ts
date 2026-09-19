import { invoke } from "@tauri-apps/api/core";
import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import type { EmbeddingProfile, SemanticSession } from "./contracts";

export const EMBEDDING_ERROR_KINDS = ["cancelled", "insufficientResources", "assetChanged", "unsupported", "executionFailed"] as const;
export type EmbeddingErrorKind = (typeof EMBEDDING_ERROR_KINDS)[number];

export interface EmbeddingGatewayError { kind: EmbeddingErrorKind; message: string }

export interface DeviceEvidence {
  deviceIndex: number | null;
  luid: string | null;
  adapterName: string | null;
  providers: readonly string[];
  cpuNodeCount: number | null;
}

export interface OpenedSession {
  sessionId: string;
  profile: EmbeddingProfile;
  device: DeviceEvidence;
  admission: "idle" | "active" | "faulted";
  packageDir: string;
}

export interface EmbeddingStatus {
  admission: "idle" | "active" | "faulted";
  sessionId: string | null;
  platformSupported: boolean;
}

export function isEmbeddingGatewayError(value: unknown): value is EmbeddingGatewayError {
  return typeof value === "object" && value !== null
    && typeof (value as EmbeddingGatewayError).kind === "string"
    && (EMBEDDING_ERROR_KINDS as readonly string[]).includes((value as EmbeddingGatewayError).kind);
}

/** Exact error message for the UI, keeping the classified kind available. */
export function embeddingErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Normalize structured IPC errors once, preserving classification and cancellation. */
async function invokeEmbedding<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    if (cause instanceof Error) throw cause;
    const error = new Error(embeddingErrorMessage(cause), { cause });
    if (isEmbeddingGatewayError(cause)) {
      Object.assign(error, { kind: cause.kind, ...(cause.kind === "cancelled" ? { code: "aborted" } : {}) });
    }
    throw error;
  }
}

function requireDesktop(): void {
  if (!isAiDevelopmentActionsAllowed() || getAppBuildSession()?.source !== "desktop") {
    throw new Error("本机嵌入模型仅在 AI 桌面调试版可用");
  }
}

/** Opens one native session. The caller must always close it. */
export async function openSemanticSession(packageId: string, deviceLuid?: string | null): Promise<OpenedSession & { session: SemanticSession }> {
  requireDesktop();
  const opened = await invokeEmbedding<OpenedSession>("ai_semantic_open", {
    input: { packageId, deviceLuid: deviceLuid ?? null },
  });
  const sessionId = opened.sessionId;
  const session: SemanticSession = {
    profile: opened.profile,
    async embed(texts, purpose, signal) {
      if (signal.aborted) throw abortError();
      const reply = await invokeEmbedding<{ vectors: number[][]; tokens: number[] }>("ai_semantic_embed", {
        input: { sessionId, texts, purpose },
      });
      if (signal.aborted) throw abortError();
      return reply.vectors;
    },
    async close() {
      await invokeEmbedding("ai_semantic_close", { input: { sessionId } });
    },
  };
  return { ...opened, session };
}

/** Token counts including prefix and special tokens, for batch planning. */
export async function countSemanticTokens(sessionId: string, texts: readonly string[], purpose: "query" | "passage"): Promise<readonly number[]> {
  requireDesktop();
  const reply = await invokeEmbedding<{ tokens: number[] }>("ai_semantic_count", { input: { sessionId, texts, purpose } });
  return reply.tokens;
}

/** Cooperative cancellation. The session stays occupied until close confirms. */
export async function cancelSemanticSession(sessionId: string): Promise<void> {
  requireDesktop();
  await invokeEmbedding("ai_semantic_cancel", { input: { sessionId } });
}

export async function semanticEmbeddingStatus(): Promise<EmbeddingStatus> {
  requireDesktop();
  return invokeEmbedding<EmbeddingStatus>("ai_semantic_status");
}

export interface EmbeddingProbeReport {
  packageDir: string;
  profile: EmbeddingProfile;
  device: DeviceEvidence;
  admission: "idle" | "active" | "faulted";
  queryTokens: number;
  passageTokens: number;
  vectorPreview: readonly number[];
  vectorNorm: number;
  vectorMaxAbs: number;
  vectorDigest: string;
  elapsedMs: number;
  queryPassageCosine: number;
}

/** Debug-only real-model probe. It loads the verified model, embeds one short
 * sentence as query and passage, closes the session, and reports identity,
 * device, token counts, vector statistics and timing. */
export async function probeSemanticEmbedding(text?: string, packageId?: string, deviceLuid?: string | null): Promise<EmbeddingProbeReport> {
  requireDesktop();
  return invokeEmbedding<EmbeddingProbeReport>("ai_semantic_probe", {
    input: { packageId: packageId ?? null, deviceLuid: deviceLuid ?? null, text: text ?? null },
  });
}

function abortError(): Error {
  const error = new Error("查询已取消");
  (error as { code?: string }).code = "aborted";
  return error;
}
