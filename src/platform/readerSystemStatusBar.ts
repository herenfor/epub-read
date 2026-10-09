export interface ReaderStatusBarIntent {
  readonly readerActive: boolean;
  readonly hideWhileReading: boolean;
  readonly supported: boolean;
}

export function shouldHideReaderSystemStatusBar(intent: ReaderStatusBarIntent): boolean {
  return intent.supported && intent.readerActive && intent.hideWhileReading;
}

/** One app-root owner. Serial native writes coalesce to the latest route intent. */
export function createReaderStatusBarCoordinator(applyHidden: (hidden: boolean) => Promise<void>) {
  let desired: boolean | undefined;
  let revision = 0;
  let acknowledgedRevision = 0;
  let pending: Promise<void> | undefined;

  async function drain(): Promise<void> {
    try {
      while (acknowledgedRevision !== revision) {
        const applyingRevision = revision;
        const hidden = desired!;
        try {
          await applyHidden(hidden);
        } catch (error) {
          // A failed obsolete intent cannot prevent the current route from being applied.
          if (applyingRevision !== revision) continue;
          throw error;
        }
        acknowledgedRevision = applyingRevision;
      }
    } finally {
      pending = undefined;
    }
  }

  return {
    /** force is for a fresh native window/rebinding, not every React render. */
    requestHidden(hidden: boolean, force = false): Promise<void> {
      if (desired !== hidden || force) {
        desired = hidden;
        revision += 1;
      }
      if (pending) return pending;
      if (acknowledgedRevision === revision) return Promise.resolve();
      // Start after assignment even if the driver throws synchronously.
      pending = Promise.resolve().then(drain);
      return pending;
    },
  };
}
