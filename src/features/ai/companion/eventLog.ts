import { openCompanionDatabase } from "./storage";

export type CompanionEventType = "session.opened" | "conversation.saved" | "conversation.cleared"
  | "turn.started" | "turn.completed" | "turn.cancelled" | "turn.failed"
  | "model.requested" | "model.completed" | "tool.started" | "tool.completed" | "context.compacted"
  | "memory.deferred" | "memory.started" | "memory.cancel-requested" | "memory.cancelled"
  | "memory.published" | "memory.discarded" | "memory.failed";
export interface CompanionEventDetails {
  turnId?: string; exchangeId?: string; jobId?: string; bookHash?: string;
  request?: number; tool?: string; count?: number; revision?: number;
  inputTokens?: number; softLimit?: number; removedHistory?: number;
  evidenceCount?: number; sourceCount?: number; memoryCount?: number;
  summaryCharacters?: number; answerCharacters?: number; elapsedMs?: number;
  status?: "complete" | "interrupted";
  reason?: "below-threshold" | "source-changed" | "exception";
}
export interface CompanionEvent {
  id: string; at: number; time: string; type: CompanionEventType; details: CompanionEventDetails;
}
export interface EventLogSnapshot { events: CompanionEvent[]; persistence: "ready" | "error" }
const KEY = "event-log:v1";
const LIMIT = 1000;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<(snapshot: EventLogSnapshot) => void>();

/** Metadata only. Never accepts prompts, answers, tool arguments, API keys or reasoning. */
export function recordCompanionEvent(type: CompanionEventType, details: CompanionEventDetails = {}): void {
  if (typeof indexedDB === "undefined") return;
  const at = Date.now();
  const event: CompanionEvent = { id: crypto.randomUUID(), at, time: new Date(at).toISOString(), type, details: { ...details } };
  writes = writes.then(async () => {
    const db = await openCompanionDatabase();
    const events = await new Promise<CompanionEvent[]>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      const store = tx.objectStore("state");
      const request = store.get(KEY);
      let next: CompanionEvent[] = [];
      request.onsuccess = () => { next = [...(request.result ?? []), event].slice(-LIMIT); store.put(next, KEY); };
      tx.oncomplete = () => resolve(next);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    for (const listener of listeners) listener({ events, persistence: "ready" });
  }).catch(() => {
    // Logging never blocks the conversation, but the diagnostic endpoint must
    // expose a failed write instead of presenting an old timeline as current.
    for (const listener of listeners) listener({ events: [], persistence: "error" });
  });
}
export async function readCompanionEvents(): Promise<CompanionEvent[]> {
  await writes;
  const db = await openCompanionDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("state").objectStore("state").get(KEY);
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}
export function observeCompanionEvents(listener: (snapshot: EventLogSnapshot) => void): () => void {
  listeners.add(listener);
  void readCompanionEvents().then(events => listener({ events, persistence: "ready" }))
    .catch(() => listener({ events: [], persistence: "error" }));
  return () => { listeners.delete(listener); };
}
