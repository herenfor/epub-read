import type {
  AiCapability,
  ProviderHealth,
} from "../contracts/capabilities";
import type { CapabilityProvider, ProviderRequestOptions } from "../contracts/provider";
import type {
  AiRuntime,
  AiRuntimeSnapshot,
} from "./runtime";
import { IS_AI_EDITION } from "../../../config/edition";

const DISABLED_SNAPSHOT: AiRuntimeSnapshot = {
  status: "disabled",
  manifest: null,
  health: null,
  error: null,
};

/**
 * App-facing runtime boundary. The implementation module is loaded only
 * after an AI-edition user explicitly enables the development runtime.
 */
export function createEditionAiRuntime(): AiRuntime {
  let runtime: AiRuntime | null = null;
  let runtimeLoad: Promise<AiRuntime> | null = null;
  let unsubscribeRuntime: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const ensureRuntime = async (): Promise<AiRuntime> => {
    if (!IS_AI_EDITION) {
      throw new Error("AI runtime is unavailable in the core edition");
    }
    if (runtime) return runtime;
    runtimeLoad ??= import("./runtime").then(({ createAiRuntime }) => {
      const next = createAiRuntime();
      runtime = next;
      unsubscribeRuntime = next.subscribe(notify);
      notify();
      return next;
    });
    return runtimeLoad;
  };

  const currentSnapshot = (): AiRuntimeSnapshot => runtime?.getSnapshot() ?? DISABLED_SNAPSHOT;
  const unavailable = <T>(): Promise<T> => Promise.reject(new Error("AI runtime is disabled"));

  return {
    get snapshot() {
      return currentSnapshot();
    },
    getSnapshot: currentSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enable: async () => {
      const next = await ensureRuntime();
      await next.enable();
    },
    disable: async () => {
      if (runtime) await runtime.disable();
    },
    dispose: async () => {
      const active = runtime;
      runtime = null;
      runtimeLoad = null;
      unsubscribeRuntime?.();
      unsubscribeRuntime = null;
      if (active) await active.dispose();
      notify();
    },
    checkHealth: (options?: ProviderRequestOptions): Promise<ProviderHealth> =>
      runtime ? runtime.checkHealth(options) : unavailable<ProviderHealth>(),
    invoke: <C extends AiCapability, TResult>(
      capability: C,
      operation: (provider: CapabilityProvider & Record<string, unknown>) => Promise<TResult> | TResult,
    ): Promise<TResult> => runtime
      ? runtime.invoke(capability, operation)
      : unavailable<TResult>(),
  };
}
