import type { ProgressRuntimeStatus } from "./progressRuntimeGate";

interface RepositoryPort {
  runtimeStatus(): Promise<ProgressRuntimeStatus>;
  activate(): Promise<unknown>;
}

/** Explicit operation recovery; use the actual data service, never its old activation promise. */
export function createRepositoryReadinessRecovery(port: RepositoryPort): () => Promise<ProgressRuntimeStatus> {
  let activation: Promise<void> | null = null;
  return async () => {
    const initial = await port.runtimeStatus();
    if (initial.repositoryReady) return initial;
    if (!activation) {
      const pending = Promise.resolve().then(() => port.activate()).then(() => undefined);
      activation = pending;
      // Settle bookkeeping without hiding rejection from awaiters.
      void pending.finally(() => {
        if (activation === pending) activation = null;
      }).catch(() => undefined);
    }
    await activation;
    const actual = await port.runtimeStatus();
    if (!actual.repositoryReady) {
      throw Object.assign(new Error("阅读资料服务尚未就绪，请重试"), { code: "runtime-not-ready" });
    }
    return actual;
  };
}
