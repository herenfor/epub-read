import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { PrivateShelfError, privateShelfError, privateShelfNative, type PrivateShelfMoveDirection } from "../../platform/privateShelf";
import { noteCloudSyncChange } from "../cloudSync/cloudSyncStore";
import { clearUnheldCoverUrls, forgetCoverUrls } from "../coverUrlCache";
import type { ShelfEntry } from "../shelf";
import { uiText } from "../localization/UiLanguageProvider";
import {
  SHELF_SPACES,
  activeShelfSpaceToken,
  enterShelfSpace,
  leaveShelfSpace,
  useActiveShelfSpace,
  type ShelfSpaceKind,
} from "../shelfSpaces";
import { createPrivateShelfStore } from "./privateShelfStore";
import type { PrivateShelfDialogMode } from "./PrivateShelfDialog";

type Notice = { kind: "ok" | "warn" | "error"; text: string } | null;

/** ER-0045: one book on its way into or out of the private shelf. */
export interface ShelfMoveTarget {
  entry: ShelfEntry;
  hash: string;
  direction: PrivateShelfMoveDirection;
  originToken: string | null;
}

export interface ShelfSpacesDialog {
  mode: PrivateShelfDialogMode;
  leftover?: boolean;
  move?: ShelfMoveTarget;
}

/**
 * The title switcher's state and transitions (ER-0044). Switching always
 * passes through the library: the reader is left first, the shelf view is
 * emptied before the other store is read, and the private shelf locks
 * natively when it is left. A process start always shows the library.
 */
export function useShelfSpaces(deps: {
  supported: boolean;
  viewRef: MutableRefObject<"shelf" | "reader">;
  /** Saves and leaves the open book; false when the user stayed. */
  leaveReader(leaveUnsaved: boolean): Promise<boolean>;
  /** Empties the shelf view and swaps reader tabs for the shelf being entered. */
  resetShelfView(entering: ShelfSpaceKind): void;
  refreshShelf(): Promise<void>;
  setShelfNotice(notice: Notice): void;
  /** Held while a move runs, so other shelf writes wait. */
  shelfBusyRef: MutableRefObject<boolean>;
  /** The move landed: drop the book's tab and the browser state kept for it on this shelf. */
  beforeBookMove(target: ShelfMoveTarget): Promise<void>;
  onBookMoved(target: ShelfMoveTarget): void;
}) {
  const snapshot = useActiveShelfSpace();
  const [privateConfigured, setPrivateConfigured] = useState(false);
  const [dialog, setDialog] = useState<ShelfSpacesDialog | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const switchingRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      setPrivateConfigured((await privateShelfNative.status()) !== "unconfigured");
    } catch {
      setPrivateConfigured(false);
    }
  }, []);

  // An unlock never outlives the page that made it: a reload starts locked.
  useEffect(() => {
    if (!deps.supported) return;
    void privateShelfNative.lock().catch(() => undefined).finally(() => void refreshStatus());
  }, [deps.supported, refreshStatus]);

  // After the switch has rendered, the previous shelf's cards have released
  // their covers; drop them so no other shelf's cover stays in memory.
  useEffect(() => {
    clearUnheldCoverUrls();
  }, [snapshot.token]);

  const refresh = useCallback(() => {
    void depsRef.current.refreshShelf().catch((error: unknown) => {
      depsRef.current.setShelfNotice({ kind: "error", text: uiText("shelfMain.private.failed", { error: error instanceof Error ? error.message : String(error) }) });
    });
  }, []);

  /** Back to the library. `revoked`: the session ended under us, so nothing can be saved. */
  const leave = useCallback(async (revoked = false): Promise<void> => {
    if (activeShelfSpaceToken() === null || switchingRef.current) return;
    switchingRef.current = true;
    try {
      if (depsRef.current.viewRef.current === "reader" && !(await depsRef.current.leaveReader(revoked))) return;
      setDialog(null);
      const closing = leaveShelfSpace();
      depsRef.current.resetShelfView("library");
      depsRef.current.setShelfNotice(null);
      await closing;
      refresh();
      if (revoked) depsRef.current.setShelfNotice({ kind: "warn", text: uiText("shelfMain.private.closed") });
    } finally {
      switchingRef.current = false;
    }
  }, [refresh]);

  const openPrivate = useCallback((sessionId: string) => {
    setDialog(null);
    setPrivateConfigured(true);
    if (activeShelfSpaceToken() !== null) return;
    const store = createPrivateShelfStore(privateShelfNative, sessionId, () => {
      if (activeShelfSpaceToken() === sessionId) void leave(true);
    });
    enterShelfSpace({
      space: SHELF_SPACES.private,
      store,
      token: sessionId,
      close: async () => {
        store.clear();
        await privateShelfNative.lock().catch(() => undefined);
      },
    });
    depsRef.current.resetShelfView("private");
    depsRef.current.setShelfNotice(null);
    refresh();
  }, [leave, refresh]);

  const select = useCallback(async (kind: ShelfSpaceKind) => {
    if (kind === "library") { await leave(); return; }
    if (switchingRef.current) return;
    try {
      const status = await privateShelfNative.status();
      if (switchingRef.current || activeShelfSpaceToken() !== null) return;
      setPrivateConfigured(status !== "unconfigured");
      setDialog({ mode: status === "unconfigured" ? "setup" : "unlock" });
    } catch (error) {
      depsRef.current.setShelfNotice({ kind: "error", text: uiText("shelfMain.private.failed", { error: String((error as Error).message ?? error) }) });
    }
  }, [leave]);

  /** Book menu: the library asks for the password first, the private shelf only confirms. */
  const requestMove = useCallback(async (entry: ShelfEntry) => {
    if (switchingRef.current || depsRef.current.shelfBusyRef.current) return;
    const hash = entry.contentHash ?? entry.id;
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      depsRef.current.setShelfNotice({ kind: "error", text: uiText("shelfMain.move.failed", { error: uiText("shelfMain.move.noHash") }) });
      return;
    }
    const originToken = activeShelfSpaceToken();
    if (originToken !== null) {
      setDialog({ mode: "moveOut", move: { entry, hash, direction: "toLibrary", originToken } });
      return;
    }
    try {
      const status = await privateShelfNative.status();
      if (switchingRef.current || activeShelfSpaceToken() !== null) return;
      setPrivateConfigured(status !== "unconfigured");
      setDialog({ mode: status === "unconfigured" ? "setup" : "unlock", move: { entry, hash, direction: "toPrivate", originToken } });
    } catch (error) {
      depsRef.current.setShelfNotice({ kind: "error", text: uiText("shelfMain.move.failed", { error: privateShelfError(error).message }) });
    }
  }, []);

  /**
   * Runs the move the dialog confirmed; a failure rejects so the dialog shows
   * it. Into the private shelf the session exists only for this call and is
   * locked again whatever happens; the view stays on the shelf it was on.
   */
  const runMove = useCallback(async (target: ShelfMoveTarget, sessionId?: string): Promise<void> => {
    const toPrivate = target.direction === "toPrivate";
    const token = activeShelfSpaceToken();
    const session = toPrivate ? sessionId : token;
    if (toPrivate) setPrivateConfigured(true);
    if (!session || token !== target.originToken || switchingRef.current || depsRef.current.shelfBusyRef.current) {
      if (toPrivate && sessionId) await privateShelfNative.lock().catch(() => undefined);
      throw new PrivateShelfError("busy", uiText("shelfMain.move.unavailable"));
    }
    depsRef.current.shelfBusyRef.current = true;
    try {
      await depsRef.current.beforeBookMove(target);
      if (activeShelfSpaceToken() !== token) throw new PrivateShelfError("locked", uiText("shelfMain.move.unavailable"));
      await privateShelfNative.move(session, target.hash, target.direction);
    } catch (error) {
      const failure = privateShelfError(error);
      if (!toPrivate && failure.code === "locked") {
        setDialog(null);
        void leave(true);
        return;
      }
      throw failure;
    } finally {
      if (toPrivate) await privateShelfNative.lock().catch(() => undefined);
      depsRef.current.shelfBusyRef.current = false;
    }
    if (activeShelfSpaceToken() !== token) return;
    setDialog(null);
    depsRef.current.onBookMoved(target);
    // Back in the library, the book takes part in sync again.
    if (!toPrivate) noteCloudSyncChange("data-changed");
    depsRef.current.setShelfNotice({ kind: "ok", text: uiText(toPrivate ? "shelfMain.move.in.done" : "shelfMain.move.out.done", { title: target.entry.title }) });
    void depsRef.current.refreshShelf().then(() => {
      // The card is gone after this render; its cover URL goes with it.
      requestAnimationFrame(() => forgetCoverUrls(`${target.entry.id}|`));
    }, (error: unknown) => {
      depsRef.current.setShelfNotice({ kind: "error", text: uiText("shelfMain.private.failed", { error: error instanceof Error ? error.message : String(error) }) });
    });
  }, [leave]);

  const onReset = useCallback(() => {
    setDialog(null);
    setPrivateConfigured(false);
    depsRef.current.setShelfNotice({ kind: "ok", text: uiText("shelfMain.private.reset.done") });
  }, []);

  return {
    space: snapshot.space,
    token: snapshot.token,
    privateConfigured,
    dialog,
    setDialog,
    select,
    lock: () => void leave(),
    leave,
    openPrivate,
    onReset,
    requestMove,
    runMove,
  };
}
