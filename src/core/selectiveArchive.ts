import { unzipSync, strFromU8 } from "fflate";

export class ArchiveClosedError extends Error {
  constructor(message = "归档已关闭") {
    super(message);
    this.name = "ArchiveClosedError";
  }
}

export interface ArchiveEntry {
  name: string; // ZIP 原始路径。调用方沿用项目现有路径规范化映射。
  compressedBytes: number;
  expandedBytes: number;
}

export class SelectiveEpubArchive {
  readonly directory = new Map<string, ArchiveEntry>();
  private bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    // filter false 读取目录但不 inflate；不能把“尚未取出”误报为资源不存在。
    unzipSync(bytes, {
      filter: (entry) => {
        if (!entry.name.endsWith("/")) {
          this.directory.set(entry.name, {
            name: entry.name,
            compressedBytes: entry.size,
            expandedBytes: entry.originalSize,
          });
        }
        return false;
      },
    });
    const required = this.extract(["mimetype", "META-INF/container.xml"]);
    const mimeBytes = required.get("mimetype");
    if (!mimeBytes || strFromU8(mimeBytes).trim() !== "application/epub+zip") {
      throw new Error("不是有效的 EPUB：mimetype 内容错误");
    }
  }

  extract(paths: readonly string[]): Map<string, Uint8Array> {
    const wanted = new Set(paths);
    for (const path of wanted) {
      if (!this.directory.has(path)) throw new Error(`EPUB 资源不存在：${path}`);
    }
    if (!wanted.size) return new Map();
    const files = unzipSync(this.bytes, { filter: (entry) => wanted.has(entry.name) });
    return new Map(Object.entries(files));
  }

  close(): void {
    this.bytes = new Uint8Array(0);
    this.directory.clear();
  }
}

/**
 * Worker 发回结果时转移输出 buffer，避免再复制几百 MB。
 * 仅传 extract 的新结果；不可传给持有这些 buffer 的另一份缓存。
 */
export function outputTransferList(files: ReadonlyMap<string, Uint8Array>): ArrayBuffer[] {
  return [...new Set([...files.values()].map((data) => data.buffer as ArrayBuffer))];
}

/**
 * 一个 Worker 的后台请求分批，批间让消息循环处理显式目标。
 * 预算仅为调度单位，不是合法文件大小限制：超大单项单独处理。
 * 第一版 8MiB 解压字节/批；实机可调，不按书名或后缀硬编码。
 */
export function takeArchiveBatch(
  paths: readonly string[],
  directory: ReadonlyMap<string, ArchiveEntry>,
  budget = 8 * 1024 * 1024,
): string[] {
  const result: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const entry = directory.get(path);
    if (!entry) throw new Error(`EPUB 资源不存在：${path}`);
    if (result.length && bytes + entry.expandedBytes > budget) break;
    result.push(path);
    bytes += entry.expandedBytes;
  }
  return result;
}

export interface ArchiveClient {
  readonly directory: ReadonlyMap<string, ArchiveEntry>;
  extract(paths: readonly string[]): Promise<Map<string, Uint8Array>>;
  close(): void;
}

export class SyncArchiveClient implements ArchiveClient {
  private archive: SelectiveEpubArchive | null;

  constructor(bytes: Uint8Array) {
    this.archive = new SelectiveEpubArchive(bytes);
  }

  get directory(): ReadonlyMap<string, ArchiveEntry> {
    if (!this.archive) throw new Error("归档已关闭");
    return this.archive.directory;
  }

  async extract(paths: readonly string[]): Promise<Map<string, Uint8Array>> {
    if (!this.archive) throw new ArchiveClosedError();
    return this.archive.extract(paths);
  }

  close(): void {
    if (this.archive) {
      this.archive.close();
      this.archive = null;
    }
  }
}

export class WorkerArchiveClient implements ArchiveClient {
  private worker: Worker | null;
  readonly directory: Map<string, ArchiveEntry>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  constructor(worker: Worker, directory: ArchiveEntry[]) {
    this.worker = worker;
    this.directory = new Map(directory.map((entry) => [entry.name, entry]));
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, payload, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) {
        p.reject(new Error(error));
      } else {
        p.resolve(payload);
      }
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) {
        p.reject(new Error(`Worker error: ${e.message}`));
      }
      this.pending.clear();
    };
  }

  async extract(paths: readonly string[]): Promise<Map<string, Uint8Array>> {
    if (!this.worker) throw new ArchiveClosedError();
    const id = this.nextId++;
    return new Promise<Map<string, Uint8Array>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (entries: Array<[string, Uint8Array]>) => resolve(new Map(entries)),
        reject,
      });
      this.worker!.postMessage({ id, type: "extract", paths });
    });
  }

  close(): void {
    const closed = new ArchiveClosedError();
    for (const p of this.pending.values()) p.reject(closed);
    this.pending.clear();
    if (this.worker) {
      this.worker.postMessage({ type: "close" });
      this.worker.terminate();
      this.worker = null;
    }
    this.directory.clear();
  }
}

export async function createArchiveClient(bytes: Uint8Array): Promise<ArchiveClient> {
  if (typeof Worker !== "undefined") {
    try {
      const worker = new Worker(new URL("./archiveWorker.ts", import.meta.url), { type: "module" });
      const initPromise = new Promise<ArchiveClient>((resolve, reject) => {
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error("Worker 初始化超时"));
        }, 5000);
        worker.onmessage = (e: MessageEvent) => {
          clearTimeout(timeout);
          if (e.data?.type === "init:ok") {
            resolve(new WorkerArchiveClient(worker, e.data.directory));
          } else {
            worker.terminate();
            reject(new Error(e.data?.error || "Worker 初始化失败"));
          }
        };
        worker.onerror = (e) => {
          clearTimeout(timeout);
          worker.terminate();
          reject(new Error(e.message || "Worker 创建错误"));
        };
        worker.postMessage({ id: 0, type: "init", bytes });
      });
      return await initPromise;
    } catch {
      // Fallback to sync
    }
  }
  return new SyncArchiveClient(bytes);
}
