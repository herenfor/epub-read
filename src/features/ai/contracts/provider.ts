import type {
  AiCapability,
  ProviderHealth,
  ProviderManifest,
} from "./capabilities";

export interface ProviderRequestOptions {
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  vectors: readonly (readonly number[])[];
  modelId: string;
  dimensions: number;
}

export interface GenerationRequest {
  prompt: string;
  context?: readonly string[];
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerationResult {
  text: string;
  modelId: string;
  finishReason: "stop" | "length" | "cancelled";
}

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface AiProvider {
  readonly manifest: ProviderManifest;
  checkHealth(options?: ProviderRequestOptions): Promise<ProviderHealth>;
  dispose(): void | Promise<void>;
}

export interface EmbeddingProvider extends AiProvider {
  embed(texts: readonly string[], options?: ProviderRequestOptions): Promise<EmbeddingResult>;
}

export interface GeneratorProvider extends AiProvider {
  generate(request: GenerationRequest, options?: ProviderRequestOptions): Promise<GenerationResult>;
}

export interface RerankProvider extends AiProvider {
  rerank(query: string, candidates: readonly RerankCandidate[], options?: ProviderRequestOptions): Promise<readonly RerankResult[]>;
}

export type CapabilityProvider = AiProvider & Partial<EmbeddingProvider & GeneratorProvider & RerankProvider>;

export type ProviderForCapability<C extends AiCapability> = C extends "embedding"
  ? EmbeddingProvider
  : C extends "generation"
    ? GeneratorProvider
    : RerankProvider;

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export type ProviderErrorCode =
  | "aborted"
  | "disposed"
  | "unavailable"
  | "invalid-request"
  | "transport"
  | "model"
  | "unknown";

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new ProviderError("aborted", "Provider request was cancelled");
}

export function capabilityMethodName(capability: AiCapability): "embed" | "generate" | "rerank" {
  if (capability === "embedding") return "embed";
  if (capability === "generation") return "generate";
  return "rerank";
}
