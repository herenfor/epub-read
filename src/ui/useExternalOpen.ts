import { useCallback, useEffect, useRef, useState } from "react";
import { acknowledgeExternalOpen, listenForExternalOpen, peekExternalOpen, type ExternalOpenRequest } from "../platform/externalOpenBridge";
import { ExternalOpenPump, type ExternalOpenOutcome } from "./externalOpenPump";

/**
 * App-level host for books the system hands over ("open with", file
 * association). Lives above the shelf/reader so opening a book never drops
 * the listener; `process` decides per request whether it can run now.
 */
export function useExternalOpen({ platform, process, onError }: {
  /** null: no native queue (browser preview). */
  platform: "android" | "desktop" | null;
  process(request: ExternalOpenRequest): Promise<ExternalOpenOutcome>;
  onError(error: unknown): void;
}) {
  const processRef = useRef(process);
  processRef.current = process;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const pumpRef = useRef<ExternalOpenPump | null>(null);
  const [failed, setFailed] = useState<ExternalOpenRequest | null>(null);

  useEffect(() => {
    if (!platform) return;
    const pump = new ExternalOpenPump({
      peek: peekExternalOpen,
      acknowledge: acknowledgeExternalOpen,
      process: (request) => processRef.current(request),
      onFailed: setFailed,
      onError: (error) => onErrorRef.current(error),
    });
    pumpRef.current = pump;
    let unlisten: (() => Promise<void>) | null = null;
    let disposed = false;
    // Subscribe first, then look: a request queued before the listener is still found.
    listenForExternalOpen(platform, () => pump.notify())
      .then((cleanup) => {
        if (disposed) void cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => onErrorRef.current(error))
      .finally(() => {
        if (!disposed) pump.notify();
      });
    return () => {
      disposed = true;
      pump.stop();
      pumpRef.current = null;
      void unlisten?.();
    };
  }, [platform]);

  /** Call when shelf/reader state changes; a waiting request gets another try. */
  const kick = useCallback((): void => pumpRef.current?.kick(), []);
  const retry = useCallback((): void => pumpRef.current?.retry(), []);
  const dismiss = useCallback((): void => {
    void pumpRef.current?.dismiss();
  }, []);

  return { failed, kick, retry, dismiss };
}
