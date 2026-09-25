import { invoke } from "@tauri-apps/api/core";

export interface SystemFont {
  family: string;
  localizedNames: Array<{ locale: string; name: string }>;
}

/** 用户上传的自定义字体（用于正文 @font-face）。 */
export interface UserFont {
  id: string;
  fileName: string;
  /** 注入 @font-face 时使用的 family 名（取自文件名主干，已去空格） */
  family: string;
  size: number;
  addedAtMs: number;
}

export interface FontStore {
  list(): Promise<UserFont[]>;
  importFont(input: {
    id: string;
    fileName: string;
    family: string;
    bytes: Uint8Array;
  }): Promise<UserFont>;
  readFont(id: string): Promise<Uint8Array>;
  deleteFont(id: string): Promise<void>;
  importFontPaths?(paths: string[]): Promise<UserFont[]>;
}

/** Enumerate fonts exposed by the host. Non-Tauri/browser builds deliberately
 * return an empty list: CSS still handles named fonts, but the app must not
 * pretend that a browser can enumerate the user's font directory. */
export async function listSystemFonts(): Promise<SystemFont[]> {
  if (!isTauriEnv()) return [];
  return invoke<SystemFont[]>("system_fonts_list");
}

export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 字体 id：文件字节 SHA-256（前端计算，后端只做十六进制校验）。 */
export function fontIdFromHash(hash: string): string {
  return hash.toLowerCase();
}

/** 从文件名生成可读 family（去掉扩展名、压缩连续空白）。 */
export function fontFamilyFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  return stem.replace(/\s+/g, " ").slice(0, 60) || "CustomFont";
}

// ---- IndexedDB（浏览器 dev / 非 Tauri 环境回退） ----

const DB_NAME = "epub-reader-fonts";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("fonts")) {
        db.createObjectStore("fonts", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("无法打开字体数据库"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("字体数据库事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("字体数据库事务中止"));
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("字体数据库请求失败"));
  });
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

class IndexedDbFontStore implements FontStore {
  async list(): Promise<UserFont[]> {
    const db = await openDb();
    try {
      const all = (await reqAsPromise(
        db.transaction("fonts", "readonly").objectStore("fonts").getAll()
      )) as Array<{ entry: UserFont; bytes: Blob } | undefined>;
      return all
        .filter((row): row is { entry: UserFont; bytes: Blob } => !!row?.entry)
        .map((row) => row.entry);
    } finally {
      db.close();
    }
  }

  async importFont(input: {
    id: string;
    fileName: string;
    family: string;
    bytes: Uint8Array;
  }): Promise<UserFont> {
    const db = await openDb();
    try {
      const entry: UserFont = {
        id: input.id,
        fileName: input.fileName,
        family: input.family,
        size: input.bytes.byteLength,
        addedAtMs: Date.now(),
      };
      const tx = db.transaction("fonts", "readwrite");
      tx.objectStore("fonts").put({
        id: input.id,
        entry,
        bytes: new Blob([input.bytes.slice().buffer as ArrayBuffer]),
      });
      await txDone(tx);
      return entry;
    } finally {
      db.close();
    }
  }

  async readFont(id: string): Promise<Uint8Array> {
    const db = await openDb();
    try {
      const row = (await reqAsPromise(
        db.transaction("fonts", "readonly").objectStore("fonts").get(id)
      )) as { bytes?: Blob } | undefined;
      if (!row?.bytes) throw new Error("字体不存在");
      return await blobToBytes(row.bytes);
    } finally {
      db.close();
    }
  }

  async deleteFont(id: string): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction("fonts", "readwrite");
      tx.objectStore("fonts").delete(id);
      await txDone(tx);
    } finally {
      db.close();
    }
  }
}

// ---- Tauri 实现（字体文件存应用数据目录） ----

class TauriFontStore implements FontStore {
  async list(): Promise<UserFont[]> {
    return invoke<UserFont[]>("fonts_list");
  }

  /** 原生路径导入只属于 Tauri：浏览器只处理 File/bytes，不暴露伪原生 path API。 */
  async importFontPaths(paths: string[]): Promise<UserFont[]> {
    return invoke<UserFont[]>("fonts_import_paths", { paths });
  }

  async importFont(input: {
    id: string;
    fileName: string;
    family: string;
    bytes: Uint8Array;
  }): Promise<UserFont> {
    return invoke<UserFont>("fonts_import_raw", input.bytes, {
      headers: {
        "x-font-id": input.id,
        "x-font-name": encodeURIComponent(input.fileName),
        "x-font-family": encodeURIComponent(input.family),
      },
    });
  }

  async readFont(id: string): Promise<Uint8Array> {
    const buf = await invoke<ArrayBuffer>("fonts_read", { fontId: id });
    return new Uint8Array(buf);
  }

  async deleteFont(id: string): Promise<void> {
    await invoke("fonts_delete", { fontId: id });
  }
}

let cachedFontStore: FontStore | null = null;

export function getFontStore(): FontStore {
  if (!cachedFontStore) {
    cachedFontStore = isTauriEnv() ? new TauriFontStore() : new IndexedDbFontStore();
  }
  return cachedFontStore;
}

/** 测试用：重置缓存的 store。 */
export function resetFontStoreForTest(): void {
  cachedFontStore = null;
}
