/**
 * Owns one single-book KOReader progress import (ER-0138): pick sidecar →
 * choose local book → compare → confirm or cancel. Every exit closes the
 * native session; a reply that arrives after the dialog moved on is dropped.
 * Parsing and XPointer conversion come from render/interop/koreaderProgress.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Locator, ProgressValue } from "../../core/portableState/portable-state-types";
import type { Version } from "../../core/portableState/portable-register-core";
import {
  closeKoreaderSidecar,
  commitKoreaderProgress,
  koreaderImportTarget,
  openKoreaderSidecar,
  readKoreaderSidecarText,
  type KoreaderImportScope,
} from "../../platform/koreaderImportNativeBridge";
import { saveFileErrorCode, saveFileErrorMessage, type SaveFileLocation } from "../../platform/saveFileNativeBridge";
import { ChapterTextIndex } from "../../render/interop/epubCfi";
import {
  readKoreaderProgressSidecar,
  resolveKoreaderProgressPoint,
  type KoreaderProgressSidecar,
} from "../../render/interop/koreaderProgress";
import { noteCloudSyncChange } from "../cloudSync/cloudSyncStore";
import { uiText } from "../localization/UiLanguageProvider";
import { activatePortableShelfState, getShelfStore, type ShelfEntry, type ShelfStore } from "../shelf";
import { activeShelfSpace, subscribeShelfSpace } from "../shelfSpaces";
import type { ShelfNotice } from "../useShelfLibrary";
import { isLocalEpub } from "../readestImport/readestImportModel";
import { openReadestTarget } from "../readestImport/readestLocalTarget";
import {
  koreaderBlockReason,
  koreaderCandidateBasis,
  koreaderProgressHint,
  sameKoreaderLocator,
  type KoreaderImportState,
  type KoreaderLocalBook,
  type KoreaderPreview,
} from "./koreaderImportModel";

interface LocalRow {
  entry: { id: string; fileName: string };
  bookHash: string;
  targetToken: string;
  display: Version<ProgressValue> | null;
  conflict: boolean;
}

interface Session {
  id: string;
  generation: number;
  sourceLabel: string;
  sidecar: KoreaderProgressSidecar | null;
  rows: Map<string, LocalRow>;
  /** The confirmed-able position of the current preview, for the book it was made against. */
  prepared: { bookId: string; progress: { locator: Locator; progressPctHint: number } } | null;
}

export interface KoreaderImportDeps {
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  refreshShelfProjection(): Promise<unknown>;
  setShelfNotice: Dispatch<SetStateAction<ShelfNotice>>;
  /** Opens the system picker; null when the user backs out. */
  pickSidecar(): Promise<{ source: SaveFileLocation; label: string } | null>;
  /** The existing save barrier for one book's reading progress; throws when it cannot be cleared. */
  beforeCommit(entry: { id: string; bookHash: string }): Promise<void>;
}

/** Errors that end the whole session; anything else only drops one candidate book. */
const SESSION_ERRORS = new Set(["locked", "session-closed", "cancelled", "busy", "repository-unavailable", "unavailable", "storage-error", "not-ready"]);

function scopeFor(store: ShelfStore): KoreaderImportScope | null {
  if (activeShelfSpace().kind !== "private") return { kind: "public" };
  const id = (store as { privateSessionId?: unknown }).privateSessionId;
  return typeof id === "string" ? { kind: "private", sessionId: id } : null;
}

/** Notice text for a native error code; unknown codes show the message. */
export function koreaderErrorText(error: unknown): string {
  switch (saveFileErrorCode(error)) {
    case "invalid-data": case "invalid-request": case "invalid-entity": return uiText("koreaderImport.error.invalid");
    case "too-large": return uiText("koreaderImport.error.tooLarge");
    case "source-changed": case "stale-basis": return uiText("koreaderImport.error.changed");
    case "reader-busy": return uiText("koreaderImport.error.readerBusy");
    case "source-unbound": return uiText("koreaderImport.error.unbound");
    case "locked": case "session-closed": case "cancelled": return uiText("koreaderImport.error.closed");
    case "busy": case "repository-unavailable": return uiText("koreaderImport.error.busy");
    case "random-access-required": case "unsupported-platform": return uiText("koreaderImport.error.randomAccess");
    default: return uiText("koreaderImport.error.other", { error: saveFileErrorMessage(error) });
  }
}

function chapterTitleOf(doc: Document): string | null {
  const text = (doc.querySelector("h1, h2, h3")?.textContent ?? doc.querySelector("title")?.textContent ?? "").replace(/\s+/g, " ").trim();
  return text ? Array.from(text).slice(0, 80).join("") : null;
}

export function useKoreaderImport({ shelfEntriesRef, refreshShelfProjection, setShelfNotice, pickSidecar, beforeCommit }: KoreaderImportDeps) {
  const [state, setState] = useState<KoreaderImportState>({ kind: "idle" });
  const sessionRef = useRef<Session | null>(null);
  const generationRef = useRef(0);
  const launchingRef = useRef(false);

  const release = useCallback((session: Session | null): void => {
    if (!session) return;
    if (sessionRef.current === session) sessionRef.current = null;
    void closeKoreaderSidecar(session.id).catch(() => undefined);
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

  const start = useCallback(async (): Promise<void> => {
    if (sessionRef.current || launchingRef.current) {
      setShelfNotice({ kind: "warn", text: uiText("koreaderImport.error.busy") });
      return;
    }
    launchingRef.current = true;
    let picked: { source: SaveFileLocation; label: string } | null;
    try {
      picked = await pickSidecar();
    } catch (error) {
      setShelfNotice({ kind: "error", text: koreaderErrorText(error) });
      return;
    } finally {
      launchingRef.current = false;
    }
    if (!picked || sessionRef.current) return;
    const { source, label: sourceLabel } = picked;
    const generation = ++generationRef.current;
    const session: Session = { id: crypto.randomUUID(), generation, sourceLabel, sidecar: null, rows: new Map(), prepared: null };
    sessionRef.current = session;
    setState({ kind: "working", step: "opening", sourceLabel, done: 0, total: 0 });
    try {
      await activatePortableShelfState();
      if (!current(session)) return;
      const store = getShelfStore();
      const scope = scopeFor(store);
      if (!scope) throw Object.assign(new Error("private shelf locked"), { code: "locked" });
      await openKoreaderSidecar({ sessionId: session.id, source, scope });
      if (!current(session)) return;
      const text = await readKoreaderSidecarText(session.id);
      if (!current(session)) return;
      const parsed = readKoreaderProgressSidecar(text);
      if (!parsed.ok) throw Object.assign(new Error(parsed.detail), { code: parsed.errorCode === "too-large" ? "too-large" : "invalid-data" });
      if (!parsed.sidecar.lastXPointer) {
        end({ kind: "warn", text: uiText("koreaderImport.block.no-progress") });
        return;
      }
      session.sidecar = parsed.sidecar;

      const seen = new Set<string>();
      const entries = shelfEntriesRef.current.filter((entry) => {
        if (!entry.contentHash || entry.available === false || !isLocalEpub(entry.fileName) || seen.has(entry.contentHash)) return false;
        seen.add(entry.contentHash);
        return true;
      });
      const books: KoreaderLocalBook[] = [];
      for (const [index, entry] of entries.entries()) {
        setState({ kind: "working", step: "matching", sourceLabel, done: index, total: entries.length });
        let row;
        try {
          row = await koreaderImportTarget(session.id, entry.contentHash!);
        } catch (error) {
          if (!current(session)) return;
          if (SESSION_ERRORS.has(saveFileErrorCode(error) ?? "")) throw error;
          continue; // This book cannot receive the position (unbound, unreadable, changed); leave it out.
        }
        if (!current(session)) return;
        const display = row.progress.display;
        session.rows.set(entry.id, {
          entry: { id: entry.id, fileName: entry.fileName },
          bookHash: row.bookHash,
          targetToken: row.targetToken,
          display,
          conflict: row.progress.conflict,
        });
        books.push({
          id: entry.id,
          title: entry.title,
          author: entry.creator ?? "",
          progressPct: display?.value ? display.value.progressPctHint : null,
          progressUpdatedAtMs: display?.value ? display.updatedAtMs : null,
          basis: koreaderCandidateBasis(parsed.sidecar, { partialMd5: row.partialMd5, title: entry.title }),
        });
      }
      // A single digest match is preselected; the user still sees it and confirms twice.
      const digest = books.filter((book) => book.basis === "partial-md5");
      const sidecarSummary = { label: sourceLabel, title: parsed.sidecar.title, author: null };
      setState({ kind: "choose", sidecar: sidecarSummary, books, chosen: digest.length === 1 ? digest[0].id : null });
    } catch (error) {
      if (current(session)) end({ kind: "error", text: koreaderErrorText(error) });
    }
  }, [end, pickSidecar, setShelfNotice, shelfEntriesRef]);

  const choose = useCallback((bookId: string): void => {
    setState((previous) => (previous.kind === "choose" ? { ...previous, chosen: bookId } : previous));
  }, []);

  /** Choose → preview: convert the sidecar position against the chosen local book. */
  const next = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || state.kind !== "choose" || !state.chosen) return;
    const { sidecar, books, chosen } = state;
    const row = session.rows.get(chosen);
    const parsed = session.sidecar;
    if (!row || !parsed) return;
    session.prepared = null;
    setState({ kind: "working", step: "previewing", sourceLabel: sidecar.label, done: 0, total: 0 });
    try {
      const opened = await openReadestTarget(getShelfStore(), row.entry);
      let preview: KoreaderPreview;
      try {
        if (!current(session)) return;
        const { target } = opened;
        const spinePaths = target.spineIdrefs.map((_, index) => target.chapterPath(index) ?? "");
        // The core asks for exactly one chapter synchronously; find which, load it, then convert.
        let wanted: number | null = null;
        const probe = resolveKoreaderProgressPoint(parsed.lastXPointer, {
          spinePaths, creDomVersion: parsed.creDomVersion, chapterDocument: (index) => { wanted = index; return null; },
        });
        let result = probe;
        let doc: Document | null = null;
        if (wanted !== null) {
          const index: number = wanted;
          doc = await target.loadChapter(index);
          if (!current(session)) return;
          result = resolveKoreaderProgressPoint(parsed.lastXPointer, {
            spinePaths, creDomVersion: parsed.creDomVersion, chapterDocument: (at) => (at === index ? doc : null),
          });
        }
        const local = { progressPct: row.display?.value ? row.display.value.progressPctHint : null, updatedAtMs: row.display?.value ? row.display.updatedAtMs : null };
        if (result.ok && result.locator.target.kind === "text" && doc) {
          const { locator } = result;
          const offset = result.locator.target.offset;
          const pct = koreaderProgressHint(locator.spineIndexHint, spinePaths.length, offset, new ChapterTextIndex(doc).totalChars);
          const same = sameKoreaderLocator(row.display?.value?.locator, locator);
          preview = {
            bookId: chosen,
            koreader: { progressPct: pct, updatedAtMs: null },
            local,
            localConflict: row.conflict,
            target: { spineIndex: locator.spineIndexHint, chapterTitle: chapterTitleOf(doc), excerpt: locator.target.kind === "text" ? locator.target.snippet : null },
            status: same ? { kind: "same" } : { kind: "ready" },
          };
          if (!same) session.prepared = { bookId: chosen, progress: { locator, progressPctHint: pct } };
        } else {
          const blocked = result.ok ? { reason: "unsupported-position" as const, code: result.locator.target.kind } : koreaderBlockReason(result.reasons);
          preview = {
            bookId: chosen,
            koreader: { progressPct: null, updatedAtMs: null },
            local,
            localConflict: row.conflict,
            target: null,
            status: { kind: "blocked", ...blocked },
          };
        }
      } finally {
        opened.close();
      }
      if (!current(session)) return;
      setState({ kind: "preview", sidecar, books, chosen, preview });
    } catch (error) {
      if (current(session)) end({ kind: "error", text: koreaderErrorText(error) });
    }
  }, [end, state]);

  const back = useCallback((): void => {
    const session = sessionRef.current;
    if (session) session.prepared = null;
    setState((previous) => (previous.kind === "preview"
      ? { kind: "choose", sidecar: previous.sidecar, books: previous.books, chosen: previous.chosen }
      : previous));
  }, []);

  const confirm = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || state.kind !== "preview" || state.preview.status.kind !== "ready") return;
    const prepared = session.prepared;
    const row = session.rows.get(state.chosen);
    if (!prepared || prepared.bookId !== state.chosen || !row) return;
    const title = state.books.find((book) => book.id === state.chosen)?.title ?? "";
    const isPublic = activeShelfSpace().kind !== "private";
    setState({ kind: "working", step: "committing", sourceLabel: state.sidecar.label, done: 0, total: 0 });
    try {
      await beforeCommit({ id: row.entry.id, bookHash: row.bookHash });
      if (!current(session)) return;
      const outcome = await commitKoreaderProgress(session.id, {
        bookHash: row.bookHash,
        targetToken: row.targetToken,
        progress: prepared.progress,
      });
      if (isPublic && outcome.progressWritten) noteCloudSyncChange("data-changed");
      // The write is done; an abandoned dialog must not refresh another shelf or end a newer session.
      if (!current(session)) return;
      let refreshFailed = false;
      try {
        await refreshShelfProjection();
      } catch {
        refreshFailed = true;
      }
      if (!current(session)) return;
      const parts = [outcome.progressWritten
        ? uiText("koreaderImport.done", { title })
        : uiText("koreaderImport.done.unchanged", { title })];
      if (refreshFailed) parts.push(uiText("notice.shelf.refreshFailedShort"));
      end({ kind: refreshFailed ? "warn" : "ok", text: parts.join(uiText("notice.sep")) });
    } catch (error) {
      if (current(session)) end({ kind: "error", text: koreaderErrorText(error) });
    }
  }, [beforeCommit, end, refreshShelfProjection, state]);

  const cancel = useCallback((): void => {
    if (state.kind === "working" && state.step === "committing") return;
    end();
  }, [end, state]);

  return { state, active: state.kind !== "idle", start, choose, next, back, confirm, cancel };
}
