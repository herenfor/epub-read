import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import type { DocumentChunk } from "../../../core/chunking";
import { createSnapshot, type SemanticReply, type SemanticRequest, type SemanticSnapshot, type SemanticStore } from "./store";

const DATABASE = "epub-reader-semantic-preview";
const COMPONENT_VERSION = 1;
const LEASE_MS = 30_000;
const MAX_BATCH_BYTES = 512 * 1024;
const MAX_BOOK_ROWS = 100_000;
/** Preview storage reports the same component/schema contract as the SQLite store. */
const REPORTED_SCHEMA = 6;
/** IndexedDB keys are 32-bit unsigned integers, so range upper bounds must stay
 * inside that domain: `Number.MAX_SAFE_INTEGER` raises a RangeError. */
const MAX_KEY = 0xffffffff;

interface Job {
  book: string;
  manifest: unknown;
  manifestKey: string;
  owner: string;
  leaseUntil: number;
  corpusDigest: string;
  policy: unknown;
  nextBatch: number;
  total: number;
  bytes: number;
}

interface Generation {
  book: string;
  generation: number;
  manifest: unknown;
  manifestKey: string;
  total: number;
  updatedAt: number;
}

interface StoredRow {
  book: string;
  generation: number;
  batch: number;
  ordinal: number;
  chunkId: string;
  chunk: DocumentChunk;
  vector: readonly number[];
  bytes: number;
}

interface Pin { book: string; generation: number; pinnedAt: number }

const STORES = ["jobs", "staging", "generations", "vectors", "snapshots"] as const;

const request = <T>(input: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  input.onsuccess = () => resolve(input.result);
  input.onerror = () => reject(input.error ?? new Error("浏览器语义索引请求失败"));
});

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opened = indexedDB.open(DATABASE, 1);
    opened.onupgradeneeded = () => {
      const db = opened.result;
      db.createObjectStore("jobs", { keyPath: "book" });
      db.createObjectStore("generations", { keyPath: ["book", "generation"] });
      db.createObjectStore("snapshots", { keyPath: ["book", "generation"] });
      const staging = db.createObjectStore("staging", { keyPath: ["book", "batch", "ordinal"] });
      staging.createIndex("chunk", ["book", "batch", "chunkId"], { unique: true });
      db.createObjectStore("vectors", { keyPath: ["book", "generation", "ordinal"] });
    };
    opened.onsuccess = () => {
      opened.result.onversionchange = () => opened.result.close();
      resolve(opened.result);
    };
    opened.onerror = () => reject(opened.error ?? new Error("无法打开浏览器语义索引"));
  });
}

async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(STORES as unknown as string[], mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("浏览器语义索引事务已回滚"));
    tx.onerror = () => {};
  });
  void done.catch(() => {});
  try {
    const result = await work(tx);
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted */ }
    await done.catch(() => {});
    throw error;
  } finally { db.close(); }
}

function requirePreview(): void {
  if (!isAiDevelopmentActionsAllowed() || getAppBuildSession()?.source !== "browser") {
    throw new Error("浏览器预览语义索引仅在 AI Web 调试版可用");
  }
}

function emptyReply(): SemanticReply {
  return {
    schema: REPORTED_SCHEMA, supportedSchema: REPORTED_SCHEMA, componentVersion: COMPONENT_VERSION,
    busyTimeoutMs: 0, job: null, published: null, generations: [], snapshot: null,
  };
}

function replyFor(
  job: Job | undefined,
  generation: Generation | undefined,
  all: Generation[],
  complete: boolean,
): SemanticReply {
  return {
    ...emptyReply(),
    job: job ? {
      owner: job.owner, manifestKey: job.manifestKey, corpusDigest: job.corpusDigest,
      nextBatch: job.nextBatch, stagedRows: job.total, stagedBytes: job.bytes, complete,
      manifest: job.manifest as never, policy: job.policy as never,
    } : null,
    published: generation ? {
      generation: generation.generation, total: generation.total, manifestKey: generation.manifestKey,
      manifest: generation.manifest as never, publishedAtMs: generation.updatedAt,
    } : null,
    generations: all
      .sort((a, b) => b.generation - a.generation)
      .map((item) => ({
        generation: item.generation, total: item.total, manifestKey: item.manifestKey,
        manifest: item.manifest as never, publishedAtMs: item.updatedAt,
      })),
  };
}

function validateChunk(chunk: DocumentChunk, manifest: Record<string, unknown>): void {
  for (const key of ["bookFingerprint", "parserVersion", "normalizerVersion", "chunkerVersion"] as const) {
    if (chunk[key] !== manifest[key]) throw new Error("正文块与语义索引身份不一致");
  }
  if (!chunk.chunkId || !chunk.normalizedText) throw new Error("正文块字段缺失");
}

/** Browser-only preview store. It reuses the real corpus, pipeline and query
 * controller but keeps clearly labelled test vectors: it never claims to be the
 * native Windows model path. */
export function createBrowserSemanticStore(): SemanticStore {
  const respond = async (input: SemanticRequest): Promise<SemanticReply> => {
    requirePreview();
    return transaction(input.action === "status" || input.action === "readSnapshot" ? "readonly" : "readwrite", async (tx) => {
      const jobs = tx.objectStore("jobs");
      const staging = tx.objectStore("staging");
      const generations = tx.objectStore("generations");
      const vectors = tx.objectStore("vectors");
      const snapshots = tx.objectStore("snapshots");
      const now = Date.now();
      const book = "book" in input ? input.book : input.manifest.bookFingerprint;
      const job = await request<Job | undefined>(jobs.get(book));
      const all = await request<Generation[]>(generations.getAll(IDBKeyRange.bound([book, 0], [book, MAX_KEY])));
      const latest = all.sort((a, b) => b.generation - a.generation)[0];
      const reply = replyFor(job, latest, all, false);
      switch (input.action) {
        case "begin": {
          if (job && job.owner && job.leaseUntil > now) throw new Error("另一个会话正在为此书建立语义索引，请稍后继续");
          if (!job && latest?.manifestKey === input.manifestKey && !input.force) {
            return replyFor({
              book, manifest: input.manifest, manifestKey: input.manifestKey,
              owner: "", leaseUntil: 0, corpusDigest: input.corpusDigest, policy: input.policy,
              nextBatch: 0, total: 0, bytes: 0,
            }, latest, all, true);
          }
          const sameIdentity = Boolean(job) && job!.manifestKey === input.manifestKey
            && job!.corpusDigest === input.corpusDigest
            && JSON.stringify(job!.policy) === JSON.stringify(input.policy);
          if (input.force || !sameIdentity) {
            const existing = await request<StoredRow[]>(staging.getAll());
            for (const row of existing) if (row.book === book) await staging.delete([row.book, row.batch, row.ordinal]);
            await jobs.delete(book);
          }
          const next: Job = {
            book, manifest: input.manifest, manifestKey: input.manifestKey, owner: input.owner,
            leaseUntil: now + LEASE_MS, corpusDigest: input.corpusDigest, policy: input.policy,
            nextBatch: sameIdentity && !input.force ? job!.nextBatch : 0,
            total: sameIdentity && !input.force ? job!.total : 0,
            bytes: sameIdentity && !input.force ? job!.bytes : 0,
          };
          await jobs.put(next);
          return replyFor(next, latest, all, false);
        }
        case "append": {
          const current = owned(job, input.owner, now);
          if (input.sequence !== current.nextBatch) throw new Error("语义批次顺序或数量无效");
          const base = current.total;
          let bytes = current.bytes;
          const seen = new Set<string>();
          for (const [index, row] of input.rows.entries()) {
            if (row.ordinal !== base + index) throw new Error("语义批次序号不连续");
            validateChunk(row.chunk, current.manifest as Record<string, unknown>);
            if (seen.has(row.chunk.chunkId)) throw new Error("批次正文块重复");
            seen.add(row.chunk.chunkId);
            const dimensions = (current.manifest as { profile: { dimensions: number } }).profile.dimensions;
            if (row.vector.length !== dimensions || row.vector.some((value) => !Number.isFinite(value) || Math.abs(value) > 1)) {
              throw new Error("向量维度或数值无效");
            }
            const size = JSON.stringify(row.chunk).length + JSON.stringify(row.vector).length;
            bytes += size;
            await staging.put({
              book, generation: 0, batch: input.sequence, ordinal: row.ordinal,
              chunkId: row.chunk.chunkId, chunk: row.chunk, vector: row.vector, bytes: size,
            });
          }
          if (base + input.rows.length > MAX_BOOK_ROWS || JSON.stringify(input.rows).length > MAX_BATCH_BYTES) {
            throw new Error("语义索引容量超限");
          }
          const next: Job = { ...current, nextBatch: current.nextBatch + 1, total: base + input.rows.length, bytes, leaseUntil: now + LEASE_MS };
          await jobs.put(next);
          return replyFor(next, latest, all, false);
        }
        case "replay": {
          const current = owned(job, input.owner, now);
          if (input.sequence < 0 || input.sequence >= current.nextBatch) throw new Error("无效恢复批次");
          const saved = await request<StoredRow[]>(staging.getAll(IDBKeyRange.bound([book, input.sequence, 0], [book, input.sequence, MAX_KEY])));
          const actual = input.chunks.map((chunk) => JSON.stringify(chunk));
          const expected = saved.sort((a, b) => a.ordinal - b.ordinal).map((row) => JSON.stringify(row.chunk));
          if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("恢复语料与 checkpoint 不一致，请清理后重建");
          return replyFor({ ...current, leaseUntil: now + LEASE_MS }, latest, all, false);
        }
        case "heartbeat": {
          const current = owned(job, input.owner, now);
          await jobs.put({ ...current, leaseUntil: now + LEASE_MS });
          return replyFor(current, latest, all, false);
        }
        case "pause": {
          if (job && job.owner === input.owner) await jobs.put({ ...job, owner: "", leaseUntil: 0 });
          return reply;
        }
        case "commit": {
          const current = owned(job, input.owner, now);
          const staged = await request<StoredRow[]>(staging.getAll());
          const rows = staged.filter((row) => row.book === book);
          if (input.total <= 0 || input.total !== current.total || input.total !== rows.length || input.batches !== current.nextBatch) {
            throw new Error("语义索引未完整提交");
          }
          const generation = (latest?.generation ?? 0) + 1;
          for (const row of rows) {
            await vectors.put({ ...row, generation });
            await staging.delete([row.book, row.batch, row.ordinal]);
          }
          const published: Generation = {
            book, generation, manifest: current.manifest, manifestKey: current.manifestKey,
            total: input.total, updatedAt: now,
          };
          await generations.put(published);
          await jobs.delete(book);
          await reclaimBehind(generations, vectors, snapshots, book, generation, now);
          const remaining = all.filter((item) => item.generation === generation).concat(published);
          return replyFor(undefined, published, remaining, true);
        }
        case "status":
          return replyFor(job, latest, all, false);
        case "openSnapshot": {
          if (!latest) throw new Error("此书尚未发布语义索引");
          await snapshots.put({ book, generation: latest.generation, pinnedAt: now } satisfies Pin);
          const page = await readPage(vectors, book, latest, 0, 0);
          page.rows = [];
          page.done = false;
          const result = replyFor(undefined, latest, all, false);
          result.snapshot = page;
          return result;
        }
        case "readSnapshot": {
          const pin = await request<Pin | undefined>(snapshots.get([book, input.generation]));
          if (!pin) throw new Error("快照未打开或已释放");
          const target = all.find((item) => item.generation === input.generation);
          if (!target) throw new Error("已发布代次不存在");
          const result = replyFor(undefined, target, all, false);
          result.snapshot = await readPage(vectors, book, target, input.after, input.limit);
          return result;
        }
        case "closeSnapshot": {
          await snapshots.delete([book, input.generation]);
          await reclaimBehind(generations, vectors, snapshots, book, latest?.generation ?? 0, now);
          return reply;
        }
        case "clear": {
          if (job && job.owner && job.leaseUntil > now) throw new Error("请先取消活动任务并关闭查询后再清理");
          const pins = await request<Pin[]>(snapshots.getAll());
          if (pins.some((pin) => pin.book === book)) throw new Error("请先取消活动任务并关闭查询后再清理");
          await jobs.delete(book);
          const staged = await request<StoredRow[]>(staging.getAll());
          for (const row of staged) if (row.book === book) await staging.delete([row.book, row.batch, row.ordinal]);
          const stored = await request<StoredRow[]>(vectors.getAll());
          for (const row of stored) if (row.book === book) await vectors.delete([row.book, row.generation, row.ordinal]);
          for (const item of all) await generations.delete([item.book, item.generation]);
          return replyFor(undefined, undefined, [], false);
        }
      }
    });
  };
  return {
    request: respond,
    async openSnapshot(book: string): Promise<SemanticSnapshot> {
      const reply = await respond({ action: "openSnapshot", book });
      if (!reply.snapshot) throw new Error("此书尚未发布语义索引");
      return createSnapshot({ request: respond, openSnapshot: () => Promise.reject(new Error("嵌套快照不受支持")) }, book, reply.snapshot);
    },
  };
}

function owned(job: Job | undefined, owner: string, now: number): Job {
  if (!job || job.owner !== owner || job.leaseUntil <= now) throw new Error("任务租约已失效或属于其他会话");
  return job;
}

async function readPage(vectors: IDBObjectStore, book: string, generation: Generation, after: number, limit: number) {
  const rows = await request<StoredRow[]>(vectors.getAll(
    IDBKeyRange.bound([book, generation.generation, after], [book, generation.generation, MAX_KEY]),
    limit || MAX_KEY,
  ));
  const ordered = rows.sort((a, b) => a.ordinal - b.ordinal);
  return {
    generation: generation.generation,
    manifest: generation.manifest as never,
    manifestKey: generation.manifestKey,
    total: generation.total,
    rows: ordered.map((row) => ({ ordinal: row.ordinal, chunk: row.chunk, vector: row.vector })),
    done: ordered.length === 0 ? after >= generation.total : ordered[ordered.length - 1].ordinal + 1 >= generation.total,
  };
}

/** Drops generations behind the newest once no snapshot still pins them. */
async function reclaimBehind(
  generations: IDBObjectStore,
  vectors: IDBObjectStore,
  snapshots: IDBObjectStore,
  book: string,
  keep: number,
  _now: number,
): Promise<void> {
  const pins = await request<Pin[]>(snapshots.getAll());
  const pinned = new Set(pins.filter((pin) => pin.book === book).map((pin) => pin.generation));
  const all = await request<Generation[]>(generations.getAll());
  for (const item of all) {
    if (item.book !== book || item.generation >= keep || pinned.has(item.generation)) continue;
    const rows = await request<StoredRow[]>(vectors.getAll());
    for (const row of rows) {
      if (row.book === book && row.generation === item.generation) {
        await vectors.delete([row.book, row.generation, row.ordinal]);
      }
    }
    await generations.delete([item.book, item.generation]);
  }
}
