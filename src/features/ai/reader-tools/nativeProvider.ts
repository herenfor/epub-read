import { Channel, invoke } from "@tauri-apps/api/core";
import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import { createNativeArchiveClient, type ArchiveInvoke } from "../../../platform/nativeArchiveClient";
import { createReaderToolService } from "./service";
import { createShelfToolBackend } from "./shelfBackend";
import { createShelfBookAccess } from "./bookAccess";
import { createReaderIndexBackend } from "./indexBackend";
import { createIndexedSearchBackend } from "./indexedSearch";
import type { ReaderToolGrant, ReaderToolRequest } from "./contracts";

type Frame = { type: "call"; id: string; request: ReaderToolRequest; grant: ReaderToolGrant } | { type: "cancel"; id: string };
const sessionKey = "epub-reader.tool-provider";

/** Native process owns socket/auth/queue. This provider owns canonical extraction,
 * independently of React panels or the currently open book. */
export async function startNativeReaderToolProvider(): Promise<void> {
  const build = getAppBuildSession();
  if (!isAiDevelopmentActionsAllowed() || build?.source !== "desktop" || build.platform !== "windows") return;
  // A reloaded main WebView can retire only its own previous session. Native
  // teardown closes that session's handles, including an unfinished open.
  const previous = sessionStorage.getItem(sessionKey);
  if (previous) await invoke("reader_tools_disconnect", { sessionId: previous });
  let sessionId: string;
  let connected!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  const jobs = new Map<string, AbortController>();
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
    if (frame.type === "cancel") { jobs.get(frame.id)?.abort(); return; }
    if (stopped) return;
    const abort = new AbortController();
    const service = createReaderToolService(backend, frame.grant);
    void ready.then(() => service.call(frame.request, abort.signal)).then(reply => invoke<void>("reader_tools_reply", { sessionId, id: frame.id, reply }))
      .catch(() => { void shutdown(); }).finally(() => jobs.delete(frame.id));
    jobs.set(frame.id, abort);
  };
  sessionId = await invoke<string>("reader_tools_connect", { frames: channel, definitions: createReaderToolService(backend).definitions });
  sessionStorage.setItem(sessionKey, sessionId);
  connected();
  async function shutdown() {
    if (stopped) return;
    stopped = true;
    indexes.dispose();
    for (const job of jobs.values()) job.abort();
    // Native disconnect is the final cleanup authority if pagehide prevents JS
    // from finishing. It reclaims only capability handles, not the reading view.
    await invoke("reader_tools_disconnect", { sessionId }).catch(() => {});
    if (sessionStorage.getItem(sessionKey) === sessionId) sessionStorage.removeItem(sessionKey);
  }
  window.addEventListener("pagehide", () => { void shutdown(); }, { once: true });
}
