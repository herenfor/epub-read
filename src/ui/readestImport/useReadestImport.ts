/**
 * Owns one Readest import from the source screen to the result screen. Books
 * are prepared off-shelf and published with all converted records in one transaction.
 * Stopping before that transaction commits leaves the shelf unchanged. Every exit path closes the
 * native session; an open that returns after the dialog was abandoned is
 * closed, not shown.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  closeReadestBackup,
  commitReadestImport,
  findReadestConfig,
  openReadestBackup,
  probeReadestLibrary,
  readReadestEntryText,
  readestImportTargets,
  stageReadestBooks,
  READEST_TARGET_BATCH,
  READEST_COMMIT_MAX_BOOKS,
  READEST_COMMIT_MAX_RECORDS,
  type ReadestBookFile,
  type ReadestBookImportPayload,
  type ReadestImportScope,
  type ReadestLibraryProbe,
  type ReadestTargetCandidate,
} from "../../platform/readestImportNativeBridge";
import { saveFileErrorCode, saveFileErrorMessage, type SaveFileLocation } from "../../platform/saveFileNativeBridge";
import { noteCloudSyncChange } from "../cloudSync/cloudSyncStore";
import { uiText } from "../localization/UiLanguageProvider";
import { getShelfStore, type ShelfEntry, type ShelfStore } from "../shelf";
import { activeShelfSpace, subscribeShelfSpace } from "../shelfSpaces";
import type { ShelfNotice } from "../useShelfLibrary";
import { parseReadestBookConfig, parseReadestLibrary, type ReadestLibraryBook } from "./readestBackup";
import { convertReadestBook } from "./readestConvert";
import { openReadestTarget } from "./readestLocalTarget";
import {
  addOutcome,
  bookPayload,
  emptyResult,
  importRows,
  localImportBooks,
  stageChunks,
  type ImportResult,
  type ImportRow,
  type LocalImportBook,
  type PositionRule,
} from "./readestImportModel";

export type ReadestImportState =
  | { kind: "idle" }
  /** `probe`: "probing", the Readest library found on this computer, or null. */
  | { kind: "source"; probe: "probing" | ReadestLibraryProbe | null; canPickFolder: boolean; error: string | null }
  | { kind: "working"; step: "opening" | "matching"; sourceLabel: string; done: number; total: number }
  | { kind: "list"; sourceLabel: string; rows: ImportRow[]; rule: PositionRule }
  | { kind: "importing"; sourceLabel: string; done: number; total: number; title: string; bytesDone: number; bytesTotal: number; stopping: boolean }
  | { kind: "done"; sourceLabel: string; result: ImportResult };

interface Session {
  id: string;
  generation: number;
  sourceLabel: string;
  library: ReadestLibraryBook[];
  files: ReadestBookFile[];
}

export interface ReadestImportDeps {
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  refreshShelfProjection(): Promise<unknown>;
  setShelfNotice: Dispatch<SetStateAction<ShelfNotice>>;
  /** Desktop can read Readest's own folder; Android only takes a backup file. */
  platform: string;
  /** The app-wide import slot and shelf gate, shared with every other import. */
  importSlotRef: MutableRefObject<string | null>;
  shelfBusyRef: MutableRefObject<boolean>;
}

const IMPORT_SLOT = "readest-import";

function scopeFor(store: ShelfStore): ReadestImportScope | null {
  if (activeShelfSpace().kind !== "private") return { kind: "public" };
  const id = (store as { privateSessionId?: unknown }).privateSessionId;
  return typeof id === "string" ? { kind: "private", sessionId: id } : null;
}

/** Text for a native error code; unknown codes show the message. */
export function readestErrorText(error: unknown): string {
  const code = saveFileErrorCode(error);
  switch (code) {
    case "not-readest": return uiText("readestImport.error.notReadest");
    case "invalid-backup": case "invalid-data": case "invalid-entity": case "invalid-request":
      return uiText("readestImport.error.invalid");
    case "too-large": return uiText("readestImport.error.tooLarge");
    case "source-mismatch": return uiText("readestImport.fail.mismatch");
    case "source-changed": case "stale-basis": return uiText("readestImport.error.changed");
    case "source-unavailable": return uiText("readestImport.error.unavailable");
    case "reader-busy": return uiText("readestImport.error.readerBusy");
    case "locked": case "session-closed": case "cancelled": return uiText("readestImport.error.closed");
    case "busy": case "repository-unavailable": return uiText("readestImport.error.busy");
    case "random-access-required": case "unsupported-platform": return uiText("readestImport.error.randomAccess");
    default: return uiText("readestImport.error.other", { error: saveFileErrorMessage(error) });
  }
}

/** Codes that end the whole run rather than one book. */
const endsRun = (error: unknown): boolean =>
  ["cancelled", "locked", "session-closed", "repository-unavailable"].includes(saveFileErrorCode(error) ?? "");

function stagingFailure(code: string | null, message: string | null): string {
  if (code === "source-mismatch") return uiText("readestImport.fail.mismatch");
  if (code === "no-file" || code === "source-unavailable") return uiText("readestImport.fail.noFile");
  if (code === "storage-error") return uiText("readestImport.fail.storage");
  if (code) return uiText("readestImport.fail.unreadable");
  return message || uiText("readestImport.fail.notAdded");
}

export function useReadestImport({ shelfEntriesRef, refreshShelfProjection, setShelfNotice, platform, importSlotRef, shelfBusyRef }: ReadestImportDeps) {
  const [state, setState] = useState<ReadestImportState>({ kind: "idle" });
  const sessionRef = useRef<Session | null>(null);
  const generationRef = useRef(0);
  /** Set by "stop": the run ends at the next book boundary. */
  const stopRef = useRef(false);
  const canPickFolder = platform !== "android" && platform !== "web";

  const release = useCallback((session: Session | null): void => {
    if (!session) return;
    if (sessionRef.current === session) sessionRef.current = null;
    void closeReadestBackup(session.id).catch(() => undefined);
  }, []);

  const end = useCallback((notice?: ShelfNotice): void => {
    generationRef.current += 1;
    release(sessionRef.current);
    setState((previous) => (previous.kind === "idle" ? previous : { kind: "idle" }));
    if (notice) setShelfNotice(notice);
  }, [release, setShelfNotice]);

  const current = (session: Session): boolean =>
    sessionRef.current === session && generationRef.current === session.generation;

  // Switching or locking a shelf ends the import bound to it; so does unmounting.
  useEffect(() => subscribeShelfSpace(() => end()), [end]);
  useEffect(() => () => {
    generationRef.current += 1;
    release(sessionRef.current);
  }, [release]);

  /** The source screen. Desktop looks for Readest's own library while it shows. */
  const open = useCallback((): void => {
    if (sessionRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("readestImport.error.busy") });
      return;
    }
    const generation = ++generationRef.current;
    setState({ kind: "source", probe: canPickFolder ? "probing" : null, canPickFolder, error: null });
    if (!canPickFolder) return;
    void probeReadestLibrary().catch(() => null).then((found) => {
      if (generationRef.current !== generation) return;
      setState((previous) => (previous.kind === "source" ? { ...previous, probe: found } : previous));
    });
  }, [canPickFolder, setShelfNotice]);

  /**
   * Open a source and build the list. From the archive picker a file that is
   * not a Readest backup is handed back ("not-readest"); from the source screen
   * every failure is shown there.
   */
  const begin = useCallback(async (source: SaveFileLocation, sourceLabel: string, fromPanel: boolean): Promise<"handled" | "not-readest"> => {
    if (sessionRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("readestImport.error.busy") });
      return "handled";
    }
    const store = getShelfStore();
    const scope = scopeFor(store);
    if (!scope) return "not-readest";
    const generation = ++generationRef.current;
    const session: Session = { id: crypto.randomUUID(), generation, sourceLabel, library: [], files: [] };
    sessionRef.current = session;
    const probe = state.kind === "source" ? state.probe : null;
    const fail = (error: unknown): void => {
      if (!current(session)) return;
      if (!fromPanel) return end({ kind: "error", text: readestErrorText(error) });
      release(session);
      setState({ kind: "source", probe, canPickFolder, error: readestErrorText(error) });
    };
    setState({ kind: "working", step: "opening", sourceLabel, done: 0, total: 0 });
    try {
      let info;
      try {
        info = await openReadestBackup({ sessionId: session.id, source, scope });
      } catch (error) {
        if (!current(session)) return "handled";
        const code = saveFileErrorCode(error);
        // A non-ZIP SeLis save is not a Readest backup either; let its own import report on it.
        if (!fromPanel && (code === "not-readest" || (code === "invalid-backup" && !/\.zip$/i.test(sourceLabel)))) {
          if (sessionRef.current === session) sessionRef.current = null;
          setState({ kind: "idle" });
          return "not-readest";
        }
        throw error;
      }
      if (!current(session)) {
        void closeReadestBackup(info.sessionId).catch(() => undefined);
        return "handled";
      }
      session.files = info.books ?? [];
      const libraryText = await readReadestEntryText(session.id, info.library);
      if (!current(session)) return "handled";
      const library = parseReadestLibrary(libraryText);
      if (!library.ok) throw Object.assign(new Error(library.reason), { code: library.reason === "too-large" ? "too-large" : "invalid-backup" });
      session.library = library.value.books;

      setState({ kind: "working", step: "matching", sourceLabel, done: 0, total: 0 });
      const seen = new Set<string>();
      const entries = shelfEntriesRef.current.filter((entry) => {
        if (!entry.contentHash || entry.available === false || seen.has(entry.contentHash)) return false;
        seen.add(entry.contentHash);
        return true;
      });
      const hashes = entries.map((entry) => entry.contentHash!);
      const candidates: ReadestTargetCandidate[] = [];
      for (let at = 0; at < hashes.length; at += READEST_TARGET_BATCH) {
        candidates.push(...await readestImportTargets(session.id, hashes.slice(at, at + READEST_TARGET_BATCH)));
        if (!current(session)) return "handled";
        setState({ kind: "working", step: "matching", sourceLabel, done: Math.min(hashes.length, at + READEST_TARGET_BATCH), total: hashes.length });
      }
      const rows = importRows(session.library, localImportBooks(entries, candidates), session.files);
      setState({ kind: "list", sourceLabel, rows, rule: "farther" });
    } catch (error) {
      fail(error);
    }
    return "handled";
  }, [canPickFolder, end, release, setShelfNotice, shelfEntriesRef, state]);

  /** The archive picker's hook: a Readest backup picked there opens the same list. */
  const tryStart = useCallback((source: SaveFileLocation, sourceLabel: string) => begin(source, sourceLabel, false), [begin]);

  const pickBackup = useCallback(async (): Promise<void> => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: uiText("readestImport.pick.backupTitle"),
        ...(platform === "android" ? {} : { filters: [{ name: uiText("readestImport.pick.backupFilter"), extensions: ["zip"] }] }),
      });
      const picked = Array.isArray(selected) ? selected[0] : selected;
      if (typeof picked !== "string" || picked.length === 0) return;
      const source: SaveFileLocation = platform === "android" ? { kind: "uri", uri: picked } : { kind: "path", path: picked };
      const label = platform === "android"
        ? decodeURIComponent(picked.split("/").pop() ?? "").split(/[\\/:]/).pop() || uiText("readestImport.source.backup")
        : picked.split(/[\\/]/).pop() || picked;
      await begin(source, label, true);
    } catch (error) {
      setState((previous) => (previous.kind === "source" ? { ...previous, error: readestErrorText(error) } : previous));
    }
  }, [begin, platform]);

  const pickFolder = useCallback(async (): Promise<void> => {
    try {
      const selected = await openFileDialog({ multiple: false, directory: true, title: uiText("readestImport.pick.folderTitle") });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path !== "string" || path.length === 0) return;
      await begin({ kind: "path", path }, uiText("readestImport.source.folder"), true);
    } catch (error) {
      setState((previous) => (previous.kind === "source" ? { ...previous, error: readestErrorText(error) } : previous));
    }
  }, [begin]);

  const startFound = useCallback(async (): Promise<void> => {
    if (state.kind !== "source" || !state.probe || state.probe === "probing") return;
    await begin({ kind: "path", path: state.probe.path }, uiText("readestImport.source.thisComputer"), true);
  }, [begin, state]);

  const updateRows = useCallback((update: (rows: ImportRow[]) => ImportRow[]): void => {
    setState((previous) => (previous.kind === "list" ? { ...previous, rows: update(previous.rows) } : previous));
  }, []);

  const setRule = useCallback((rule: PositionRule): void => {
    setState((previous) => (previous.kind === "list" ? { ...previous, rule } : previous));
  }, []);

  /** Back from the list to the source screen; the opened source is closed. */
  const back = useCallback((): void => {
    if (state.kind !== "list") return;
    release(sessionRef.current);
    open();
  }, [open, release, state.kind]);

  const run = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || state.kind !== "list") return;
    const { rule, sourceLabel } = state;
    const chosen = state.rows.filter((row) => row.selected && row.kind !== "unavailable");
    if (chosen.length === 0) return;
    if (chosen.length > READEST_COMMIT_MAX_BOOKS) {
      setShelfNotice({ kind: "warn", text: uiText("readestImport.error.tooLarge") });
      return;
    }
    if (importSlotRef.current || shelfBusyRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("notice.import.busy") });
      return;
    }
    importSlotRef.current = IMPORT_SLOT;
    stopRef.current = false;
    const store = getShelfStore();
    const isPublic = activeShelfSpace().kind !== "private";
    const result = emptyResult();
    const total = chosen.length;
    let done = 0;
    let changed = false;
    /** `ahead`: books of the chunk in hand that are past staging but not counted yet. */
    const show = (title: string, bytesDone = 0, bytesTotal = 0, ahead = 0): void => {
      if (!current(session)) return;
      setState({ kind: "importing", sourceLabel, done: Math.min(total, done + ahead), total, title, bytesDone, bytesTotal, stopping: stopRef.current });
    };

    let batch: Array<{ title: string; payload: ReadestBookImportPayload; records: number; approximate: ImportResult["approximate"] }> = [];
    const stagedHashes: string[] = [];
    const commitBooks = async (items: typeof batch): Promise<void> => {
      const outcome = await commitReadestImport(session.id, items.map((item) => item.payload), undefined, stagedHashes);
      addOutcome(result, outcome);
      result.booksAdded = outcome.booksAdded ?? 0;
      result.booksAlready = outcome.booksAlready ?? 0;
      for (const item of items) result.approximate.push(...item.approximate);
      changed = true;
    };
    const flush = async (): Promise<void> => {
      if (stopRef.current || !current(session)) return;
      if (batch.length || stagedHashes.length) await commitBooks(batch);
    };
    /** Read, convert and queue one book's records against its shelf book. */
    const queueRecords = async (row: ImportRow, local: LocalImportBook, staged = false): Promise<void> => {
      try {
        // Entries are read one at a time to EOF, never interleaved.
        const entry = await findReadestConfig(session.id, row.readestHash);
        if (!entry) return;
        const parsed = parseReadestBookConfig(await readReadestEntryText(session.id, entry));
        if (!parsed.ok) {
          throw new Error(uiText("readestImport.fail.records"));
        }
        result.unsupported += parsed.value.skipped.filter((item) => item.reason !== "deleted").length;
        const opened = await openReadestTarget(store, local, staged ? { sessionId: session.id, readestHash: row.readestHash } : undefined);
        let preview;
        try {
          preview = await convertReadestBook(row.readestHash, parsed.value, opened.target, Date.now());
        } finally {
          opened.close();
        }
        const built = bookPayload(row.readestHash, row.title, local, preview, rule);
        result.unplaced.push(...built.unplaced);
        if (built.payload) {
          batch.push({ title: row.title, payload: built.payload, records: built.records, approximate: built.approximate });
          if (batch.reduce((sum, item) => sum + item.records, 0) > READEST_COMMIT_MAX_RECORDS) throw new Error(uiText("readestImport.fail.tooMany"));
        } else if (built.records > 0) {
          throw new Error(uiText("readestImport.fail.tooMany"));
        }
      } catch (error) {
        if (endsRun(error)) throw error;
        result.failed.push({ title: row.title, reason: readestErrorText(error) });
        throw error;
      }
    };

    try {
      // Books already on the shelf only merge their records.
      for (const row of chosen.filter((item) => item.kind === "existing")) {
        if (stopRef.current || !current(session)) break;
        show(row.title);
        await queueRecords(row, row.local!);
        done += 1;
      }

      // Prepare new originals off-shelf; publish once with all converted records below.
      for (const chunk of stageChunks(chosen.filter((item) => item.kind === "new"))) {
        if (stopRef.current || !current(session)) break;
        show(chunk[0].title);
        const staged = await stageReadestBooks(session.id, chunk.map((row) => row.readestHash), (progress) => {
          show(chunk[Math.min(progress.completed, chunk.length - 1)].title, progress.bytesDone, progress.bytesTotal, progress.completed);
        });
        if (!current(session)) break;
        for (const row of chunk) {
          if (stopRef.current || !current(session)) break;
          const item = staged.find((item) => item.readestHash === row.readestHash);
          if (!item || item.errorCode || !item.bookHash || !item.targetToken || !item.fileName) {
            const message = stagingFailure(item?.errorCode ?? null, null);
            result.failed.push({ title: row.title, reason: message });
            throw new Error(message);
          }
          stagedHashes.push(row.readestHash);
          const local: LocalImportBook = {
            id: item.bookHash, bookHash: item.bookHash, title: row.title, fileName: item.fileName,
            partialMd5: row.readestHash, targetToken: item.targetToken,
            progressPct: item.progress?.display?.value?.progressPctHint ?? null,
          };
          if (row.records) await queueRecords(row, local, true);
        }
        done += chunk.length;
      }
      await flush();
    } catch (error) {
      // "Stop" during staging closes the source; that is the expected way out.
      if (!stopRef.current) result.error = readestErrorText(error);
    } finally {
      if (importSlotRef.current === IMPORT_SLOT) importSlotRef.current = null;
    }

    if (changed && isPublic) noteCloudSyncChange("data-changed");
    // A run abandoned by a shelf switch still marked sync dirty, but its UI is gone.
    if (!current(session)) return;
    result.stopped = stopRef.current;
    result.notReached = (result.stopped || result.error) && !changed ? total : Math.max(0, total - done);
    release(session);
    if (changed) {
      try {
        await refreshShelfProjection();
      } catch {
        if (!result.error) result.error = uiText("notice.shelf.refreshFailedShort");
      }
    }
    if (generationRef.current !== session.generation) return;
    setState({ kind: "done", sourceLabel, result });
  }, [importSlotRef, refreshShelfProjection, release, setShelfNotice, shelfBusyRef, state]);

  /** Stop after the book in hand. Extraction is the only long step, so it is cut short. */
  const stop = useCallback((): void => {
    if (state.kind !== "importing" || stopRef.current) return;
    stopRef.current = true;
    setState({ ...state, stopping: true });
    const session = sessionRef.current;
    if (session) void closeReadestBackup(session.id).then((status) => {
      if (current(session) && status === "committed") stopRef.current = false;
    }).catch(() => undefined);
  }, [state]);

  const cancel = useCallback((): void => {
    if (state.kind === "importing") return;
    end();
  }, [end, state.kind]);

  return { state, active: state.kind !== "idle", open, tryStart, pickBackup, pickFolder, startFound, updateRows, setRule, back, run, stop, cancel };
}
