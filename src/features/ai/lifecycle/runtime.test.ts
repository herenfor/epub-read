import { describe, expect, it, vi } from "vitest";
import type { CapabilityProvider } from "../contracts/provider";
import { createMockProvider } from "../registry/mockProvider";
import { createAiRuntime } from "./runtime";

describe("AI runtime lifecycle", () => {
  it("starts inert and creates the mock only after explicit enable", async () => {
    const factory = vi.fn(() => createMockProvider());
    const runtime = createAiRuntime({ createProvider: factory });

    expect(runtime.getSnapshot()).toMatchObject({ status: "disabled", manifest: null, health: null });
    expect(factory).not.toHaveBeenCalled();
    await expect(runtime.invoke("embedding", () => "nope")).rejects.toThrow("disabled");

    await runtime.enable();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot()).toMatchObject({ status: "ready", manifest: { transport: "mock" }, health: { status: "healthy" } });
  });

  it("awaits provider disposal on disable and permits a fresh enable", async () => {
    const providers: CapabilityProvider[] = [];
    const runtime = createAiRuntime({
      createProvider: () => {
        const provider = createMockProvider();
        providers.push(provider);
        return provider;
      },
    });
    await runtime.enable();
    await runtime.disable();
    expect(runtime.getSnapshot().status).toBe("disabled");
    expect(providers[0]).toMatchObject({ stats: { dispose: 1 } });
    await expect(runtime.checkHealth()).rejects.toThrow("disabled");
    await runtime.enable();
    expect(providers).toHaveLength(2);
  });

  it("does not invoke a provider while disabled and disposes on unmount", async () => {
    const provider = createMockProvider();
    const runtime = createAiRuntime({ createProvider: () => provider });
    await expect(runtime.invoke("generation", (active) => active.generate?.({ prompt: "x" }))).rejects.toThrow("disabled");
    await runtime.enable();
    await runtime.invoke("generation", (active) => active.generate?.({ prompt: "x" }));
    expect(provider.stats.generate).toBe(1);
    await runtime.dispose();
    expect(provider.stats.dispose).toBe(1);
    expect(runtime.getSnapshot().status).toBe("disabled");
  });

  it("serializes disable behind an in-flight enable", async () => {
    let releaseHealth!: () => void;
    const provider = createMockProvider();
    const originalHealth = provider.checkHealth.bind(provider);
    provider.checkHealth = () => new Promise((resolve) => {
      releaseHealth = () => void originalHealth().then(resolve);
    });
    const runtime = createAiRuntime({ createProvider: () => provider });
    const enabling = runtime.enable();
    const disabling = runtime.disable();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseHealth();
    await enabling;
    await disabling;
    expect(provider.stats.dispose).toBe(1);
    expect(runtime.getSnapshot().status).toBe("disabled");
  });

  it("reports factory failures instead of remaining stuck in initializing", async () => {
    const failure = new Error("provider factory failed");
    const runtime = createAiRuntime({ createProvider: () => { throw failure; } });

    await expect(runtime.enable()).rejects.toBe(failure);
    expect(runtime.getSnapshot()).toMatchObject({ status: "error", error: failure.message });
  });

  it("enters disabled even when provider disposal rejects", async () => {
    const failure = new Error("provider release failed");
    const provider = createMockProvider();
    provider.dispose = async () => { throw failure; };
    const runtime = createAiRuntime({ createProvider: () => provider });

    await runtime.enable();
    await expect(runtime.disable()).rejects.toBe(failure);
    expect(runtime.getSnapshot()).toMatchObject({ status: "disabled", error: failure.message });
    await expect(runtime.invoke("embedding", () => "nope")).rejects.toThrow("disabled");
  });

  it("disposes a provider when registration fails", async () => {
    const provider = createMockProvider();
    Object.assign(provider.manifest, { id: "" });
    const runtime = createAiRuntime({ createProvider: () => provider });

    await expect(runtime.enable()).rejects.toThrow(/requires id/);
    expect(provider.stats.dispose).toBe(1);
    expect(runtime.getSnapshot().status).toBe("error");
  });
});
