import type { DocumentChunk } from "../../../core/chunking";
import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import { mockIndexManifest, type IndexManifest, type PreparationReply, type PreparationRequest, type PreparationStore, type VectorRow } from "./contracts";

const DATABASE = "epub-reader-rag-preparation";
const STORES = ["jobs", "staging", "indexes", "chunks"];
const LEASE_MS = 30_000;
interface Job { book: string; manifest: IndexManifest; owner: string; leaseUntil: number; nextBatch: number; total: number; bytes: number }
interface Published { book: string; manifest: IndexManifest; total: number }
interface StoredRow extends VectorRow { book: string; ordinal: number }
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error ?? new Error("浏览器索引请求失败"));
});
const range = (book: string, start = 0, end = Number.MAX_SAFE_INTEGER) => IDBKeyRange.bound([book, start], [book, end]);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

function openDatabase(name: string, create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    let absent = false;
    r.onupgradeneeded = () => {
      if (!create) { absent = true; r.transaction!.abort(); return; }
      for (const store of ["jobs", "indexes"]) r.result.createObjectStore(store, { keyPath: "book" });
      for (const store of ["staging", "chunks"]) {
        const rows = r.result.createObjectStore(store, { keyPath: ["book", "ordinal"] });
        rows.createIndex("chunkId", ["book", "chunk.chunkId"], { unique: true });
      }
    };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); resolve(r.result); };
    r.onerror = () => absent ? resolve(null) : reject(r.error ?? new Error("无法打开浏览器索引"));
    r.onblocked = () => { reject(new Error("浏览器索引版本被其他标签页占用，请关闭旧页面后重试")); r.onsuccess = () => r.result.close(); };
  });
}

async function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = db.transaction(STORES, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("浏览器索引事务已回滚"));
    tx.onerror = () => {}; // The abort event reports failed requests, including quota errors.
  });
  // A request can reject before the caller awaits completion.
  void done.catch(() => {});
  try { const result = await work(tx); await done; return result; }
  catch (error) { try { tx.abort(); } catch { /* Already aborted or completed. */ } await done.catch(() => {}); throw error; }
  finally { db.close(); }
}

function validateManifest(manifest: IndexManifest): void {
  const expected = mockIndexManifest(manifest.bookFingerprint);
  for (const key of ["parserVersion", "normalizerVersion", "chunkerVersion"] as const) {
    if (typeof manifest[key] !== "string" || !manifest[key].length || manifest[key].length > 128) throw new Error("无效语料版本");
    expected[key] = manifest[key];
  }
  if (canonical(manifest) !== canonical(expected)) throw new Error("不支持的 mock 索引 manifest");
}
function validateChunk(chunk: DocumentChunk, manifest: IndexManifest): void {
  for (const key of ["bookFingerprint", "parserVersion", "normalizerVersion", "chunkerVersion"] as const) {
    if (chunk[key] !== manifest[key]) throw new Error("正文块与 manifest 不一致");
  }
  for (const key of ["chunkId", "chapterPath", "originalText", "normalizedText"] as const) {
    if (typeof chunk[key] !== "string" || !chunk[key].length || new TextEncoder().encode(chunk[key]).length > 16384) throw new Error("正文块字段超限");
  }
  const a = chunk.textAnchor;
  if (!a || !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || a.start < 0 || a.end < a.start || a.end > 1e9
    || !Number.isSafeInteger(chunk.spineIndex) || chunk.spineIndex < 0 || chunk.spineIndex >= 1e6
    || typeof a.snippet !== "string" || !a.snippet.length || Array.from(a.snippet).length > 32
    || chunk.chapterPath.startsWith("/") || chunk.chapterPath.includes("\\") || chunk.chapterPath.split("/").includes("..")) throw new Error("无效正文锚点或路径");
}

/** Browser-only storage adapter. Transactions serialize competing tabs; no native IPC or model files. */
export function createBrowserPreparationStore(options: { databaseName?: string; now?: () => number } = {}): PreparationStore {
  const name = options.databaseName ?? DATABASE;
  const now = options.now ?? Date.now;
  return { async request(input: PreparationRequest): Promise<PreparationReply> {
    if (!isAiDevelopmentActionsAllowed() || getAppBuildSession()?.source !== "browser") throw new Error("浏览器 mock 索引仅在 AI Web 调试版可用");
    const book = input.action === "begin" ? input.manifest.bookFingerprint : input.book;
    if (!/^[a-f0-9]{64}$/.test(book)) throw new Error("需要有效的书籍内容指纹");
    if ("owner" in input && !/^[\w-]{8,128}$/.test(input.owner)) throw new Error("无效任务 owner");
    if (input.action === "begin") validateManifest(input.manifest);
    const db = (await openDatabase(name, true))!;
    return transaction(db, input.action === "status" || input.action === "citations" ? "readonly" : "readwrite", async (tx) => {
      const jobs = tx.objectStore("jobs"), staging = tx.objectStore("staging"), indexes = tx.objectStore("indexes"), chunks = tx.objectStore("chunks");
      let job = await request<Job | undefined>(jobs.get(book));
      let published = await request<Published | undefined>(indexes.get(book));
      const time = now();
      const active = () => Boolean(job?.owner && job.leaseUntil > time);
      const owned = (owner: string): Job => {
        if (!job || job.owner !== owner || !active()) throw new Error("任务租约已失效或属于其他会话");
        return job;
      };
      const renew = (j: Job) => { j.leaseUntil = time + LEASE_MS; jobs.put(j); };
      let complete = false;
      let citations: DocumentChunk[] = [];
      switch (input.action) {
        case "begin": {
          if (active()) throw new Error("另一个标签页正在处理此书，租约到期后可继续");
          if (!input.force && !job && published && canonical(published.manifest) === canonical(input.manifest)) { complete = true; break; }
          if (job && canonical(job.manifest) !== canonical(input.manifest)) { staging.delete(range(book)); job = undefined; }
          job = { ...(job ?? { book, manifest: input.manifest, nextBatch: 0, total: 0, bytes: 0 }), owner: input.owner, leaseUntil: time + LEASE_MS };
          jobs.put(job); break;
        }
        case "append": {
          const j = owned(input.owner);
          if (input.sequence !== j.nextBatch || !input.rows.length || input.rows.length > 32 || j.total !== j.nextBatch * 32) throw new Error("批次顺序或数量无效");
          for (const row of input.rows) {
            validateChunk(row.chunk, j.manifest);
            if (row.vector.length !== 8 || row.vector.some((v) => !Number.isFinite(v) || Math.abs(v) > 1)) throw new Error("无效 mock 向量");
          }
          const bytes = input.rows.reduce((sum, r) => sum + new TextEncoder().encode(JSON.stringify(r.chunk) + JSON.stringify(r.vector)).length, 0);
          if (bytes > 512 * 1024 || j.bytes + bytes > 128 * 1024 * 1024 || j.total + input.rows.length > 100000) throw new Error("mock 索引超过存储上限");
          for (let i = 0; i < input.rows.length; i++) staging.add({ ...input.rows[i], book, ordinal: j.total + i });
          j.total += input.rows.length; j.nextBatch++; j.bytes += bytes; renew(j); break;
        }
        case "replay": {
          const j = owned(input.owner);
          if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence >= j.nextBatch || !input.chunks.length || input.chunks.length > 32) throw new Error("无效恢复批次");
          input.chunks.forEach((c) => validateChunk(c, j.manifest));
          const saved = await request<StoredRow[]>(staging.getAll(range(book, input.sequence * 32, input.sequence * 32 + 31)));
          if (canonical(saved.map((r) => r.chunk)) !== canonical(input.chunks)) throw new Error("恢复语料与 checkpoint 不一致，请清理后重建");
          renew(j); break;
        }
        case "heartbeat": renew(owned(input.owner)); break;
        case "pause": if (job?.owner === input.owner) { job.owner = ""; job.leaseUntil = 0; jobs.put(job); } break;
        case "commit": {
          const j = owned(input.owner);
          if (input.total <= 0 || input.total !== j.total || input.batches !== j.nextBatch || await request(staging.count(range(book))) !== j.total) throw new Error("索引未完整提交");
          chunks.delete(range(book));
          // Copy through a cursor, keeping memory bounded; publication and old-index removal are atomic.
          await new Promise<void>((resolve, reject) => {
            const cursor = staging.openCursor(range(book));
            cursor.onerror = () => reject(cursor.error);
            cursor.onsuccess = () => {
              const c = cursor.result;
              if (!c) { resolve(); return; }
              chunks.add(c.value); c.delete(); c.continue();
            };
          });
          published = { book, manifest: j.manifest, total: j.total }; indexes.put(published);
          jobs.delete(book); job = undefined; complete = true; break;
        }
        case "clear":
          if (active()) throw new Error("请先取消活动任务再清理");
          jobs.delete(book); indexes.delete(book); staging.delete(range(book)); chunks.delete(range(book));
          job = undefined; published = undefined; break;
        case "citations": citations = (await request<StoredRow[]>(chunks.getAll(range(book), 20))).map((r) => r.chunk); break;
        case "status": break;
      }
      return { status: { storage: "indexeddb", nextBatch: job?.nextBatch ?? 0, stagedChunks: job?.total ?? 0, publishedChunks: published?.total ?? 0, complete,
        sqliteVersion: "", databaseSchema: db.version, supportedDatabaseSchema: 1, componentVersion: 1, busyTimeoutMs: 0 }, citations };
    });
  } };
}

/** Authoritative shelf deletion fences all owners; never creates a missing preview database. */
export async function deleteBrowserPreparationForBook(book: string): Promise<void> {
  const db = await openDatabase(DATABASE, false);
  if (!db) return;
  await transaction(db, "readwrite", async (tx) => {
    tx.objectStore("jobs").delete(book); tx.objectStore("indexes").delete(book);
    tx.objectStore("staging").delete(range(book)); tx.objectStore("chunks").delete(range(book));
  });
}
