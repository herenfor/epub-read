import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReaderNoteForPaginator } from "../render/paginator";

/** How long a deleted note can be undone; the undo pill drains over the same time. */
export const NOTE_UNDO_MS = 5000;
/** A commit blocked by another note write retries this often, a bounded number of times. */
const BUSY_RETRY_MS = 250;
const BUSY_RETRIES = 20;

export type NoteDeleteResult = "done" | "busy" | "failed";

/** Where the delete was made: the sidebar shows its undo in place, the reader floats it. */
export type NoteDeleteOrigin = "sidebar" | "reader";

export interface PendingNoteDelete {
  shelfId: string;
  noteId: string;
  origin: NoteDeleteOrigin;
  /** When the delete was asked for: the undo pill's drain starts from here. */
  atMs: number;
}

const NO_IDS: readonly string[] = [];
const NO_PENDING: readonly PendingNoteDelete[] = [];

/**
 * One-step note delete with undo (ER-0105). The note is only hidden while
 * the undo is offered and the delete is written when that time runs out, so
 * undo writes nothing and sync never sees a delete followed by a re-create.
 * Several deletes can wait side by side, each on its own clock and undone on
 * its own (ER-0180). Leaving the book commits them all at once; quitting the
 * app inside the window keeps the notes.
 */
export function usePendingNoteDelete({ currentShelfId, commitDelete }: {
  currentShelfId: string | null;
  commitDelete(shelfId: string, noteId: string): Promise<NoteDeleteResult>;
}) {
  const [pending, setPending] = useState<readonly PendingNoteDelete[]>(NO_PENDING);
  /** Notes whose delete is being written: still hidden until the write settles. */
  const [committing, setCommitting] = useState<readonly string[]>(NO_IDS);
  const pendingRef = useRef<readonly PendingNoteDelete[]>(NO_PENDING);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const commitRef = useRef(commitDelete);
  useLayoutEffect(() => {
    commitRef.current = commitDelete;
  });

  /** Takes one waiting delete out of the list; null when it is no longer waiting. */
  const take = useCallback((noteId: string): PendingNoteDelete | null => {
    const item = pendingRef.current.find((entry) => entry.noteId === noteId);
    if (!item) return null;
    clearTimeout(timersRef.current.get(noteId));
    timersRef.current.delete(noteId);
    pendingRef.current = pendingRef.current.filter((entry) => entry !== item);
    setPending(pendingRef.current);
    return item;
  }, []);

  const commit = useCallback((noteId: string) => {
    const item = take(noteId);
    if (!item) return;
    setCommitting((ids) => [...ids, item.noteId]);
    const settle = () => setCommitting((ids) => ids.filter((id) => id !== item.noteId));
    const attempt = (tries: number): void => {
      void commitRef.current(item.shelfId, item.noteId).then(
        (result) => {
          if (result === "busy" && tries < BUSY_RETRIES) setTimeout(() => attempt(tries + 1), BUSY_RETRY_MS);
          else settle();
        },
        settle,
      );
    };
    attempt(0);
  }, [take]);

  const requestDelete = useCallback((noteId: string, origin: NoteDeleteOrigin = "sidebar") => {
    if (!currentShelfId) return;
    if (pendingRef.current.some((entry) => entry.noteId === noteId)) return;
    const item: PendingNoteDelete = { shelfId: currentShelfId, noteId, origin, atMs: Date.now() };
    pendingRef.current = [...pendingRef.current, item];
    setPending(pendingRef.current);
    timersRef.current.set(noteId, setTimeout(() => commit(noteId), NOTE_UNDO_MS));
  }, [currentShelfId, commit]);

  const undoDelete = useCallback((noteId: string) => {
    take(noteId);
  }, [take]);

  // Closing or switching the book ends every undo window of the book left behind.
  useEffect(() => {
    for (const item of pendingRef.current) {
      if (item.shelfId !== currentShelfId) commit(item.noteId);
    }
  }, [currentShelfId, commit]);

  // Unmount means the app is going away: drop the timers, keep the notes.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /** Deletes still waiting in the open book, oldest first. */
  const pendingDeletes = useMemo(
    () => pending.filter((item) => item.shelfId === currentShelfId),
    [pending, currentShelfId],
  );
  const hiddenNoteIds = useMemo(
    () => (pendingDeletes.length ? [...committing, ...pendingDeletes.map((item) => item.noteId)] : committing),
    [committing, pendingDeletes],
  );
  return { pendingDeletes, hiddenNoteIds, requestDelete, undoDelete };
}

/**
 * The text highlights without the hidden notes. Per-chapter lists stay
 * reference-stable (cached per chapter) and fall back to the source list
 * when nothing in that chapter is hidden.
 */
export function useVisibleChapterNotes(
  chapterNotes: ReaderNoteForPaginator[],
  notesForChapter: (index: number) => ReaderNoteForPaginator[],
  hiddenNoteIds: readonly string[],
) {
  const hiddenKey = hiddenNoteIds.join("\n");
  const hidden = useMemo(() => new Set(hiddenKey ? hiddenKey.split("\n") : []), [hiddenKey]);
  const visibleChapterNotes = useMemo(() => withoutHidden(chapterNotes, hidden), [chapterNotes, hidden]);
  const visibleNotesForChapter = useMemo(() => {
    if (hidden.size === 0) return notesForChapter;
    const cache = new Map<number, ReaderNoteForPaginator[]>();
    return (index: number) => {
      let list = cache.get(index);
      if (!list) {
        list = withoutHidden(notesForChapter(index), hidden);
        cache.set(index, list);
      }
      return list;
    };
  }, [notesForChapter, hidden]);
  return { visibleChapterNotes, visibleNotesForChapter };
}

function withoutHidden<T extends { id: string }>(notes: T[], hidden: ReadonlySet<string>): T[] {
  if (hidden.size === 0 || !notes.some((note) => hidden.has(note.id))) return notes;
  return notes.filter((note) => !hidden.has(note.id));
}
