/**
 * Owns one Readest import session from the archive picker to commit
 * (readest-import-design.md §3–§4). Every exit path closes the native session;
 * an open that returns after the dialog was abandoned is closed, not shown.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  closeReadestBackup,
  commitReadestImport,
  findReadestConfig,
  openReadestBackup,
  readReadestEntryText,
  readestImportTargets,
  READEST_TARGET_BATCH,
  type ReadestImportScope,
  type ReadestTargetCandidate,
} from "../../platform/readestImportNativeBridge";
import { saveFileErrorCode, saveFileErrorMessage, type SaveFileLocation } from "../../platform/saveFileNativeBridge";
import { noteCloudSyncChange } from "../cloudSync/cloudSyncStore";
import { uiText } from "../localization/UiLanguageProvider";
import { getShelfStore, type ShelfEntry, type ShelfStore } from "../shelf";
import { activeShelfSpace, subscribeShelfSpace } from "../shelfSpaces";
import type { ShelfNotice } from "../useShelfLibrary";
import { parseReadestBookConfig, parseReadestLibrary, type ReadestBookConfig, type ReadestLibraryBook } from "./readestBackup";
import { convertReadestBook } from "./readestConvert";
import { openReadestTarget } from "./readestLocalTarget";
import {
  bookReview,
  commitPlan,
  isLocalEpub,
  localImportBooks,
  matchRows,
  outcomeSummary,
  type BookReview,
  type LocalImportBook,
  type MatchRow,
} from "./readestImportModel";

export type ReadestImportState =
  | { kind: "idle" }
  | { kind: "working"; step: "opening" | "matching" | "converting" | "committing"; sourceLabel: string; done: number; total: number }
  | { kind: "match"; sourceLabel: string; rows: MatchRow[]; locals: LocalImportBook[] }
  | { kind: "review"; sourceLabel: string; rows: MatchRow[]; locals: LocalImportBook[]; reviews: BookReview[] };

interface Session {
  id: string;
  generation: number;
  sourceLabel: string;
  library: ReadestLibraryBook[];
  /** Read once per session; null when the backup has no config for the book. */
  configs: Map<string, ReadestBookConfig | null>;
}

export interface ReadestImportDeps {
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  refreshShelfProjection(): Promise<unknown>;
  setShelfNotice: Dispatch<SetStateAction<ShelfNotice>>;
}

function scopeFor(store: ShelfStore): ReadestImportScope | null {
  if (activeShelfSpace().kind !== "private") return { kind: "public" };
  const id = (store as { privateSessionId?: unknown }).privateSessionId;
  return typeof id === "string" ? { kind: "private", sessionId: id } : null;
}

/** Notice text for a native error code (§4.5); unknown codes show the message. */
export function readestErrorText(error: unknown): string {
  const code = saveFileErrorCode(error);
  switch (code) {
    case "invalid-backup": case "invalid-data": case "invalid-entity": case "invalid-request":
      return uiText("readestImport.error.invalid");
    case "too-large": return uiText("readestImport.error.tooLarge");
    case "source-changed": case "stale-basis": return uiText("readestImport.error.changed");
    case "reader-busy": return uiText("readestImport.error.readerBusy");
    case "locked": case "session-closed": case "cancelled": return uiText("readestImport.error.closed");
    case "busy": case "repository-unavailable": return uiText("readestImport.error.busy");
    case "random-access-required": case "unsupported-platform": return uiText("readestImport.error.randomAccess");
    default: return uiText("readestImport.error.other", { error: saveFileErrorMessage(error) });
  }
}

export function useReadestImport({ shelfEntriesRef, refreshShelfProjection, setShelfNotice }: ReadestImportDeps) {
  const [state, setState] = useState<ReadestImportState>({ kind: "idle" });
  const sessionRef = useRef<Session | null>(null);
  const generationRef = useRef(0);

  const release = useCallback((session: Session | null): void => {
    if (!session) return;
    if (sessionRef.current === session) sessionRef.current = null;
    void closeReadestBackup(session.id).catch(() => undefined);
  }, []);

  const end = useCallback((notice?: ShelfNotice): void => {
    generationRef.current += 1;
    release(sessionRef.current);
    setState({ kind: "idle" });
    if (notice) setShelfNotice(notice);
  }, [release, setShelfNotice]);

  const current = (session: Session): boolean =>
    sessionRef.current === session && generationRef.current === session.generation;

  // Switching or locking a shelf ends the import bound to it; so does unmounting.
  useEffect(() => subscribeShelfSpace(() => { if (sessionRef.current) end(); }), [end]);
  useEffect(() => () => {
    generationRef.current += 1;
    release(sessionRef.current);
  }, [release]);

  /**
   * Try the picked file as a Readest backup. "not-readest" hands it back to
   * the SeLis archive import; everything else is handled (shown or reported).
   */
  const tryStart = useCallback(async (source: SaveFileLocation, sourceLabel: string): Promise<"handled" | "not-readest"> => {
    if (sessionRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("readestImport.error.busy") });
      return "handled";
    }
    const store = getShelfStore();
    const scope = scopeFor(store);
    if (!scope) return "not-readest";
    const generation = ++generationRef.current;
    const session: Session = { id: crypto.randomUUID(), generation, sourceLabel, library: [], configs: new Map() };
    sessionRef.current = session;
    setState({ kind: "working", step: "opening", sourceLabel, done: 0, total: 0 });
    try {
      let info;
      try {
        info = await openReadestBackup({ sessionId: session.id, source, scope });
      } catch (error) {
        if (!current(session)) return "handled";
        const code = saveFileErrorCode(error);
        // A non-ZIP SeLis save is not a Readest backup either; let its own import report on it.
        if (code === "not-readest" || (code === "invalid-backup" && !/\.zip$/i.test(sourceLabel))) {
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
      const libraryText = await readReadestEntryText(session.id, info.library);
      if (!current(session)) return "handled";
      const library = parseReadestLibrary(libraryText);
      if (!library.ok) throw Object.assign(new Error(library.reason), { code: library.reason === "too-large" ? "too-large" : "invalid-backup" });
      session.library = library.value.books;

      setState({ kind: "working", step: "matching", sourceLabel, done: 0, total: 0 });
      const seen = new Set<string>();
      const entries = shelfEntriesRef.current.filter((entry) => {
        if (!entry.contentHash || entry.available === false || !isLocalEpub(entry.fileName) || seen.has(entry.contentHash)) return false;
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
      const locals = localImportBooks(entries, candidates);
      setState({ kind: "match", sourceLabel, rows: matchRows(session.library, locals), locals });
    } catch (error) {
      if (current(session)) end({ kind: "error", text: readestErrorText(error) });
    }
    return "handled";
  }, [end, setShelfNotice, shelfEntriesRef]);

  const updateRows = useCallback((update: (rows: MatchRow[]) => MatchRow[]): void => {
    setState((previous) => (previous.kind === "match" ? { ...previous, rows: update(previous.rows) } : previous));
  }, []);

  const updateReviews = useCallback((update: (reviews: BookReview[]) => BookReview[]): void => {
    setState((previous) => (previous.kind === "review" ? { ...previous, reviews: update(previous.reviews) } : previous));
  }, []);

  /** Step 1 → 2: read each chosen book's config and convert it against the chosen local book. */
  const next = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || state.kind !== "match") return;
    const { rows, locals, sourceLabel } = state;
    const chosen = rows.filter((row) => row.selected && row.chosen);
    const store = getShelfStore();
    const reviews: BookReview[] = [];
    try {
      for (const [index, row] of chosen.entries()) {
        setState({ kind: "working", step: "converting", sourceLabel, done: index, total: chosen.length });
        let config = session.configs.get(row.readestHash);
        if (config === undefined) {
          // Entries are read one at a time to EOF, never interleaved.
          const entry = await findReadestConfig(session.id, row.readestHash);
          const parsed = entry ? parseReadestBookConfig(await readReadestEntryText(session.id, entry)) : null;
          if (parsed && !parsed.ok) throw Object.assign(new Error(parsed.reason), { code: parsed.reason === "too-large" ? "too-large" : "invalid-data" });
          config = parsed ? parsed.value : null;
          session.configs.set(row.readestHash, config);
        }
        if (!current(session)) return;
        const local = locals.find((book) => book.id === row.chosen)!;
        let preview = null;
        if (config) {
          const opened = await openReadestTarget(store, local);
          try {
            if (!current(session)) return;
            preview = await convertReadestBook(row.readestHash, config, opened.target, Date.now());
          } finally {
            opened.close();
          }
        }
        if (!current(session)) return;
        reviews.push(bookReview(row, local, preview));
      }
      setState({ kind: "review", sourceLabel, rows, locals, reviews });
    } catch (error) {
      if (current(session)) end({ kind: "error", text: readestErrorText(error) });
    }
  }, [end, state]);

  const back = useCallback((): void => {
    setState((previous) => (previous.kind === "review"
      ? { kind: "match", sourceLabel: previous.sourceLabel, rows: previous.rows, locals: previous.locals }
      : previous));
  }, []);

  const commit = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || state.kind !== "review") return;
    const plan = commitPlan(state.reviews);
    if (!plan.ok) {
      setShelfNotice({ kind: "warn", text: uiText(`readestImport.plan.${plan.reason}`, { count: plan.records }) });
      return;
    }
    const isPublic = activeShelfSpace().kind !== "private";
    setState({ kind: "working", step: "committing", sourceLabel: state.sourceLabel, done: 0, total: plan.records });
    try {
      const outcome = await commitReadestImport(session.id, plan.books);
      if (isPublic && (outcome.bookmarksAdded || outcome.notesAdded || outcome.progressWritten)) noteCloudSyncChange("data-changed");
      // A committed public import still marks sync dirty, but its abandoned UI
      // cannot refresh another shelf or end a newer import session.
      if (!current(session)) return;
      const summary = outcomeSummary(outcome, plan.notChosen);
      let refreshFailed = false;
      try {
        await refreshShelfProjection();
      } catch {
        refreshFailed = true;
      }
      if (!current(session)) return;
      const parts = [uiText("readestImport.done", { added: summary.added, progress: summary.progressWritten })];
      if (summary.skippedExisting) parts.push(uiText("readestImport.done.skipped", { count: summary.skippedExisting }));
      if (summary.progressUnchanged) parts.push(uiText("readestImport.done.unchanged", { count: summary.progressUnchanged }));
      if (summary.notImported) parts.push(uiText("readestImport.done.notImported", { count: summary.notImported }));
      if (refreshFailed) parts.push(uiText("notice.shelf.refreshFailedShort"));
      end({ kind: summary.notImported || refreshFailed ? "warn" : "ok", text: parts.join(uiText("notice.sep")) });
    } catch (error) {
      if (current(session)) end({ kind: "error", text: readestErrorText(error) });
    }
  }, [end, refreshShelfProjection, setShelfNotice, state]);

  const cancel = useCallback((): void => {
    if (state.kind === "working" && state.step === "committing") return;
    end();
  }, [end, state]);

  return { state, active: state.kind !== "idle", tryStart, updateRows, updateReviews, next, back, commit, cancel };
}
