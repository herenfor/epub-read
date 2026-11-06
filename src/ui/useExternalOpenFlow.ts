import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { ExternalOpenRequest } from "../platform/externalOpenBridge";
import type { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import type { ExternalOpenOutcome } from "./externalOpenPump";
import { uiText } from "./localization/UiLanguageProvider";
import type { SaveFailurePrompt } from "./saveFailureExit";
import { activeShelfSpace } from "./shelfSpaces";
import type { ShelfEntry } from "./shelf";
import type { useBookImport, useBookImportState } from "./useBookImport";
import type { BookOpenActions } from "./useBookOpen";
import type { BookSession } from "./useBookSession";
import { useExternalOpen } from "./useExternalOpen";
import type { useShelfEntriesState, useShelfNoticeState } from "./useShelfLibrary";

type BookImport = ReturnType<typeof useBookImport>;
type BookImportState = ReturnType<typeof useBookImportState>;
type ShelfEntriesState = ReturnType<typeof useShelfEntriesState>;
type ShelfNoticeSetter = ReturnType<typeof useShelfNoticeState>["setShelfNotice"];

export interface ExternalOpenFlow {
  readonly failed: ExternalOpenRequest | null;
  readonly retry: () => void;
  readonly dismiss: () => void;
}

/**
 * C7：系统“打开方式”/文件关联交来的书。
 * 只消费书本会话与开书动作的原对象；监听与泵仍由 useExternalOpen 持有。
 */
export function useExternalOpenFlow({
  leaveReader, handleShelfOpen, importExternalSource,
  libraryLoad, shelfBusy, nativeImport, saveFailurePrompt, view, shelfEntries,
  shelfBusyRef, nativeImportRef, saveFailurePromptRef, viewRef, shelfEntriesRef,
  activeSessionRef, shelfSpacesLeaveRef, runtime, isTauriEnv, setShelfNotice,
}: {
  leaveReader: BookOpenActions["leaveReader"];
  handleShelfOpen: BookOpenActions["handleShelfOpen"];
  importExternalSource: BookImport["importExternalSource"];
  libraryLoad: ShelfEntriesState["libraryLoad"];
  shelfBusy: boolean;
  nativeImport: BookImportState["nativeImport"];
  saveFailurePrompt: SaveFailurePrompt | null;
  view: "shelf" | "reader";
  shelfEntries: ShelfEntry[];
  shelfBusyRef: MutableRefObject<boolean>;
  nativeImportRef: BookImportState["nativeImportRef"];
  saveFailurePromptRef: MutableRefObject<SaveFailurePrompt | null>;
  viewRef: MutableRefObject<"shelf" | "reader">;
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  activeSessionRef: BookSession["activeSessionRef"];
  shelfSpacesLeaveRef: MutableRefObject<(revoked?: boolean) => Promise<void>>;
  runtime: ReturnType<typeof getRuntimeCapabilities>;
  isTauriEnv: () => boolean;
  setShelfNotice: ShelfNoticeSetter;
}): ExternalOpenFlow {
  // ---- 系统“打开方式”/文件关联交来的书：一次一本，导入后按普通开书打开 ----
  /** The request's imported book, kept until the shelf has rendered it. */
  const externalOpenTargetRef = useRef<{ requestId: string; entryId: string } | null>(null);
  const processExternalOpen = useCallback(async (request: ExternalOpenRequest): Promise<ExternalOpenOutcome> => {
    if (libraryLoad.status !== "ready" || shelfBusyRef.current || nativeImportRef.current || saveFailurePromptRef.current) {
      return "wait";
    }
    if (viewRef.current === "reader") {
      // The usual save guard. If it blocks and the user stays, they decide on the
      // request afterwards instead of being pulled out of the book again.
      return (await leaveReader(false)) ? "wait" : "failed";
    }
    // External open always lands in the library: another open shelf locks first.
    if (activeShelfSpace().kind !== "library") {
      await shelfSpacesLeaveRef.current();
      return "wait";
    }
    const stashed = externalOpenTargetRef.current;
    let entryId = stashed?.requestId === request.requestId ? stashed.entryId : null;
    if (entryId === null) {
      const entries = await importExternalSource(request.source);
      if (entries === null) return "wait";
      const [entry] = entries;
      if (!entry) return "failed";
      externalOpenTargetRef.current = { requestId: request.requestId, entryId: entry.id };
      entryId = entry.id;
    }
    // handleShelfOpen finds the book in the rendered shelf: the import's render
    // has not landed yet, so open on the pass its state change kicks.
    if (!shelfEntriesRef.current.some((item) => item.id === entryId)) return "wait";
    externalOpenTargetRef.current = null;
    const before = activeSessionRef.current;
    await handleShelfOpen(entryId);
    return activeSessionRef.current !== null && activeSessionRef.current !== before ? "opened" : "failed";
  }, [handleShelfOpen, importExternalSource, leaveReader, libraryLoad.status, nativeImportRef]);
  const externalOpen = useExternalOpen({
    platform: !isTauriEnv() ? null
      : runtime.platform === "android" ? "android"
        : runtime.platform === "windows" || runtime.platform === "macos" || runtime.platform === "linux" ? "desktop"
          : null,
    process: processExternalOpen,
    onError: (error) => setShelfNotice({ kind: "error", text: uiText("notice.externalOpen.failed", { error: String(error) }) }),
  });
  const kickExternalOpen = externalOpen.kick;
  useEffect(() => {
    kickExternalOpen();
  }, [kickExternalOpen, libraryLoad.status, shelfBusy, nativeImport, view, saveFailurePrompt, shelfEntries]);
  return { failed: externalOpen.failed, retry: externalOpen.retry, dismiss: externalOpen.dismiss };
}
