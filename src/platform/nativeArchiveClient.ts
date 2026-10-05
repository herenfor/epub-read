/** Native Android archive session client used by the reader and corpus Worker. */
import {
  ArchiveClosedError,
  type ArchiveClient,
  type ArchiveEntry,
} from "../core/selectiveArchive";

export type ArchiveInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

interface OpenInfo {
  protocolVersion: 1;
  sessionId: string;
  entryCount: number;
  chunkBytes: number;
}

interface NativeEntry extends ArchiveEntry {
  entryIndex: number;
}

interface DirectoryPage {
  entries: NativeEntry[];
  next: number | null;
}

const CHUNK_BYTES = 512 * 1024;

export async function createNativeArchiveClient(
  contentHash: string,
  invoke: ArchiveInvoke,
  signal?: AbortSignal,
): Promise<ArchiveClient> {
  if (signal?.aborted) throw new ArchiveClosedError();
  const info = await invoke<OpenInfo>("linked_library_archive_open", { contentHash });
  const client = new NativeArchiveClient(info, invoke, signal);
  try {
    if (info.protocolVersion !== 1 || info.chunkBytes !== CHUNK_BYTES) {
      throw new Error("原生归档协议不匹配");
    }
    await client.initialize();
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

class NativeArchiveClient implements ArchiveClient {
  readonly directory = new Map<string, NativeEntry>();

  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly shutdown: Promise<never>;
  private rejectShutdown!: (error: ArchiveClosedError) => void;
  private readonly onAbort = () => this.close();

  constructor(
    private readonly info: OpenInfo,
    private readonly invoke: ArchiveInvoke,
    private readonly signal?: AbortSignal,
  ) {
    this.shutdown = new Promise((_, reject) => {
      this.rejectShutdown = reject;
    });
    // Closing an idle client must not create an unhandled rejection.
    void this.shutdown.catch(() => undefined);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.close();
  }

  private requireOpen(): void {
    if (this.closed) throw new ArchiveClosedError();
  }

  async initialize(): Promise<void> {
    let start = 0;
    do {
      this.requireOpen();
      const page = await Promise.race([
        this.invoke<DirectoryPage>("linked_library_archive_directory", {
          sessionId: this.info.sessionId,
          start,
        }),
        this.shutdown,
      ]);
      this.requireOpen();
      for (const entry of page.entries) {
        if (!Number.isSafeInteger(entry.expandedBytes) || entry.expandedBytes < 0) {
          throw new Error("归档资源大小无法表示");
        }
        // Preserve the current archive's last-entry-wins duplicate-name mapping.
        this.directory.set(entry.name, entry);
      }
      const end = start + page.entries.length;
      if (page.next === null) {
        if (end !== this.info.entryCount) throw new Error("归档目录不完整");
        return;
      }
      if (page.next !== end || end <= start || end >= this.info.entryCount) {
        throw new Error("归档目录游标错误");
      }
      start = end;
    } while (true);
  }

  private readEntry(path: string): Promise<Uint8Array> {
    // Queue one entry, not an entire preload batch. Another request can run at
    // the resource boundary without interleaving two deflate cursors.
    const task = this.tail.then(async () => {
      this.requireOpen();
      const entry = this.directory.get(path);
      if (!entry) throw new Error("EPUB 资源不存在");
      // One destination per entry. No chunk array, concat or repeated copies.
      const bytes = new Uint8Array(entry.expandedBytes);
      let offset = 0;
      do {
        this.requireOpen();
        const buffer = await this.invoke<ArrayBuffer>("linked_library_archive_read", {
          sessionId: this.info.sessionId,
          entryIndex: entry.entryIndex,
          offset,
        });
        this.requireOpen();
        const chunk = new Uint8Array(buffer);
        const expected = Math.min(CHUNK_BYTES, entry.expandedBytes - offset);
        if (chunk.byteLength !== expected) throw new Error("归档资源分块长度错误");
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
        // Even an empty entry requires one native read for EOF/CRC validation.
      } while (offset < entry.expandedBytes);
      return bytes;
    });
    const checked = task.catch((error: unknown) => {
      this.close();
      throw error;
    });
    this.tail = checked.then(() => undefined, () => undefined);
    // Reject callers immediately on close; a late IPC reply cannot refill caches.
    return Promise.race([checked, this.shutdown]);
  }

  async extract(paths: readonly string[]): Promise<Map<string, Uint8Array>> {
    this.requireOpen();
    const result = new Map<string, Uint8Array>();
    for (const path of new Set(paths)) result.set(path, await this.readEntry(path));
    this.requireOpen();
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.directory.clear();
    this.rejectShutdown(new ArchiveClosedError());
    // The native close command removes the registry entry before replying;
    // window-destroy cleanup also owns pending opens and any remaining sessions.
    void this.invoke<void>("linked_library_archive_close", {
      sessionId: this.info.sessionId,
    }).catch(() => {
      console.warn("原生归档关闭请求失败；等待窗口会话清理");
    });
  }
}
