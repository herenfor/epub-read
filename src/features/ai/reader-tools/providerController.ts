import type { ReaderToolsStatus } from "./controlTypes";

export interface ProviderConnection {
  sessionId: string;
  stop(): Promise<void>;
}

export interface ProviderControlPort {
  status(): Promise<ReaderToolsStatus>;
  listen(receive: (status: ReaderToolsStatus) => void): Promise<() => void>;
  connect(instance: string, failed: (sessionId?: string) => void): Promise<ProviderConnection>;
  disconnect(sessionId: string, reason?: string): Promise<void>;
  reportError(instance: string, reason: string): Promise<void>;
}

/** One app-owned lifecycle. No polling, automatic retry, or request replay. */
export async function createProviderController(port: ProviderControlPort) {
  let status: ReaderToolsStatus | null = null;
  let disposed = false;
  let epoch = 0;
  let blocked: string | null = null;
  let pending: Promise<void> | null = null;
  let active: { connection: ProviderConnection; instance: string } | null = null;
  const stopping = new Set<Promise<unknown>>();
  const observers = new Set<(status: ReaderToolsStatus) => void>();

  const retire = (connection: ProviderConnection) => {
    const done = connection.stop();
    stopping.add(done);
    void done.then(() => { stopping.delete(done); reconcile(); }, () => {
      stopping.delete(done);
      if (status?.serviceInstance) fail(status.serviceInstance, epoch);
    });
  };

  const fail = (instance: string, attempt: number, sessionId?: string) => {
    if (disposed || attempt !== epoch || status?.serviceInstance !== instance) return;
    blocked = instance;
    const previous = active;
    active = null;
    if (previous) retire(previous.connection);
    // Pass a category, never raw exceptions that may contain source data.
    const failedSession = previous?.connection.sessionId ?? sessionId;
    const report = failedSession
      ? port.disconnect(failedSession, "provider-reply-failed")
      : port.reportError(instance, "provider-connect-failed");
    void report.catch(() => { console.error("阅读工具提供方失败状态无法提交；请重启阅读接口"); });
  };

  function reconcile() {
    if (disposed || pending || active || stopping.size > 0 || blocked === status?.serviceInstance
      || !status?.supported || status.service !== "running" || status.provider !== "waiting" || !status.serviceInstance) return;
    const instance = status.serviceInstance;
    const attempt = epoch;
    pending = (async () => {
      let connection: ProviderConnection;
      try {
        connection = await port.connect(instance, (sessionId) => fail(instance, attempt, sessionId));
      } catch {
        fail(instance, attempt);
        return;
      }
      if (disposed || attempt !== epoch || status?.serviceInstance !== instance
        || status.service !== "running" || status.provider === "failed" || blocked === instance) {
        retire(connection);
        await port.disconnect(connection.sessionId).catch(() => {});
        return;
      }
      active = { connection, instance };
    })().finally(() => { pending = null; reconcile(); });
  }

  function receive(next: ReaderToolsStatus) {
    if (disposed || (status && next.revision <= status.revision)) return;
    const previous = status;
    status = next;
    if (previous?.serviceInstance !== next.serviceInstance || (previous?.provider === "failed" && next.provider === "waiting")) blocked = null;
    if (!next.supported || next.service !== "running" || next.provider === "failed"
      || (previous?.serviceInstance !== next.serviceInstance)) {
      epoch++;
      if (active) { retire(active.connection); active = null; }
    } else if (next.provider === "waiting" && previous?.provider === "ready" && active) {
      retire(active.connection); active = null;
    }
    for (const observer of observers) observer(next);
    reconcile();
  }

  // Subscribe before the initial read: an older reply cannot undo a new event.
  const unlisten = await port.listen(receive);
  try { receive(await port.status()); }
  catch (error) { unlisten(); throw error; }

  return {
    getStatus: () => status,
    subscribe(listener: (status: ReaderToolsStatus) => void) {
      observers.add(listener);
      return () => { observers.delete(listener); };
    },
    async stop() {
      if (disposed) return;
      disposed = true; epoch++; unlisten(); observers.clear();
      if (active) {
        const connection = active.connection;
        active = null; retire(connection);
        await port.disconnect(connection.sessionId).catch(() => {});
      }
      await pending;
      await Promise.allSettled(stopping);
    },
  };
}
