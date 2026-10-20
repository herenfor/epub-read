import type { ChatSettings, SavedExchange } from "./types";

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", scope: "book",
  allowLaterChapters: false, mode: "reading",
};

/** Separate from shelf/save storage. No API credentials are ever persisted here. */
export function loadChatSettings(): ChatSettings {
  try {
    return { ...DEFAULT_CHAT_SETTINGS, ...JSON.parse(localStorage.getItem("epub-reader:ai-companion-settings:v1") || "{}") };
  } catch { return { ...DEFAULT_CHAT_SETTINGS }; }
}
export function saveChatSettings(settings: ChatSettings): void {
  localStorage.setItem("epub-reader:ai-companion-settings:v1", JSON.stringify(settings));
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("epub-reader-ai-companion-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
async function read<T>(key: string, fallback: T): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("state").objectStore("state").get(key);
    request.onsuccess = () => resolve(request.result ?? fallback);
    request.onerror = () => reject(request.error);
  });
}
async function write(key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("state", "readwrite");
    transaction.objectStore("state").put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("对话保存已中断"));
  });
}
export const loadExchanges = (scope: string): Promise<SavedExchange[]> => read(`history:${scope}`, []);
export const saveExchanges = (scope: string, history: SavedExchange[]): Promise<void> => write(`history:${scope}`, history.slice(-30));
export const loadMemories = (): Promise<string> => read("memories", "");
export const saveMemories = (value: string): Promise<void> => write("memories", value);
