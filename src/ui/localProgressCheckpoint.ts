/** Local-only recovery evidence, never a portable v3 event or an IPC basis ID. */
export interface LocalProgressCheckpoint<P> {
  readonly schemaVersion: 1;
  readonly checkpointId: string;
  readonly bookHash: string;
  readonly shownStamp: { readonly deviceId: string; readonly counter: number } | null;
  readonly patch: P;
}

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One small record per book. A delayed acknowledgment must not erase a newer one. */
export class LocalProgressCheckpoints<P> {
  constructor(
    private readonly storage: StoragePort,
    private readonly parse: (value: unknown) => LocalProgressCheckpoint<P>,
    private readonly makeId: () => string = () => crypto.randomUUID(),
  ) {}

  private key(bookHash: string): string {
    return `epub-reader:progress-pending:${bookHash}`;
  }

  put(
    bookHash: string,
    shownStamp: LocalProgressCheckpoint<P>["shownStamp"],
    patch: P,
  ): LocalProgressCheckpoint<P> {
    const checkpoint: LocalProgressCheckpoint<P> = {
      schemaVersion: 1, checkpointId: this.makeId(), bookHash, shownStamp, patch,
    };
    // Serialization makes a stable snapshot; storage errors must reach the UI.
    const serialized = JSON.stringify(checkpoint);
    this.storage.setItem(this.key(bookHash), serialized);
    return this.parse(JSON.parse(serialized));
  }

  peek(bookHash: string): LocalProgressCheckpoint<P> | null {
    const serialized = this.storage.getItem(this.key(bookHash));
    if (serialized === null) return null;
    const checkpoint = this.parse(JSON.parse(serialized));
    if (checkpoint.bookHash !== bookHash) throw new Error("本机进度恢复记录不匹配");
    return checkpoint;
  }

  acknowledge(bookHash: string, checkpointId: string): boolean {
    if (this.peek(bookHash)?.checkpointId !== checkpointId) return false;
    this.storage.removeItem(this.key(bookHash));
    return true;
  }

  /** Explicit book deletion only; routine cleanup must use acknowledge. */
  remove(bookHash: string): void {
    this.storage.removeItem(this.key(bookHash));
  }
}
