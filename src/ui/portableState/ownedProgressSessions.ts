/** Book-scoped progress session ownership core. */
export interface ProgressLease {
  readonly bookId: string;
  readonly generation: number;
}

interface OwnedSession<S> {
  readonly value: S;
  readonly release: (value: S) => Promise<void>;
  tail: Promise<void>;
  closing: Promise<void> | null;
}

/** A lease belongs to this instance; a book ID alone never authorizes cleanup. */
export class OwnedProgressSessions<S> {
  private sequence = 0;
  private readonly sessions = new Map<ProgressLease, OwnedSession<S>>();
  private readonly active = new Map<string, ProgressLease>();

  async prepare(
    bookId: string,
    acquire: () => Promise<S>,
    release: (value: S) => Promise<void>,
  ): Promise<ProgressLease> {
    const generation = ++this.sequence;
    // acquire must release any partially acquired read/basis on failure.
    const value = await acquire();
    const lease = Object.freeze({ bookId, generation });
    this.sessions.set(lease, { value, release, tail: Promise.resolve(), closing: null });
    return lease;
  }

  current(bookId: string): ProgressLease | undefined {
    return this.active.get(bookId);
  }

  /** Read-only payload access for callers that must capture book facts at acquisition. */
  payload(lease: ProgressLease): S | undefined {
    return this.sessions.get(lease)?.value;
  }

  has(lease: ProgressLease): boolean {
    return this.sessions.has(lease);
  }

  activate(lease: ProgressLease): void {
    const session = this.sessions.get(lease);
    if (!session || session.closing) throw new Error("阅读进度会话已关闭");
    const previous = this.active.get(lease.bookId);
    if (previous && previous !== lease) {
      throw new Error("旧阅读会话尚未完成保存和释放");
    }
    this.active.set(lease.bookId, lease);
  }

  /** Serialize writes and stale-basis rebinds within the exact same session. */
  run<T>(lease: ProgressLease, task: (value: S) => Promise<T>): Promise<T> {
    const session = this.sessions.get(lease);
    if (!session || session.closing || this.active.get(lease.bookId) !== lease) {
      return Promise.reject(new Error("阅读进度会话已关闭或不是当前会话"));
    }
    const result = session.tail.then(() => {
      if (session.closing || this.active.get(lease.bookId) !== lease) {
        throw new Error("阅读进度会话已关闭或不是当前会话");
      }
      return task(session.value);
    });
    session.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Prepared candidates may be closed too. No local-record lookup is needed. */
  close(lease: ProgressLease): Promise<void> {
    const session = this.sessions.get(lease);
    if (!session) return Promise.resolve();
    if (session.closing) return session.closing;
    session.closing = (async () => {
      // A started write/rebind gets to finish before its owned handles release.
      await session.tail;
      try {
        await session.release(session.value);
      } finally {
        if (this.active.get(lease.bookId) === lease) this.active.delete(lease.bookId);
        this.sessions.delete(lease);
      }
    })();
    return session.closing;
  }
}
