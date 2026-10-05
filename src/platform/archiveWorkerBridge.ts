/** Reuse NativeArchiveClient inside corpus Worker without calling Tauri there. */
import type { ArchiveInvoke } from "./nativeArchiveClient";

type Call = { id: number; command: string; args: Record<string, unknown> };
type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false };
const OPEN = "linked_library_archive_open";
const DIRECTORY = "linked_library_archive_directory";
const READ = "linked_library_archive_read";
const CLOSE = "linked_library_archive_close";

/** Window-side owner. Call dispose on done/error/cancel/Worker termination. */
export function serveArchivePort(
  port: MessagePort,
  contentHash: string,
  nativeInvoke: ArchiveInvoke,
): { dispose(): void } {
  let disposed = false;
  let sessionId: string | undefined;
  let reading = false;
  let opening = false;

  const release = (id: string): void => {
    void nativeInvoke<void>(CLOSE, { sessionId: id }).catch(() => {
      console.warn("建库归档关闭失败；等待窗口会话清理");
    });
  };
  const onMessage = async (event: MessageEvent<Call>): Promise<void> => {
    const { id, command, args } = event.data;
    if (disposed) return;
    let dataSlot = false;
    try {
      let value: unknown;
      if (command === OPEN) {
        if (opening || sessionId) throw new Error("重复打开归档");
        opening = true;
        try {
          // Worker cannot select a different book or a filesystem path.
          const info = await nativeInvoke<{ sessionId: string }>(OPEN, { contentHash });
          if (disposed) {
            release(info.sessionId);
            return;
          }
          sessionId = info.sessionId;
          value = info;
        } finally {
          opening = false;
        }
      } else if (command === CLOSE) {
        if (sessionId && args.sessionId === sessionId) {
          const closingId = sessionId;
          sessionId = undefined;
          await nativeInvoke<void>(CLOSE, { sessionId: closingId });
        } else if (sessionId) {
          throw new Error("归档会话不匹配");
        }
      } else if (command === READ || command === DIRECTORY) {
        if (!sessionId || args.sessionId !== sessionId || reading) {
          throw new Error("归档会话不可用");
        }
        reading = dataSlot = true;
        value = await nativeInvoke(command, { ...args, sessionId });
      } else {
        throw new Error("不支持的归档请求");
      }
      if (!disposed) {
        // Only the <=512KiB chunk is transferred, not an EPUB or entry copy.
        port.postMessage({ id, ok: true, value } satisfies Reply,
          value instanceof ArrayBuffer ? [value] : []);
      }
    } catch {
      if (!disposed) port.postMessage({ id, ok: false } satisfies Reply);
    } finally {
      if (dataSlot) reading = false;
    }
  };
  port.addEventListener("message", onMessage);
  port.start();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      port.removeEventListener("message", onMessage);
      port.close();
      const id = sessionId;
      sessionId = undefined;
      if (id) release(id);
      // Pending OPEN closes its newly returned handle in onMessage above.
    },
  };
}

/** Worker-side transport. Abort the client before closing this port. */
export function createArchivePortInvoke(port: MessagePort): {
  invoke: ArchiveInvoke;
  dispose(): void;
} {
  let nextId = 0;
  let disposed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const onMessage = (event: MessageEvent<Reply>): void => {
    const response = event.data;
    const call = pending.get(response.id);
    if (!call) return;
    pending.delete(response.id);
    if (response.ok) call.resolve(response.value);
    else call.reject(new Error("原生归档读取失败"));
  };
  port.addEventListener("message", onMessage);
  port.start();
  return {
    invoke: <T>(command: string, args: Record<string, unknown>): Promise<T> => {
      if (disposed) return Promise.reject(new Error("归档通道已关闭"));
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        try {
          port.postMessage({ id, command, args } satisfies Call);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      port.removeEventListener("message", onMessage);
      port.close();
      for (const call of pending.values()) call.reject(new Error("归档通道已关闭"));
      pending.clear();
    },
  };
}
