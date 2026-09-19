import { createProviderRegistry } from "../registry/providerRegistry";
import { createMockProvider } from "../registry/mockProvider";
import { ProviderError, throwIfAborted, type EmbeddingProvider } from "../contracts/provider";
import { ResourceGovernor } from "./resourceGovernor";

/** Mock-only session. Each call is bounded and late results are rejected after cancellation. */
export async function withMockEmbedding<T>(
  governor: ResourceGovernor,
  signal: AbortSignal,
  operation: (embed: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>) => Promise<T>,
  factory: () => EmbeddingProvider = createMockProvider,
  timeoutMs = 5000,
): Promise<T> {
  const release = await governor.acquire(1024 * 1024, signal);
  const registry = createProviderRegistry();
  let provider: EmbeddingProvider | undefined;
  const bounded = async <V>(fn: (signal: AbortSignal) => Promise<V>): Promise<V> => {
    throwIfAborted(signal);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    const stop = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new ProviderError("aborted", "mock 会话已取消")); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new ProviderError("transport", "mock 操作超时")); }, timeoutMs);
    });
    try { const value = await Promise.race([Promise.resolve().then(() => fn(controller.signal)), stop]); throwIfAborted(signal); return value; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  };
  try {
    throwIfAborted(signal);
    provider = factory();
    if (provider.manifest.transport !== "mock") throw new ProviderError("unavailable", "准备阶段禁止真实 Provider");
    registry.register(provider);
    const health = await bounded((s) => registry.checkHealth(provider!.manifest.id, { signal: s }));
    if (health.status !== "healthy") throw new ProviderError("unavailable", "mock 健康检查失败");
    const embedding = registry.resolveOrThrow("embedding");
    const result = await operation(async (texts) => {
      await governor.waitUntilRunnable(signal);
      const result = await bounded((s) => embedding.embed(texts, { signal: s }));
      if (result.modelId !== "mock-model" || result.dimensions !== 8 || result.vectors.length !== texts.length
        || result.vectors.some((v) => v.length !== 8 || v.some((n) => !Number.isFinite(n)))) {
        throw new ProviderError("model", "mock 返回了不兼容的向量");
      }
      return result.vectors;
    });
    throwIfAborted(signal);
    return result;
  } finally {
    // Only project-owned mock providers are accepted; no GPU/sidecar can outlive this session.
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => registry.size ? registry.dispose() : provider?.dispose()),
        new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new ProviderError("transport", "mock 释放超时")), timeoutMs); }),
      ]);
    } finally { clearTimeout(cleanupTimer); release(); }
  }
}
