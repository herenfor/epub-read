import { openCompanionDatabase } from "./storage";
import { exchangeTokens } from "./contextBudget";
import type { SavedExchange } from "./types";
import { recordCompanionEvent } from "./eventLog";

export interface MessageSource { exchangeId: string; revision: number; role: "user" | "assistant" }
export interface MemoryEntry {
  id: string;
  kind: "preference" | "sharedDiscussion" | "openTopic";
  content: string;
  sources: MessageSource[];
  bookHash?: string;
  supersedesId?: string;
}
export interface ConversationSegment {
  id: string;
  version: 1;
  createdAt: number;
  sources: Array<{ exchangeId: string; revision: number }>;
  through: [number, string];
  summary: string;
  openTopics: string[];
  memories: MemoryEntry[];
}
export type ConversationCursor = [number, string];
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("对话存储已中断"));
});
export async function putExchange(exchange: SavedExchange): Promise<void> {
  const db = await openCompanionDatabase();
  const tx = db.transaction(["exchanges", "segments"], "readwrite");
  const done = completed(tx);
  const store = tx.objectStore("exchanges");
  const previous = store.get(exchange.id);
  previous.onsuccess = () => {
    if (previous.result && (previous.result.revision ?? 1) >= (exchange.revision ?? 1)) { tx.abort(); return; }
    store.put(exchange);
    // Any edit to a source invalidates the entire derived segment, including its
    // memory candidates. Appending another exchange leaves older segments valid.
    if (!previous.result) return;
    const cursor = tx.objectStore("segments").openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const segment = entry.value as ConversationSegment;
      const old = previous.result as SavedExchange;
      if (segment.through[0] > old.createdAt || segment.through[0] === old.createdAt && segment.through[1] >= old.id
        || segment.sources.some(source => source.exchangeId === exchange.id
          && source.revision !== (exchange.revision ?? 1))) entry.delete();
      entry.continue();
    };
  };
  await done;
  recordCompanionEvent("conversation.saved", { exchangeId: exchange.id, revision: exchange.revision ?? 1,
    status: exchange.interrupted ? "interrupted" : "complete" });
}

/** Each record is separate; UI pagination and request budgets never prune disk history. */
export async function readExchanges(options: { before?: ConversationCursor; after?: ConversationCursor;
  limit?: number; tokenBudget?: number; oldestFirst?: boolean; completedOnly?: boolean; query?: string } = {}): Promise<SavedExchange[]> {
  const db = await openCompanionDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("exchanges");
    const range = options.before ? IDBKeyRange.upperBound(options.before, true)
      : options.after ? IDBKeyRange.lowerBound(options.after, true) : undefined;
    const cursor = tx.objectStore("exchanges").index("order").openCursor(range, options.oldestFirst ? "next" : "prev");
    const result: SavedExchange[] = [];
    let tokens = 0;
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const exchange = entry.value as SavedExchange;
      if (options.completedOnly && exchange.interrupted) { entry.continue(); return; }
      if (options.query && !`${exchange.question}\n${exchange.interrupted ? "" : exchange.answer}`.toLocaleLowerCase()
        .includes(options.query.toLocaleLowerCase())) { entry.continue(); return; }
      const size = exchangeTokens(exchange);
      if (result.length && options.tokenBudget !== undefined && tokens + size > options.tokenBudget) return;
      result.push(exchange); tokens += size;
      if (!options.limit || result.length < options.limit) entry.continue();
    };
    tx.oncomplete = () => resolve(options.oldestFirst ? result : result.reverse());
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export async function readSegments(): Promise<ConversationSegment[]> {
  const db = await openCompanionDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("segments").objectStore("segments").getAll();
    request.onsuccess = () => resolve((request.result as ConversationSegment[]).sort((a, b) =>
      a.through[0] - b.through[0] || a.through[1].localeCompare(b.through[1])));
    request.onerror = () => reject(request.error);
  });
}
/** Snapshot validation and publication share one transaction: a late background
 * result cannot resurrect cleared/edited source material. */
export async function publishSegment(segment: ConversationSegment): Promise<boolean> {
  const db = await openCompanionDatabase();
  const tx = db.transaction(["exchanges", "segments"], "readwrite");
  const done = completed(tx);
  let remaining = segment.sources.length;
  let valid = remaining > 0;
  for (const source of segment.sources) {
    const request = tx.objectStore("exchanges").get(source.exchangeId);
    request.onsuccess = () => {
      const exchange = request.result as SavedExchange | undefined;
      valid &&= !!exchange && !exchange.interrupted && (exchange.revision ?? 1) === source.revision;
      if (--remaining === 0 && valid) tx.objectStore("segments").put(segment);
    };
  }
  await done;
  return valid;
}
export async function clearConversation(): Promise<void> {
  const db = await openCompanionDatabase();
  const tx = db.transaction(["exchanges", "segments", "state"], "readwrite");
  const done = completed(tx);
  tx.objectStore("exchanges").clear(); tx.objectStore("segments").clear();
  const cursor = tx.objectStore("state").openCursor();
  cursor.onsuccess = () => {
    const entry = cursor.result;
    if (!entry) return;
    if (String(entry.key).startsWith("history:")) entry.delete();
    entry.continue();
  };
  await done;
  recordCompanionEvent("conversation.cleared");
}
