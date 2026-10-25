import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import type { ReaderToolRequest } from "./contracts";

/** Opt-in development provider, started after app build validation. No panel
 * or current Book is required. Repository/parser modules load only after grant. */
export async function startReaderToolDevelopmentProvider(): Promise<void> {
  if (!isAiDevelopmentActionsAllowed() || (getAppBuildSession()?.source === "desktop" && getAppBuildSession()?.platform !== "windows")) return;
  const status = await fetch("/__reader-tools/status").then(response => response.json());
  if (!status.enabled) return;
  const [{ createReaderToolService }, { createShelfToolBackend }] = await Promise.all([import("./service"), import("./shelfBackend")]);
  const service = createReaderToolService(createShelfToolBackend());
  const lifetime = new AbortController();
  const jobs = new Map<string, AbortController>();
  const shutdown = () => { lifetime.abort(); for (const job of jobs.values()) job.abort(); };
  window.addEventListener("pagehide", shutdown, { once: true });
  const response = await fetch("/__reader-tools/provider/connect", { method: "POST", signal: lifetime.signal,
    headers: { "Content-Type": "application/json", "X-Reader-Provider": "1" }, body: JSON.stringify({ definitions: service.definitions }) });
  if (!response.ok) { window.removeEventListener("pagehide", shutdown); return; }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder(); let buffer = ""; let token = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline)) as { type: string; token?: string; id: string; request: ReaderToolRequest };
        buffer = buffer.slice(newline + 1);
        if (frame.type === "ready") { token = frame.token!; continue; }
        if (frame.type === "cancel") { jobs.get(frame.id)?.abort(); continue; }
        const controller = new AbortController(); jobs.set(frame.id, controller);
        // Do not await the call here: cancellation frames must keep flowing.
        void service.call(frame.request, controller.signal).then(reply => fetch("/__reader-tools/provider/reply", {
          method: "POST", signal: lifetime.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ id: frame.id, reply }),
        }).then(response => { if (!response.ok) throw new Error("Reader transport lost"); }))
          .catch(() => lifetime.abort()).finally(() => jobs.delete(frame.id));
      }
    }
  } finally {
    shutdown(); window.removeEventListener("pagehide", shutdown);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
