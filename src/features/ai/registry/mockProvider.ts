import {
  AI_CAPABILITIES,
  type AiCapability,
  type CapabilityAvailability,
  type ProviderAvailability,
  type ProviderHealth,
  type ProviderHealthStatus,
  type ProviderManifest,
} from "../contracts/capabilities";
import {
  ProviderError,
  throwIfAborted,
  type EmbeddingProvider,
  type EmbeddingResult,
  type GenerationRequest,
  type GenerationResult,
  type ProviderRequestOptions,
  type RerankCandidate,
  type RerankProvider,
  type RerankResult,
  type GeneratorProvider,
} from "../contracts/provider";

export interface MockProviderOptions {
  id?: string;
  version?: string;
  displayName?: string;
  modelId?: string;
  dimensions?: number;
  availability?: ProviderAvailability;
  healthStatus?: ProviderHealthStatus;
  capabilities?: Partial<Record<AiCapability, CapabilityAvailability | boolean>>;
  /** Artificial delay used by cancellation tests; no network or model is involved. */
  latencyMs?: number;
}

export interface MockProviderStats {
  embed: number;
  generate: number;
  rerank: number;
  health: number;
  dispose: number;
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new ProviderError("aborted", "Provider request was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function capabilityAvailability(
  capability: AiCapability,
  values: Partial<Record<AiCapability, CapabilityAvailability | boolean>> | undefined,
): CapabilityAvailability {
  const value = values?.[capability];
  if (value === false || value === "unavailable") return "unavailable";
  return "available";
}

function deterministicVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (let index = 0; index < text.length; index++) {
    const bucket = index % dimensions;
    vector[bucket] += (text.charCodeAt(index) % 97) / 97;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function ensureCapability(provider: MockProvider, capability: AiCapability): void {
  if (!provider.supports(capability)) {
    throw new ProviderError("unavailable", `${capability} is unavailable on ${provider.manifest.id}`);
  }
}

/** Deterministic, local-only provider used to validate feature lifecycle contracts. */
export class MockProvider implements EmbeddingProvider, GeneratorProvider, RerankProvider {
  readonly manifest: ProviderManifest;
  readonly stats: MockProviderStats = { embed: 0, generate: 0, rerank: 0, health: 0, dispose: 0 };
  private readonly modelId: string;
  private readonly dimensions: number;
  private readonly latencyMs: number;
  private readonly healthStatus: ProviderHealthStatus;
  private disposed = false;

  constructor(options: MockProviderOptions = {}) {
    const id = options.id ?? "mock-provider";
    const modelId = options.modelId ?? "mock-model";
    this.modelId = modelId;
    this.dimensions = options.dimensions ?? 8;
    this.latencyMs = options.latencyMs ?? 0;
    this.healthStatus = options.healthStatus ?? "healthy";
    this.manifest = {
      id,
      version: options.version ?? "0.1.0",
      displayName: options.displayName ?? "Mock Provider",
      transport: "mock",
      local: true,
      availability: options.availability ?? "ready",
      capabilities: AI_CAPABILITIES.map((capability) => ({
        capability,
        availability: capabilityAvailability(capability, options.capabilities),
      })),
      models: [{ id: modelId, format: "deterministic", dimensions: this.dimensions }],
      privacyNotice: "本地测试 Provider，不发送正文或访问网络。",
    };
  }

  supports(capability: AiCapability): boolean {
    return this.manifest.capabilities.some((entry) => entry.capability === capability && entry.availability === "available") &&
      this.manifest.availability === "ready";
  }

  private ensureActive(): void {
    if (this.disposed) throw new ProviderError("disposed", `Provider ${this.manifest.id} has been disposed`);
  }

  async checkHealth(options?: ProviderRequestOptions): Promise<ProviderHealth> {
    this.ensureActive();
    this.stats.health++;
    await delayWithAbort(this.latencyMs, options?.signal);
    return {
      status: this.healthStatus,
      checkedAt: Date.now(),
      capabilities: Object.fromEntries(this.manifest.capabilities.map((entry) => [entry.capability, entry.availability])),
    } as ProviderHealth;
  }

  async embed(texts: readonly string[], options?: ProviderRequestOptions): Promise<EmbeddingResult> {
    this.ensureActive();
    ensureCapability(this, "embedding");
    this.stats.embed++;
    await delayWithAbort(this.latencyMs, options?.signal);
    throwIfAborted(options?.signal);
    return { vectors: texts.map((text) => deterministicVector(text, this.dimensions)), modelId: this.modelId, dimensions: this.dimensions };
  }

  async generate(request: GenerationRequest, options?: ProviderRequestOptions): Promise<GenerationResult> {
    this.ensureActive();
    ensureCapability(this, "generation");
    this.stats.generate++;
    if (!request.prompt.trim()) throw new ProviderError("invalid-request", "Generation prompt must not be empty");
    await delayWithAbort(this.latencyMs, options?.signal);
    throwIfAborted(options?.signal);
    const context = request.context?.filter((item) => item.trim()).join("\n") ?? "";
    return { text: context ? `Mock response: ${request.prompt}\n${context}` : `Mock response: ${request.prompt}`, modelId: request.modelId ?? this.modelId, finishReason: "stop" };
  }

  async rerank(query: string, candidates: readonly RerankCandidate[], options?: ProviderRequestOptions): Promise<readonly RerankResult[]> {
    this.ensureActive();
    ensureCapability(this, "reranking");
    this.stats.rerank++;
    await delayWithAbort(this.latencyMs, options?.signal);
    throwIfAborted(options?.signal);
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return candidates
      .map((candidate) => {
        const text = candidate.text.toLocaleLowerCase();
        const score = terms.length === 0 ? 0 : terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) / terms.length;
        return { id: candidate.id, score };
      })
      .sort((left, right) => right.score - left.score);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stats.dispose++;
  }
}

export function createMockProvider(options?: MockProviderOptions): MockProvider {
  return new MockProvider(options);
}
