import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptLanSave,
  closeLanSave,
  commitLanSave,
  hostLanSave,
  joinLanSave,
  lanSaveErrorCode,
  lanSaveErrorMessage,
  sendLanSave,
  type LanCloseResult,
  type LanCommitSummary,
  type LanOfferSummary,
  type LanProgress,
  type LanSaveEvent,
  type LanSendResult,
  type SaveExportScope,
  type SaveFileCommitResult,
  type SaveFilePrepareResult,
} from "../platform/lanSaveNativeBridge";

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
  | "sendComplete"
  | "sendUnconfirmed"
  | "sendCancelled"
  | "sendFailed"
  | "commitComplete"
  | "closed";

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
  offer: LanOfferSummary | null;
  progress: LanProgress | null;
  preview: SaveFilePrepareResult | null;
  sendResult: LanSendResult | null;
  remoteCommit: LanCommitSummary | null;
  localCommit: SaveFileCommitResult | null;
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
  decline(): Promise<void>;
  commit(applyPreferences: boolean): Promise<void>;
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
  progress: null,
  preview: null,
  sendResult: null,
  remoteCommit: null,
  localCommit: null,
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
  const operationRef = useRef<"send" | "accept" | "commit" | null>(null);
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
          notice: "提交已经开始，关闭窗口不会回滚。",
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

      if (event.transferId) {
        const knownTransferId = transferIdRef.current;
        if (!knownTransferId) {
          transferIdRef.current = event.transferId;
          updateState({ transferId: event.transferId });
        } else if (knownTransferId !== event.transferId) {
          return;
        }
      }

      if (cancelWantedRef.current && operationRef.current !== "commit") return;
      const current = stateRef.current;
      if (["sendComplete", "sendUnconfirmed", "sendCancelled", "sendFailed", "commitComplete", "closed"].includes(current.status)) return;
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
            notice: "已连接：可以发送资料，也可以等待对端发送。",
          });
          break;
        case "offered": {
          const offer = parseOfferSummary(event.summary);
          if (offer) {
            updateState({
              status: "receiving",
              offer,
              progress: null,
              error: null,
              errorCode: null,
              notice: null,
            });
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
        case "closed":
        case "error":
          peerEndedRef.current = true;
          if (operationRef.current || launchPendingRef.current) {
            updateState({ notice: event.message ?? "连接已结束，正在等待本机结果。" });
          } else {
            // A prepared import is gone after peer EOF/background cancellation.
            // Never leave an actionable preview for a discarded native job.
            updateState({
              status: "closed", busy: false, offer: null, preview: null,
              notice: event.message ?? "连接已结束，请重新连接。",
              error: event.event === "error" ? event.message ?? "设备互传失败。" : null,
              errorCode: event.code ?? null,
            });
          }
          break;
        default:
          break;
      }
    };
  }, [requestCloseForSession, updateState]);

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
      }
    }
  }, [failToIdle, makeEventHandler, requestCloseForSession, resetToIdle, updateState]);

  const join = useCallback(async (pairingInfo: string): Promise<void> => {
    if (busyRef.current || stateRef.current.status !== "idle") return;
    const trimmed = pairingInfo.trim();
    if (!trimmed) {
      updateState({ error: "请先粘贴完整的连接信息。", errorCode: "invalid-request" });
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
        notice: "已连接：可以发送资料，也可以等待对端发送。",
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
      }
    }
  }, [failToIdle, makeEventHandler, requestCloseForSession, resetToIdle, updateState]);

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
      progress: null,
      error: null,
      errorCode: null,
      notice: null,
      sendResult: null,
    });

    let invokedNative = false;
    try {
      const scope = await optionsRef.current.prepareSend(scopeChoice, includeBooks);
      if (generationRef.current !== generation || cancelWantedRef.current || peerEndedRef.current) return;
      invokedNative = true;
      const result = await sendLanSave(sessionId, scope, includeBooks);
      if (generationRef.current !== generation) return;

      let status: LanSaveSessionStatus = "sendFailed";
      let notice: string | null = result.message ?? "发送失败。";
      let error: string | null = null;
      let errorCode: string | null = null;
      if (result.status === "completed") {
        status = "sendComplete";
        notice = "对方已导入。";
      } else if (result.status === "unconfirmed") {
        status = "sendUnconfirmed";
        notice = "连接已结束，对方导入结果未确认。";
      } else if (result.status === "cancelled") {
        status = "sendCancelled";
        notice = result.message ?? "已取消发送。";
      } else {
        error = result.message ?? "发送失败。";
        errorCode = result.code;
      }

      updateState({
        status,
        busy: false,
        sendResult: result,
        remoteCommit: result.remoteCommit,
        error,
        errorCode,
        notice,
      });
    } catch (error) {
      if (generationRef.current !== generation) return;
      if (cancelWantedRef.current) return;
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
      }
    }
  }, [resetToIdle, updateState]);

  const accept = useCallback(async (): Promise<void> => {
    if (busyRef.current || launchPendingRef.current || cancelWantedRef.current) return;
    const previous = stateRef.current;
    const sessionId = sessionIdRef.current;
    const transferId = transferIdRef.current;
    if (!sessionId || !transferId || !previous.offer) return;

    busyRef.current = true;
    operationRef.current = "accept";
    const generation = generationRef.current;
    updateState({
      status: "preparing",
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

  const decline = useCallback(async (): Promise<void> => {
    cancelWantedRef.current = true;
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      resetToIdle();
      return;
    }
    await requestCloseForSession(sessionId).catch(() => undefined);
  }, [requestCloseForSession, resetToIdle]);

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
      if (cancelWantedRef.current) {
        // A too-late close left the real commit running. Once it finishes, let a
        // later close/reconnect observe the final native state instead of reusing
        // the resolved too-late promise.
        closeRef.current = null;
        cancelWantedRef.current = false;
        closeFinishedRef.current = false;
      }
      updateState({
        status: "commitComplete",
        busy: false,
        preview: null,
        localCommit: result,
        error: null,
        errorCode: null,
        notice: `已导入 ${result.importedBooks.length} 本资料。`,
      });
    } catch (error) {
      if (generationRef.current !== generation) return;
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
      }
    }
  }, [resetToIdle, updateState]);

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
      "receiving", "preparing", "preview", "committing",
    ].includes(state.status),
    startHost,
    join,
    send,
    accept,
    decline,
    commit,
    close,
  };
}
