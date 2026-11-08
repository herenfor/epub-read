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

interface PendingNoteDelete {
  shelfId: string;
  noteId: string;
  origin: NoteDeleteOrigin;
}

const NO_IDS: readonly string[] = [];

/**
 * One-step note delete with undo (ER-0105). The note is only hidden while
 * the undo is offered and the delete is written when that time runs out, so
 * undo writes nothing and sync never sees a delete followed by a re-create.
 * A newer delete or leaving the book commits the previous one at once;
 * quitting the app inside the window keeps the note.
 */
export function usePendingNoteDelete({ currentShelfId, commitDelete }: {
  currentShelfId: string | null;
  commitDelete(shelfId: string, noteId: string): Promise<NoteDeleteResult>;
}) {
  const [pending, setPending] = useState<PendingNoteDelete | null>(null);
  /** Notes whose delete is being written: still hidden until the write settles. */
  const [committing, setCommitting] = useState<readonly string[]>(NO_IDS);
  const pendingRef = useRef<PendingNoteDelete | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(commitDelete);
  useLayoutEffect(() => {
    commitRef.current = commitDelete;
  });

  const flush = useCallback(() => {
    const item = pendingRef.current;
    if (!item) return;
    pendingRef.current = null;
    clearTimeout(timerRef.current);
    setPending(null);
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
  }, []);

  const requestDelete = useCallback((noteId: string, origin: NoteDeleteOrigin = "sidebar") => {
    if (!currentShelfId) return;
    if (pendingRef.current?.noteId === noteId) return;
    flush();
    const item = { shelfId: currentShelfId, noteId, origin };
    pendingRef.current = item;
    setPending(item);
    timerRef.current = setTimeout(flush, NOTE_UNDO_MS);
  }, [currentShelfId, flush]);

  const undoDelete = useCallback(() => {
    if (!pendingRef.current) return;
    pendingRef.current = null;
    clearTimeout(timerRef.current);
    setPending(null);
  }, []);

  // Closing or switching the book ends the undo window.
  useEffect(() => {
    if (pendingRef.current && pendingRef.current.shelfId !== currentShelfId) flush();
  }, [currentShelfId, flush]);

  // Unmount means the app is going away: drop the timer, keep the note.
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const live = pending && pending.shelfId === currentShelfId ? pending : null;
  const pendingNoteId = live?.noteId ?? null;
  const pendingOrigin = live?.origin ?? null;
  const hiddenNoteIds = useMemo(
    () => (pendingNoteId ? [...committing, pendingNoteId] : committing),
    [committing, pendingNoteId],
  );
  return { pendingNoteId, pendingOrigin, hiddenNoteIds, requestDelete, undoDelete };
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
