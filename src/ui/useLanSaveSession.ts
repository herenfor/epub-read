import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptLanSave,
  cancelLanSaveTransfer,
  closeLanSave,
  commitLanSave,
  hostLanSave,
  joinLanSave,
  lanSaveErrorCode,
  lanSaveErrorMessage,
  sendLanSave,
  type LanCloseResult,
  type LanOfferSummary,
  type LanProgress,
  type LanSaveEvent,
  type LanSendResult,
  type SaveExportScope,
  type SaveFileCommitResult,
  type SaveFilePrepareResult,
} from "../platform/lanSaveNativeBridge";
import { uiPlural, uiText } from "./localization/UiLanguageProvider";

export type LanSaveSessionStatus =
  | "idle"
  | "startingHost"
  | "hostReady"
  | "joining"
  | "connected"
  | "sending"
  | "receiving"
  | "preparing"
  | "preview"
  | "committing"
  /** A batch ended; both devices are releasing it before the next `ready`. */
  | "settling"
  | "closed";

/** Outcome of the last finished batch, shown above the connected page. */
export type LanBatchResult =
  | { kind: "sent"; send: LanSendResult }
  | { kind: "sentUnconfirmed"; send: LanSendResult }
  | { kind: "sendCancelled"; send: LanSendResult }
  | { kind: "sendFailed"; send: LanSendResult }
  | { kind: "imported"; commit: SaveFileCommitResult }
  | { kind: "importCancelled" };

export interface LanSaveSessionState {
  status: LanSaveSessionStatus;
  role: "host" | "join" | null;
  sessionId: string | null;
  transferId: string | null;
  /** Raw host pairing info. Kept only in memory; never logged or persisted. */
  pairingInfo: string | null;
  busy: boolean;
  closing: boolean;
  cancelTooLate: boolean;
  error: string | null;
  errorCode: string | null;
  notice: string | null;
  /** An offer still waiting for accept (auto-accept failed or is pending). */
  offer: LanOfferSummary | null;
  /** The offer of the batch being received, kept for the progress hint. */
  incoming: LanOfferSummary | null;
  progress: LanProgress | null;
  preview: SaveFilePrepareResult | null;
  lastResult: LanBatchResult | null;
}

export interface UseLanSaveSessionOptions {
  /**
   * Runs the caller's existing native-export preflight and returns only the
   * resolved scope. The hook must not invoke `lan_save_send` when this throws
   * or when the session has already been cancelled meanwhile.
   */
  prepareSend(scopeChoice: "all" | "selected", includeBooks: boolean): Promise<SaveExportScope>;
  /** Reuse the caller's existing F-N commit side effects (refresh projection, preferences). */
  onImportCommitted(result: SaveFileCommitResult, applyPreferences: boolean): Promise<void>;
}

export interface UseLanSaveSessionResult {
  state: LanSaveSessionState;
  active: boolean;
  startHost(bindIp?: string): Promise<void>;
  join(pairingInfo: string): Promise<void>;
  send(scopeChoice: "all" | "selected", includeBooks: boolean): Promise<void>;
  accept(): Promise<void>;
  /** Drops only the current batch (pending offer or preview); the connection stays. */
  cancelTransfer(): Promise<void>;
  commit(applyPreferences: boolean): Promise<void>;
  /** Ends the whole connection. */
  close(): Promise<void>;
}

const INITIAL_STATE: LanSaveSessionState = {
  status: "idle",
  role: null,
  sessionId: null,
  transferId: null,
  pairingInfo: null,
  busy: false,
  closing: false,
  cancelTooLate: false,
  error: null,
  errorCode: null,
  notice: null,
  offer: null,
  incoming: null,
  progress: null,
  preview: null,
  lastResult: null,
};

function parseOfferSummary(value: unknown): LanOfferSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const archiveBytes = record.archiveBytes;
  const bookBytes = record.bookBytes;
  const bookCount = record.bookCount;
  const attachedBookCount = record.attachedBookCount;
  const reusedBookCount = record.reusedBookCount;
  const includeBooks = record.includeBooks;
  const hasPreferences = record.hasPreferences;
  const skippedBookCount = record.skippedBookCount;
  if (
    typeof archiveBytes !== "number" || !Number.isFinite(archiveBytes) ||
    typeof bookBytes !== "number" || !Number.isFinite(bookBytes) ||
    typeof bookCount !== "number" || !Number.isInteger(bookCount) ||
    typeof attachedBookCount !== "number" || !Number.isInteger(attachedBookCount) ||
    typeof reusedBookCount !== "number" || !Number.isInteger(reusedBookCount) ||
    typeof includeBooks !== "boolean" ||
    typeof hasPreferences !== "boolean" ||
    typeof skippedBookCount !== "number" || !Number.isInteger(skippedBookCount)
  ) {
    return null;
  }
  return {
    archiveBytes,
    bookBytes,
    bookCount,
    attachedBookCount,
    reusedBookCount,
    includeBooks,
    hasPreferences,
    skippedBookCount,
  };
}

export function useLanSaveSession(options: UseLanSaveSessionOptions): UseLanSaveSessionResult {
  const [state, setState] = useState<LanSaveSessionState>(INITIAL_STATE);
  const stateRef = useRef<LanSaveSessionState>(INITIAL_STATE);
  const generationRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const transferIdRef = useRef<string | null>(null);
  const cancelWantedRef = useRef(false);
  const closeRef = useRef<{ sessionId: string; promise: Promise<LanCloseResult> } | null>(null);
  const busyRef = useRef(false);
  const launchPendingRef = useRef(false);
  const operationRef = useRef<"send" | "accept" | "commit" | "cancel" | null>(null);
  /** The transferId already auto-accepted; each real offer is accepted once. */
  const autoAcceptedRef = useRef<string | null>(null);
  const acceptRef = useRef<() => Promise<void>>(async () => undefined);
  const closeFinishedRef = useRef(false);
  const peerEndedRef = useRef(false);
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const updateState = useCallback((
    patch: Partial<LanSaveSessionState> | ((previous: LanSaveSessionState) => Partial<LanSaveSessionState>),
  ): void => {
    const previous = stateRef.current;
    const next: LanSaveSessionState = {
      ...previous,
      ...(typeof patch === "function" ? patch(previous) : patch),
    };
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  // L1: an offer goes straight to receiving and the import preview, whose
  // 确认导入 stays the only confirmation. Runs at most once per transferId;
  // a failed (busy) accept leaves the offer for the manual 接收 button.
  const scheduleAutoAccept = useCallback((): void => {
    queueMicrotask(() => {
      const transferId = transferIdRef.current;
      const current = stateRef.current;
      if (!transferId || !current.offer || current.status !== "receiving") return;
      if (autoAcceptedRef.current === transferId) return;
      if (busyRef.current || launchPendingRef.current || cancelWantedRef.current) return;
      autoAcceptedRef.current = transferId;
      void acceptRef.current();
    });
  }, []);

  /** Whether the batch an invoke started for still owns the screen. */
  const ownsScreen = useCallback((transferId: string): boolean => transferIdRef.current === transferId, []);

  /**
   * Applies a batch invoke's result. `ready` may reach JS before that invoke
   * returns; `ready` already cleared the old screen, so a late result only
   * records itself as the previous batch and releases busy. Ownership is the
   * transferId, never the status name: the next batch reuses the same ones.
   */
  const finishBatch = useCallback((
    transferId: string,
    lastResult: LanBatchResult,
    ownPatch: Partial<LanSaveSessionState>,
  ): void => {
    if (peerEndedRef.current || stateRef.current.status === "closed") {
      updateState({
        status: "closed", busy: false, offer: null, incoming: null, preview: null, progress: null, lastResult,
      });
    } else if (!ownsScreen(transferId)) {
      updateState({ busy: false, lastResult });
    } else {
      updateState({
        status: "settling", busy: false, offer: null, incoming: null, preview: null, progress: null,
        ...ownPatch,
        lastResult,
      });
    }
  }, [ownsScreen, updateState]);

  const resetToIdle = useCallback((): void => {
    // A close acknowledgement does not settle an outstanding IPC result. Keep
    // this generation owned until startup/actions, especially commit, finish.
    if (launchPendingRef.current || operationRef.current) return;
    generationRef.current += 1;
    sessionIdRef.current = null;
    transferIdRef.current = null;
    cancelWantedRef.current = false;
    closeRef.current = null;
    busyRef.current = false;
    closeFinishedRef.current = false;
    peerEndedRef.current = false;
    autoAcceptedRef.current = null;
    stateRef.current = INITIAL_STATE;
    if (mountedRef.current) setState(INITIAL_STATE);
  }, []);

  const requestCloseForSession = useCallback(async (sessionId: string): Promise<LanCloseResult> => {
    cancelWantedRef.current = true;
    const existing = closeRef.current;
    if (existing?.sessionId === sessionId) return existing.promise;

    const generation = generationRef.current;
    updateState({ closing: true });
    const promise = closeLanSave(sessionId);
    closeRef.current = { sessionId, promise };
    try {
      const result = await promise;
      if (generationRef.current !== generation) return result;
      if (result.status === "too-late") {
        updateState({
          closing: false,
          cancelTooLate: true,
          notice: uiText("lan.notice.committing"),
        });
      } else {
        closeFinishedRef.current = true;
        updateState({ closing: false });
        resetToIdle();
      }
      return result;
    } catch (error) {
      if (generationRef.current !== generation) throw error;
      if (closeRef.current?.sessionId === sessionId) closeRef.current = null;
      const code = lanSaveErrorCode(error);
      if (code === "not-found") {
        closeFinishedRef.current = true;
        updateState({ closing: false });
        resetToIdle();
        return { status: "already-finished" };
      }
      updateState({
        closing: false,
        error: lanSaveErrorMessage(error),
        errorCode: code,
      });
      throw error;
    }
  }, [resetToIdle, updateState]);

  const makeEventHandler = useCallback((generation: number) => {
    return (event: LanSaveEvent): void => {
      if (generationRef.current !== generation) return;

      if (!sessionIdRef.current) {
        sessionIdRef.current = event.sessionId;
        updateState({ sessionId: event.sessionId });
        if (cancelWantedRef.current) {
          void requestCloseForSession(event.sessionId).catch(() => undefined);
          return;
        }
      } else if (event.sessionId !== sessionIdRef.current) {
        return;
      }

      if (cancelWantedRef.current && operationRef.current !== "commit") return;

      // `ready` carries the NEW id; accept it only as the successor of the
      // batch we know, then drop every later frame of the old id.
      if (event.event === "ready") {
        const summary = event.summary as { previousTransferId?: unknown } | undefined;
        if (!event.transferId || summary?.previousTransferId !== transferIdRef.current) return;
        const nextTransferId = event.transferId;
        transferIdRef.current = nextTransferId;
        updateState((current) => {
          if (current.status === "closed") return { transferId: nextTransferId };
          // The old batch's screen ends here. A still-pending invoke of that
          // batch keeps busy (one native call at a time) but owns nothing else.
          return {
            transferId: nextTransferId,
            status: "connected",
            busy: operationRef.current !== null,
            offer: null,
            incoming: null,
            progress: null,
            preview: null,
          };
        });
        return;
      }

      if (event.transferId) {
        const knownTransferId = transferIdRef.current;
        if (!knownTransferId) {
          transferIdRef.current = event.transferId;
          updateState({ transferId: event.transferId });
        } else if (knownTransferId !== event.transferId) {
          return;
        }
      }

      const current = stateRef.current;
      if (current.status === "closed") return;
      switch (event.event) {
        case "pairing":
          break;
        case "paired":
          updateState({
            status: "connected",
            role: current.role ?? "join",
            busy: false,
            error: null,
            errorCode: null,
            notice: uiText("lan.notice.connected"),
          });
          break;
        case "offered": {
          const offer = parseOfferSummary(event.summary);
          if (offer) {
            updateState({
              status: "receiving",
              offer,
              incoming: offer,
              progress: null,
              lastResult: null,
              error: null,
              errorCode: null,
              notice: null,
            });
            scheduleAutoAccept();
          }
          break;
        }
        case "exporting":
          updateState({
            status: "sending",
            offer: null,
            progress: event.progress ?? current.progress,
            error: null,
            errorCode: null,
          });
          break;
        case "receiving":
          updateState({
            status: "receiving",
            progress: event.progress ?? current.progress,
          });
          break;
        case "preparing":
          updateState({
            status: "preparing",
            progress: event.progress ?? current.progress,
          });
          break;
        case "preview":
          // The accept() promise is the single source of truth for the prepared DTO.
          break;
        case "committing":
          updateState({
            status: "committing",
            progress: event.progress ?? current.progress,
          });
          break;
        case "completed":
          // The send/commit promise owns the terminal result.
          break;
        case "cancelled":
          // Our own cancelTransfer() owns its result; otherwise the batch was
          // dropped natively and the connection waits for `ready`.
          if (!operationRef.current && (current.status === "receiving" || current.status === "preview")) {
            updateState({
              status: "settling", busy: false, offer: null, incoming: null, preview: null, progress: null,
              lastResult: { kind: "importCancelled" },
            });
          }
          break;
        case "closed":
        case "error":
          peerEndedRef.current = true;
          if (operationRef.current || launchPendingRef.current) {
            updateState({ notice: event.message ?? uiText("lan.notice.endedWaiting") });
          } else {
            // A prepared import is gone after peer EOF/background cancellation.
            // Never leave an actionable preview for a discarded native job.
            updateState({
              status: "closed", busy: false, offer: null, preview: null,
              notice: event.message ?? uiText("lan.notice.ended"),
              error: event.event === "error" ? event.message ?? uiText("lan.notice.failed") : null,
              errorCode: event.code ?? null,
            });
          }
          break;
        default:
          break;
      }
    };
  }, [requestCloseForSession, scheduleAutoAccept, updateState]);

  const failToIdle = useCallback((error: unknown): void => {
    const code = lanSaveErrorCode(error);
    const message = lanSaveErrorMessage(error);
    launchPendingRef.current = false;
    closeFinishedRef.current = false;
    peerEndedRef.current = false;
    generationRef.current += 1;
    sessionIdRef.current = null;
    transferIdRef.current = null;
    cancelWantedRef.current = false;
    closeRef.current = null;
    busyRef.current = false;
    autoAcceptedRef.current = null;
    const next: LanSaveSessionState = {
      ...INITIAL_STATE,
      error: message,
      errorCode: code,
    };
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const startHost = useCallback(async (bindIp?: string): Promise<void> => {
    if (busyRef.current || stateRef.current.status !== "idle") return;
    busyRef.current = true;
    launchPendingRef.current = true;
    closeFinishedRef.current = false;
    peerEndedRef.current = false;
    cancelWantedRef.current = false;
    closeRef.current = null;
    sessionIdRef.current = null;
    transferIdRef.current = null;
    autoAcceptedRef.current = null;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    updateState({
      ...INITIAL_STATE,
      status: "startingHost",
      role: "host",
      busy: true,
    });

    try {
      const result = await hostLanSave({
        bindIp: bindIp?.trim() || undefined,
        onEvent: makeEventHandler(generation),
      });
      if (generationRef.current !== generation) return;
      if (cancelWantedRef.current) {
        sessionIdRef.current = result.sessionId;
        updateState({ sessionId: result.sessionId });
        await requestCloseForSession(result.sessionId).catch(() => undefined);
        return;
      }
      sessionIdRef.current = result.sessionId;
      if (peerEndedRef.current) { updateState({ status: "closed", busy: false }); return; }
      updateState((current) => ({
        status: current.status === "startingHost" ? "hostReady" : current.status,
        role: "host",
        sessionId: result.sessionId,
        pairingInfo: result.pairingInfo,
        busy: false,
        error: null,
        errorCode: null,
        notice: null,
      }));
    } catch (error) {
      if (generationRef.current !== generation) return;
      if (cancelWantedRef.current) {
        const sessionId = sessionIdRef.current;
        if (sessionId) await requestCloseForSession(sessionId).catch(() => undefined);
        else resetToIdle();
        return;
      }
      failToIdle(error);
    } finally {
      if (generationRef.current === generation) {
        launchPendingRef.current = false;
        busyRef.current = false;
        if (cancelWantedRef.current && (closeFinishedRef.current || !sessionIdRef.current)) resetToIdle();
        else scheduleAutoAccept();
      }
    }
  }, [failToIdle, makeEventHandler, requestCloseForSession, resetToIdle, scheduleAutoAccept, updateState]);

  const join = useCallback(async (pairingInfo: string): Promise<void> => {
    if (busyRef.current || stateRef.current.status !== "idle") return;
    const trimmed = pairingInfo.trim();
    if (!trimmed) {
      updateState({ error: uiText("lan.notice.pasteFirst"), errorCode: "invalid-request" });
      return;
    }

    busyRef.current = true;
    launchPendingRef.current = true;
    closeFinishedRef.current = false;
    peerEndedRef.current = false;
    cancelWantedRef.current = false;
    closeRef.current = null;
    sessionIdRef.current = null;
    transferIdRef.current = null;
    autoAcceptedRef.current = null;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    updateState({
      ...INITIAL_STATE,
      status: "joining",
      role: "join",
      busy: true,
    });

    try {
      const result = await joinLanSave({
        pairingInfo: trimmed,
        onEvent: makeEventHandler(generation),
      });
      if (generationRef.current !== generation) return;
      if (cancelWantedRef.current) {
        sessionIdRef.current = result.sessionId;
        updateState({ sessionId: result.sessionId });
        await requestCloseForSession(result.sessionId).catch(() => undefined);
        return;
      }
      if (!sessionIdRef.current) sessionIdRef.current = result.sessionId;
      if (peerEndedRef.current) { updateState({ status: "closed", busy: false }); return; }
      updateState((current) => ({
        status: current.status === "joining" ? "connected" : current.status,
        role: "join",
        sessionId: result.sessionId,
        busy: false,
        error: null,
        errorCode: null,
        notice: uiText("lan.notice.connected"),
      }));
    } catch (error) {
      if (generationRef.current !== generation) return;
      if (cancelWantedRef.current) {
        const sessionId = sessionIdRef.current;
        if (sessionId) await requestCloseForSession(sessionId).catch(() => undefined);
        else resetToIdle();
        return;
      }
      failToIdle(error);
    } finally {
      if (generationRef.current === generation) {
        launchPendingRef.current = false;
        busyRef.current = false;
        if (cancelWantedRef.current && (closeFinishedRef.current || !sessionIdRef.current)) resetToIdle();
        else scheduleAutoAccept();
      }
    }
  }, [failToIdle, makeEventHandler, requestCloseForSession, resetToIdle, scheduleAutoAccept, updateState]);

  const send = useCallback(async (
    scopeChoice: "all" | "selected",
    includeBooks: boolean,
  ): Promise<void> => {
    if (busyRef.current || launchPendingRef.current || cancelWantedRef.current) return;
    const previous = stateRef.current;
    const sessionId = sessionIdRef.current;
    const transferId = transferIdRef.current;
    if (!sessionId || !transferId || previous.status !== "connected") return;

    busyRef.current = true;
    operationRef.current = "send";
    const generation = generationRef.current;
    updateState({
      status: "sending",
      busy: true,
      offer: null,
      incoming: null,
      progress: null,
      error: null,
      errorCode: null,
      notice: null,
      lastResult: null,
    });

    let invokedNative = false;
    try {
      const scope = await optionsRef.current.prepareSend(scopeChoice, includeBooks);
      if (generationRef.current !== generation || cancelWantedRef.current || peerEndedRef.current) return;
      invokedNative = true;
      const result = await sendLanSave(sessionId, scope, includeBooks);
      if (generationRef.current !== generation) return;

      let lastResult: LanBatchResult = { kind: "sendFailed", send: result };
      let notice: string | null = result.message ?? uiText("lan.notice.sendFailed");
      let error: string | null = null;
      let errorCode: string | null = null;
      if (result.status === "completed") {
        lastResult = { kind: "sent", send: result };
        notice = uiText("lan.notice.peerImported");
      } else if (result.status === "unconfirmed") {
        lastResult = { kind: "sentUnconfirmed", send: result };
        notice = uiText("lan.notice.peerUnconfirmed");
      } else if (result.status === "cancelled") {
        lastResult = { kind: "sendCancelled", send: result };
        notice = result.message ?? uiText("lan.notice.sendCancelled");
      } else {
        error = result.message ?? uiText("lan.notice.sendFailed");
        errorCode = result.code;
      }

      finishBatch(transferId, lastResult, { error, errorCode, notice });
    } catch (error) {
      if (generationRef.current !== generation) return;
      if (cancelWantedRef.current) return;
      if (!ownsScreen(transferId)) { updateState({ busy: false }); return; }
      const retry = (!invokedNative || lanSaveErrorCode(error) === "busy") && !peerEndedRef.current;
      updateState({
        status: retry ? previous.status : "closed",
        busy: false,
        offer: retry ? previous.offer : null,
        preview: null,
        progress: retry ? previous.progress : null,
        error: lanSaveErrorMessage(error),
        errorCode: lanSaveErrorCode(error),
      });
    } finally {
      if (generationRef.current === generation) {
        operationRef.current = null;
        busyRef.current = false;
        if (peerEndedRef.current && ["sending", "receiving", "preparing"].includes(stateRef.current.status)) {
          updateState({ status: "closed", busy: false, preview: null, offer: null });
        }
        if (cancelWantedRef.current && closeFinishedRef.current) resetToIdle();
        else scheduleAutoAccept();
      }
    }
  }, [resetToIdle, scheduleAutoAccept, finishBatch, ownsScreen, updateState]);

  const accept = useCallback(async (): Promise<void> => {
    if (busyRef.current || launchPendingRef.current || cancelWantedRef.current) return;
    const previous = stateRef.current;
    const sessionId = sessionIdRef.current;
    const transferId = transferIdRef.current;
    if (!sessionId || !transferId || !previous.offer) return;

    busyRef.current = true;
    operationRef.current = "accept";
    autoAcceptedRef.current = transferId;
    const generation = generationRef.current;
    updateState({
      status: "receiving",
      busy: true,
      offer: null,
      progress: null,
      error: null,
      errorCode: null,
      notice: null,
    });

    try {
      const preview = await acceptLanSave(sessionId, transferId);
      if (generationRef.current !== generation) return;
      if (peerEndedRef.current) {
        updateState({ status: "closed", busy: false, preview: null, offer: null });
        return;
      }
      updateState({
        status: "preview",
        preview,
        busy: false,
        error: null,
        errorCode: null,
        notice: null,
      });
    } catch (error) {
      if (generationRef.current !== generation) return;
      if (cancelWantedRef.current) return;
      const retry = (lanSaveErrorCode(error) === "busy") && !peerEndedRef.current;
      updateState({
        status: retry ? previous.status : "closed",
        busy: false,
        offer: retry ? previous.offer : null,
        preview: null,
        progress: retry ? previous.progress : null,
        error: lanSaveErrorMessage(error),
        errorCode: lanSaveErrorCode(error),
      });
    } finally {
      if (generationRef.current === generation) {
        operationRef.current = null;
        busyRef.current = false;
        if (peerEndedRef.current && ["sending", "receiving", "preparing"].includes(stateRef.current.status)) {
          updateState({ status: "closed", busy: false, preview: null, offer: null });
        }
        if (cancelWantedRef.current && closeFinishedRef.current) resetToIdle();
      }
    }
  }, [resetToIdle, updateState]);
  acceptRef.current = accept;

  const cancelTransfer = useCallback(async (): Promise<void> => {
    if (busyRef.current || launchPendingRef.current || cancelWantedRef.current) return;
    const previous = stateRef.current;
    const sessionId = sessionIdRef.current;
    const transferId = transferIdRef.current;
    if (!sessionId || !transferId) return;
    if (previous.status !== "preview" && !(previous.status === "receiving" && previous.offer)) return;

    busyRef.current = true;
    operationRef.current = "cancel";
    const generation = generationRef.current;
    updateState({ busy: true, error: null, errorCode: null });

    try {
      const result = await cancelLanSaveTransfer(sessionId, transferId);
      if (generationRef.current !== generation) return;
      if (result.status === "too-late" && ownsScreen(transferId)) {
        // The commit was already accepted natively; wait for its real result.
        updateState({
          status: "committing",
          busy: false,
          offer: null,
          preview: null,
          cancelTooLate: true,
          notice: uiText("lan.notice.committing"),
        });
        return;
      }
      if (result.status === "too-late") {
        // The old commit already finished natively; nothing to show for it.
        updateState({ busy: false });
        return;
      }
      finishBatch(transferId, { kind: "importCancelled" }, {});
    } catch (error) {
      if (generationRef.current !== generation) return;
      if (!ownsScreen(transferId) && !peerEndedRef.current) { updateState({ busy: false }); return; }
      const code = lanSaveErrorCode(error);
      const ended = code === "not-found" || peerEndedRef.current;
      updateState({
        status: ended ? "closed" : previous.status,
        busy: false,
        offer: ended ? null : previous.offer,
        preview: ended ? null : previous.preview,
        error: lanSaveErrorMessage(error),
        errorCode: code,
      });
    } finally {
      if (generationRef.current === generation) {
        operationRef.current = null;
        busyRef.current = false;
        if (cancelWantedRef.current && closeFinishedRef.current) resetToIdle();
        else scheduleAutoAccept();
      }
    }
  }, [resetToIdle, scheduleAutoAccept, finishBatch, ownsScreen, updateState]);

  const commit = useCallback(async (applyPreferences: boolean): Promise<void> => {
    if (busyRef.current || launchPendingRef.current || cancelWantedRef.current) return;
    const previous = stateRef.current;
    const sessionId = sessionIdRef.current;
    const transferId = transferIdRef.current;
    if (!sessionId || !transferId || !previous.preview) return;

    busyRef.current = true;
    operationRef.current = "commit";
    const generation = generationRef.current;
    const preview = previous.preview;
    updateState({
      status: "committing",
      preview: null,
      busy: true,
      progress: null,
      error: null,
      errorCode: null,
      notice: null,
    });

    try {
      const result = await commitLanSave(sessionId, transferId, applyPreferences);
      // A real committed result must refresh the repository even after close.
      try {
        await optionsRef.current.onImportCommitted(result, applyPreferences);
      } catch {
        // The commit result is already truthful; callers report projection refresh failures separately.
      }
      if (generationRef.current !== generation) return;
      const closedMeanwhile = cancelWantedRef.current;
      if (closedMeanwhile) {
        // A too-late close left the real commit running. Once it finishes, let a
        // later close/reconnect observe the final native state instead of reusing
        // the resolved too-late promise.
        closeRef.current = null;
        cancelWantedRef.current = false;
        closeFinishedRef.current = false;
      }
      const imported: LanBatchResult = { kind: "imported", commit: result };
      if (closedMeanwhile) {
        updateState({
          status: "closed", busy: false, offer: null, incoming: null, preview: null, progress: null,
          lastResult: imported,
        });
      } else {
        finishBatch(transferId, imported, {
          error: null,
          errorCode: null,
          notice: uiPlural("lan.notice.imported", result.importedBooks.length, { count: result.importedBooks.length }),
        });
      }
    } catch (error) {
      if (generationRef.current !== generation) return;
      if (!ownsScreen(transferId) && !peerEndedRef.current && !cancelWantedRef.current) {
        updateState({ busy: false });
        return;
      }
      const retry = lanSaveErrorCode(error) === "busy" && !peerEndedRef.current && !cancelWantedRef.current;
      updateState({
        status: retry ? "preview" : "closed",
        preview: retry ? preview : null,
        busy: false,
        error: lanSaveErrorMessage(error),
        errorCode: lanSaveErrorCode(error),
      });
      if (!retry) { closeRef.current = null; cancelWantedRef.current = false; }
    } finally {
      if (generationRef.current === generation) {
        operationRef.current = null;
        busyRef.current = false;
        if (cancelWantedRef.current && closeFinishedRef.current) resetToIdle();
        else scheduleAutoAccept();
      }
    }
  }, [resetToIdle, scheduleAutoAccept, finishBatch, ownsScreen, updateState]);

  const close = useCallback(async (): Promise<void> => {
    if (stateRef.current.status === "idle") return;
    cancelWantedRef.current = true;
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      updateState({ closing: true });
      return;
    }
    await requestCloseForSession(sessionId).catch(() => undefined);
  }, [requestCloseForSession, updateState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // StrictMode's immediate setup cancels this deferred cleanup. A real
      // unmount still closes its own run, including a pending host/join.
      queueMicrotask(() => {
        if (!mountedRef.current) void close();
      });
    };
  }, [close]);

  return {
    state,
    active: state.busy || state.closing || [
      "startingHost", "hostReady", "joining", "connected", "sending",
      "receiving", "preparing", "preview", "committing", "settling",
    ].includes(state.status),
    startHost,
    join,
    send,
    accept,
    cancelTransfer,
    commit,
    close,
  };
}
