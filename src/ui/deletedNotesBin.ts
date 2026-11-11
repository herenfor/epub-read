import { useCallback, useMemo, useState } from "react";
import { validateReaderNote, type ReaderNote } from "./notes";

/** Notes and highlights kept per book after their delete was written. */
export const DELETED_NOTES_PER_BOOK = 10;
/** Books remembered at once; the one untouched longest is dropped first. */
const DELETED_NOTES_BOOKS = 40;
const KEY = "epub-reader:deleted-notes";

export interface DeletedNote {
  note: ReaderNote;
  deletedAtMs: number;
}

type Bin = Record<string, DeletedNote[]>;

function parseBin(raw: string | null): Bin {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const bin: Bin = {};
  for (const [shelfId, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const items = list.filter((item): item is DeletedNote =>
      Boolean(item) && Number.isFinite(item.deletedAtMs) && validateReaderNote(item.note).valid);
    if (items.length) bin[shelfId] = items.slice(0, DELETED_NOTES_PER_BOOK);
  }
  return bin;
}

/** Recently deleted notes live on this device only (ER-0180): never synced. */
export function readDeletedNotes(): Bin {
  try {
    return parseBin(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

function writeDeletedNotes(bin: Bin): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(bin));
  } catch {
    // Storage full or blocked: the list still works until the app closes.
  }
}

/** Newest first, capped per book; the book just touched moves to the end of the object. */
export function withDeletedNote(bin: Bin, shelfId: string, note: ReaderNote, deletedAtMs: number): Bin {
  const { [shelfId]: previous = [], ...rest } = bin;
  const items = [{ note, deletedAtMs }, ...previous.filter((item) => item.note.id !== note.id)]
    .slice(0, DELETED_NOTES_PER_BOOK);
  const next: Bin = { ...rest, [shelfId]: items };
  const books = Object.keys(next);
  for (const stale of books.slice(0, Math.max(0, books.length - DELETED_NOTES_BOOKS))) delete next[stale];
  return next;
}

export function withoutDeletedNote(bin: Bin, shelfId: string, noteId: string): Bin {
  const previous = bin[shelfId];
  if (!previous?.some((item) => item.note.id === noteId)) return bin;
  const { [shelfId]: _dropped, ...rest } = bin;
  const items = previous.filter((item) => item.note.id !== noteId);
  return items.length ? { ...rest, [shelfId]: items } : rest;
}

const NONE: readonly DeletedNote[] = [];

export function useDeletedNotes(currentShelfId: string | null) {
  const [bin, setBin] = useState<Bin>(readDeletedNotes);
  const update = useCallback((change: (bin: Bin) => Bin) => {
    setBin((previous) => {
      const next = change(previous);
      if (next !== previous) writeDeletedNotes(next);
      return next;
    });
  }, []);
  const rememberDeleted = useCallback((shelfId: string, note: ReaderNote) => {
    update((previous) => withDeletedNote(previous, shelfId, note, Date.now()));
  }, [update]);
  const forgetDeleted = useCallback((shelfId: string, noteId: string) => {
    update((previous) => withoutDeletedNote(previous, shelfId, noteId));
  }, [update]);
  const deletedNotes = useMemo(
    () => (currentShelfId ? bin[currentShelfId] ?? NONE : NONE),
    [bin, currentShelfId],
  );
  return { deletedNotes, rememberDeleted, forgetDeleted };
}
