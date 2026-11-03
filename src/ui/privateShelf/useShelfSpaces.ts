import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { privateShelfNative } from "../../platform/privateShelf";
import { clearUnheldCoverUrls } from "../coverUrlCache";
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
}) {
  const snapshot = useActiveShelfSpace();
  const [privateConfigured, setPrivateConfigured] = useState(false);
  const [dialog, setDialog] = useState<{ mode: PrivateShelfDialogMode; leftover?: boolean } | null>(null);
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
      await leaveShelfSpace();
      depsRef.current.resetShelfView("library");
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
    refresh();
  }, [leave, refresh]);

  const select = useCallback(async (kind: ShelfSpaceKind) => {
    if (kind === "library") { await leave(); return; }
    try {
      const status = await privateShelfNative.status();
      setPrivateConfigured(status !== "unconfigured");
      setDialog({ mode: status === "unconfigured" ? "setup" : "unlock" });
    } catch (error) {
      depsRef.current.setShelfNotice({ kind: "error", text: uiText("shelfMain.private.failed", { error: String((error as Error).message ?? error) }) });
    }
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
  };
}
