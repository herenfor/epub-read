import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { canUseNativeReaderTools } from "../../../config/readerToolsSupport";
import { createProviderController, type ProviderConnection } from "./providerController";
import { READER_TOOLS_STATUS_EVENT, type ReaderToolsStatus } from "./controlTypes";
import { createNativeArchiveClient, type ArchiveInvoke } from "../../../platform/nativeArchiveClient";
import { createReaderToolService } from "./service";
import { createShelfToolBackend } from "./shelfBackend";
import { createShelfBookAccess } from "./bookAccess";
import { createReaderIndexBackend } from "./indexBackend";
import { createIndexedSearchBackend } from "./indexedSearch";
import type { ReaderToolGrant, ReaderToolRequest } from "./contracts";

type Frame = { type: "call"; id: string; request: ReaderToolRequest; grant: ReaderToolGrant } | { type: "cancel"; id: string };
const sessionKey = "epub-reader.tool-provider";

type Controller = Awaited<ReturnType<typeof createProviderController>>;
let controller: Promise<Controller> | null = null;

/** App-owned singleton; packaged debug and Vite dev use the same native gate. */
export function startNativeReaderToolProvider(): Promise<Controller | null> {
  if (!canUseNativeReaderTools(getAppBuildSession())) return Promise.resolve(null);
  if (controller) return controller;
  controller = (async () => {
    const previous = sessionStorage.getItem(sessionKey);
    if (previous) {
      await invoke("reader_tools_disconnect", { sessionId: previous });
      sessionStorage.removeItem(sessionKey);
    }
    const managed = await createProviderController({
      status: () => invoke<ReaderToolsStatus>("reader_tools_status"),
      listen: receive => listen<ReaderToolsStatus>(READER_TOOLS_STATUS_EVENT, event => receive(event.payload)),
      connect: connectProvider,
      disconnect: (sessionId, reason) => invoke("reader_tools_disconnect", { sessionId, reason }),
      reportError: (serviceInstance, message) => invoke("reader_tools_report_provider_error", { serviceInstance, message }),
    });
    return managed;
  })();
  const started = controller;
  window.addEventListener("pagehide", () => { void started.then(current => current.stop()).catch(() => {}); }, { once: true });
  // A failed initialization can be retried explicitly by the app, not in a loop.
  void started.catch(() => { if (controller === started) controller = null; });
  return started;
}

async function connectProvider(serviceInstance: string, failed: (sessionId?: string) => void): Promise<ProviderConnection> {
  let sessionId: string;
  let connected!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  const jobs = new Map<string, { abort: AbortController; done: Promise<unknown> }>();
  let stopped = false;
  const access = createShelfBookAccess({
    async openNativeArchive(contentHash, signal) {
      const closes: Promise<unknown>[] = [];
      const bridge: ArchiveInvoke = <T>(command: string, args: Record<string, unknown>) => {
        if (command === "linked_library_archive_open") return invoke<T>("reader_tools_archive_open", { sessionId, ...args });
        if (command === "linked_library_archive_close") {
          const close = invoke<T>("reader_tools_archive_close", { sessionId, archiveId: args.sessionId });
          closes.push(close); return close;
        }
        return invoke<T>(command, args);
      };
      try {
        const archive = await createNativeArchiveClient(contentHash, bridge, signal);
        return { archive, async released() { await Promise.all(closes); } };
      } catch (error) { await Promise.allSettled(closes); throw error; }
    },
  });
  const indexes = createReaderIndexBackend(access, contentHash => invoke("reader_tools_index_acquire", { sessionId, contentHash }));
  const backend = { ...createShelfToolBackend(access), ...indexes, ...createIndexedSearchBackend() };
  const channel = new Channel<Frame>();
  channel.onmessage = frame => {
    if (frame.type === "cancel") { jobs.get(frame.id)?.abort.abort(); return; }
    if (stopped) return;
    const abort = new AbortController();
    const service = createReaderToolService(backend, frame.grant);
    const done = ready.then(() => service.call(frame.request, abort.signal))
      .then(reply => stopped ? undefined : invoke<void>("reader_tools_reply", { sessionId, id: frame.id, reply }))
      .catch(() => { if (!stopped) failed(sessionId); }).finally(() => jobs.delete(frame.id));
    jobs.set(frame.id, { abort, done });
  };
  try {
    sessionId = await invoke<string>("reader_tools_connect", { frames: channel, serviceInstance, definitions: createReaderToolService(backend).definitions });
  } catch (error) {
    stopped = true;
    await indexes.dispose();
    throw error;
  }
  sessionStorage.setItem(sessionKey, sessionId);
  connected();
  let stopping: Promise<void> | null = null;
  return { sessionId, stop() {
    stopping ??= (async () => {
      stopped = true;
      for (const job of jobs.values()) job.abort.abort();
      await indexes.dispose();
      await Promise.allSettled([...jobs.values()].map(job => job.done));
      if (sessionStorage.getItem(sessionKey) === sessionId) sessionStorage.removeItem(sessionKey);
    })();
    return stopping;
  } };
}
