import { describe, expect, it } from "vitest";
import { AI_CAPABILITIES, type CapabilityProvider } from "../contracts";
import { ProviderRegistryError, createProviderRegistry } from "./providerRegistry";
import { createMockProvider } from "./mockProvider";

describe("AI provider contracts and registry", () => {
  it("registers a mock provider and resolves each advertised capability independently", async () => {
    const provider = createMockProvider({ id: "local-mock" });
    const registry = createProviderRegistry([provider]);

    expect(registry.size).toBe(1);
    expect(registry.listForCapability("embedding")).toHaveLength(1);
    expect(registry.resolve("embedding", "local-mock")).toBe(provider);
    expect(registry.resolve("generation", "local-mock")).toBe(provider);
    expect(registry.resolve("reranking", "local-mock")).toBe(provider);
    expect(await registry.checkHealth("local-mock")).toMatchObject({ status: "healthy" });

    await registry.dispose();
    expect(provider.stats.dispose).toBe(1);
    expect(registry.size).toBe(0);
  });

  it("rejects duplicate provider IDs and duplicate capability declarations", () => {
    const first = createMockProvider({ id: "same" });
    const registry = createProviderRegistry([first]);
    expect(() => registry.register(createMockProvider({ id: "same" }))).toThrowError(ProviderRegistryError);
    expect(() => registry.register({
      manifest: {
        id: "invalid",
        version: "1",
        displayName: "Invalid",
        transport: "mock",
        local: true,
        availability: "ready",
        capabilities: [
          { capability: "embedding", availability: "available" },
          { capability: "embedding", availability: "available" },
        ],
      },
      checkHealth: async () => ({ status: "healthy", checkedAt: Date.now() }),
      dispose: () => {},
    } satisfies CapabilityProvider)).toThrowError(ProviderRegistryError);
  });

  it("awaits unregister disposal and exposes disposal failures", async () => {
    let released = false;
    const asynchronouslyDisposed: CapabilityProvider = {
      manifest: {
        id: "async-dispose",
        version: "1",
        displayName: "Async dispose",
        transport: "mock",
        local: true,
        availability: "ready",
        capabilities: [],
      },
      checkHealth: async () => ({ status: "healthy", checkedAt: Date.now() }),
      dispose: async () => {
        await Promise.resolve();
        released = true;
      },
    };
    const registry = createProviderRegistry([asynchronouslyDisposed]);
    await expect(registry.unregister("async-dispose")).resolves.toBe(true);
    expect(released).toBe(true);
    expect(registry.has("async-dispose")).toBe(false);

    const disposalError = new Error("release failed");
    const failingProvider: CapabilityProvider = {
      ...asynchronouslyDisposed,
      manifest: { ...asynchronouslyDisposed.manifest, id: "failing-dispose" },
      dispose: async () => {
        await Promise.resolve();
        throw disposalError;
      },
    };
    const failingRegistry = createProviderRegistry([failingProvider]);
    await expect(failingRegistry.unregister("failing-dispose")).rejects.toBe(disposalError);
    expect(failingRegistry.has("failing-dispose")).toBe(false);
  });

  it("does not resolve a capability that is unavailable or whose provider is disabled", () => {
    const provider = createMockProvider({
      id: "embedding-only",
      capabilities: { generation: false, reranking: "unavailable" },
    });
    const disabled = createMockProvider({ id: "disabled", availability: "disabled" });
    const registry = createProviderRegistry([provider, disabled]);

    expect(registry.resolve("embedding")).toBe(provider);
    expect(registry.resolve("generation", "embedding-only")).toBeUndefined();
    expect(registry.resolve("embedding", "disabled")).toBeUndefined();
    expect(() => registry.resolveOrThrow("generation", "embedding-only")).toThrow(/No provider supports generation/);
  });

  it("supports AbortSignal cancellation for each mock operation", async () => {
    const provider = createMockProvider({ latencyMs: 30 });
    const controller = new AbortController();
    const pending = provider.embed(["正文"], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "ProviderError", code: "aborted" });

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(provider.generate({ prompt: "问题" }, { signal: alreadyCancelled.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it("is deterministic and records disposal without loading a model or network", async () => {
    const provider = createMockProvider({ dimensions: 4 });
    const first = await provider.embed(["同一段正文"]);
    const second = await provider.embed(["同一段正文"]);
    expect(first).toEqual(second);
    expect(first.vectors[0]).toHaveLength(4);

    provider.dispose();
    provider.dispose();
    expect(provider.stats.dispose).toBe(1);
    await expect(provider.embed(["再次请求"])).rejects.toMatchObject({ code: "disposed" });
    expect(AI_CAPABILITIES).toEqual(["embedding", "generation", "reranking"]);
  });
});
