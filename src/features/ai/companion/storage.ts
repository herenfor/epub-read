import type { ChatSettings, SavedExchange } from "./types";

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", scope: "book",
  allowLaterChapters: false, mode: "auto", thinkingEnabled: true,
  contextTier: 200000,
  automaticMemory: true,
  runtime: "direct",
};

/** Separate from shelf/save storage. No API credentials are ever persisted here. */
export function loadChatSettings(): ChatSettings {
  try {
    const saved = JSON.parse(localStorage.getItem("epub-reader:ai-companion-settings:v1") || "{}");
    // Old "chat" is the automatic tool mode; explicitly chosen strict reading stays strict.
    return { ...DEFAULT_CHAT_SETTINGS, ...saved, mode: saved.mode === "reading" ? "reading" : "auto",
      contextTier: [100000, 200000, 400000].includes(saved.contextTier) ? saved.contextTier : 200000,
      runtime: saved.runtime === "dsh" ? "dsh" : "direct" };
  } catch { return { ...DEFAULT_CHAT_SETTINGS }; }
}
export function saveChatSettings(settings: ChatSettings): void {
  localStorage.setItem("epub-reader:ai-companion-settings:v1", JSON.stringify(settings));
}

let database: Promise<IDBDatabase> | undefined;
export function openCompanionDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("epub-reader-ai-companion-v1", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
      const exchanges = db.createObjectStore("exchanges", { keyPath: "id" });
      exchanges.createIndex("order", ["createdAt", "id"]);
      db.createObjectStore("segments", { keyPath: "id" });
      // One atomic upgrade imports every surviving old scope. Originals remain
      // in state for recovery; there is no way to recover previously evicted turns.
      const cursor = request.transaction!.objectStore("state").openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (String(entry.key).startsWith("history:")) {
          const bookHash = String(entry.key).startsWith("history:book:") ? String(entry.key).slice("history:book:".length) : undefined;
          for (const exchange of entry.value as SavedExchange[]) {
            const source = exchange.evidence.find(item => item.bookHash === bookHash);
            exchanges.put({ ...exchange, revision: 1, ...(bookHash && !exchange.context ? { context: {
              bookHash, title: source?.bookTitle ?? "历史书籍", creator: "", spineIndex: source?.spineIndex ?? -1,
            } } : {}) });
          }
        }
        entry.continue();
      };
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
async function read<T>(key: string, fallback: T): Promise<T> {
  const db = await openCompanionDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("state").objectStore("state").get(key);
    request.onsuccess = () => resolve(request.result ?? fallback);
    request.onerror = () => reject(request.error);
  });
}
async function write(key: string, value: unknown): Promise<void> {
  const db = await openCompanionDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("state", "readwrite");
    transaction.objectStore("state").put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("对话保存已中断"));
  });
}
export const loadMemories = (): Promise<string> => read("memories", "");
export const saveMemories = (value: string): Promise<void> => write("memories", value);
