import {
  type AiCapability,
  type ProviderHealth,
  type ProviderManifest,
} from "../contracts/capabilities";
import type { CapabilityProvider, ProviderRequestOptions } from "../contracts/provider";
import { createMockProvider } from "../registry/mockProvider";
import { createProviderRegistry, type ProviderRegistry } from "../registry/providerRegistry";

export type AiRuntimeStatus = "disabled" | "initializing" | "ready" | "error";

export interface AiRuntimeSnapshot {
  status: AiRuntimeStatus;
  manifest: ProviderManifest | null;
  health: ProviderHealth | null;
  error: string | null;
}

export interface AiRuntimeOptions {
  /** Factory injection keeps lifecycle tests independent of model loading. */
  createProvider?: () => CapabilityProvider;
}

export interface AiRuntime {
  readonly snapshot: AiRuntimeSnapshot;
  getSnapshot(): AiRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  enable(): Promise<void>;
  disable(): Promise<void>;
  dispose(): Promise<void>;
  checkHealth(options?: ProviderRequestOptions): Promise<ProviderHealth>;
  invoke<C extends AiCapability, TResult>(
    capability: C,
    operation: (provider: CapabilityProvider & Record<string, unknown>) => Promise<TResult> | TResult,
  ): Promise<TResult>;
}

/**
 * Application-owned AI lifecycle. Construction is deliberately inert: no
 * provider, model, task, database, or network resource is created until the
 * caller explicitly enables the runtime.
 */
export function createAiRuntime(options: AiRuntimeOptions = {}): AiRuntime {
  const listeners = new Set<() => void>();
  const createProvider = options.createProvider ?? (() => createMockProvider({ id: "development-mock" }));
  let current: AiRuntimeSnapshot = {
    status: "disabled",
    manifest: null,
    health: null,
    error: null,
  };
  let registry: ProviderRegistry | null = null;
  let transition: Promise<void> = Promise.resolve();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const setSnapshot = (next: AiRuntimeSnapshot): void => {
    current = next;
    notify();
  };
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = transition.then(task, task);
    transition = next.catch(() => undefined);
    return next;
  };

  const runtime: AiRuntime = {
    get snapshot() {
      return current;
    },
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enable: () => enqueue(async () => {
      if (registry && current.status === "ready") return;
      setSnapshot({ status: "initializing", manifest: null, health: null, error: null });
      let provider: CapabilityProvider | null = null;
      let nextRegistry: ProviderRegistry | null = null;
      try {
        provider = createProvider();
        nextRegistry = createProviderRegistry([provider]);
        registry = nextRegistry;
        const health = await nextRegistry.checkHealth(provider.manifest.id);
        setSnapshot({ status: "ready", manifest: provider.manifest, health, error: null });
      } catch (error) {
        registry = null;
        // Registration can fail before a registry is returned, so dispose the
        // just-created provider directly in that case. A cleanup rejection is
        // intentionally secondary to the original initialization failure.
        try {
          if (nextRegistry) await nextRegistry.dispose();
          else if (provider) await provider.dispose();
        } catch {
          // The original error remains the actionable initialization error.
        }
        const message = error instanceof Error ? error.message : String(error);
        setSnapshot({ status: "error", manifest: null, health: null, error: message });
        throw error;
      }
    }),
    disable: () => enqueue(async () => {
      const active = registry;
      registry = null;
      let disposeError: unknown;
      try {
        if (active) await active.dispose();
      } catch (error) {
        disposeError = error;
      } finally {
        setSnapshot({
          status: "disabled",
          manifest: null,
          health: null,
          error: disposeError instanceof Error ? disposeError.message : disposeError ? String(disposeError) : null,
        });
      }
      if (disposeError) throw disposeError;
    }),
    dispose: () => enqueue(async () => {
      const active = registry;
      registry = null;
      let disposeError: unknown;
      try {
        if (active) await active.dispose();
      } catch (error) {
        disposeError = error;
      } finally {
        setSnapshot({
          status: "disabled",
          manifest: null,
          health: null,
          error: disposeError instanceof Error ? disposeError.message : disposeError ? String(disposeError) : null,
        });
        listeners.clear();
      }
      if (disposeError) throw disposeError;
    }),
    checkHealth: (requestOptions) => {
      if (!registry || current.status !== "ready") {
        return Promise.reject(new Error("AI runtime is disabled"));
      }
      const provider = registry.list()[0]?.provider;
      if (!provider) return Promise.reject(new Error("AI provider is unavailable"));
      return provider.checkHealth(requestOptions);
    },
    invoke: async (capability, operation) => {
      if (!registry || current.status !== "ready") {
        throw new Error("AI runtime is disabled");
      }
      const provider = registry.resolve(capability);
      if (!provider) throw new Error(`AI capability is unavailable: ${capability}`);
      return operation(provider as CapabilityProvider & Record<string, unknown>);
    },
  };
  return runtime;
}
