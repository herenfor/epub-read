import type { FootnotePayload, SelectionContextPayload } from "../render/paginator";
import type { ReaderNote } from "./notes";

/** Ordinary reader surfaces. Add a new member here and its renderer only. */
export type ReaderPanelId = "menu" | "toc" | "bookmarks" | "search" | "notes" | "log" | "assistant";
export type MenuSubview = "main" | "fonts";

export type NoteComposerDraft =
  | { mode: "create"; selection: SelectionContextPayload; spineIndex: number }
  | { mode: "edit"; note: ReaderNote };

export type ReaderForeground =
  | { kind: "none" }
  | ({ kind: "panel"; panel: "menu"; view: MenuSubview })
  | { kind: "panel"; panel: Exclude<ReaderPanelId, "menu"> }
  | { kind: "transient"; transient: "selection"; payload: SelectionContextPayload }
  | { kind: "transient"; transient: "footnote"; payload: FootnotePayload }
  | { kind: "modal"; modal: "note-composer"; draft: NoteComposerDraft };

export const noneForeground = (): ReaderForeground => ({ kind: "none" });

/**
 * Replace the visible ordinary surface. A modal owns the foreground until it
 * is explicitly closed, so toolbar events cannot accidentally stack behind it.
 */
export function openReaderPanel(
  current: ReaderForeground,
  panel: ReaderPanelId,
): ReaderForeground {
  if (current.kind === "modal") return current;
  return panel === "menu"
    ? { kind: "panel", panel: "menu", view: "main" }
    : { kind: "panel", panel };
}

export function setMenuSubview(
  current: ReaderForeground,
  view: MenuSubview,
): ReaderForeground {
  if (current.kind === "modal") return current;
  return { kind: "panel", panel: "menu", view };
}

/** Selection and footnotes are mutually exclusive and replace ordinary panels. */
export function openReaderTransient(
  current: ReaderForeground,
  transient: "selection" | "footnote",
  payload: SelectionContextPayload | FootnotePayload,
): ReaderForeground {
  if (current.kind === "modal") return current;
  return transient === "selection"
    ? { kind: "transient", transient, payload: payload as SelectionContextPayload }
    : { kind: "transient", transient, payload: payload as FootnotePayload };
}

export function updateFootnote(
  current: ReaderForeground,
  update: (payload: FootnotePayload) => FootnotePayload,
): ReaderForeground {
  if (current.kind !== "transient" || current.transient !== "footnote") return current;
  return { ...current, payload: update(current.payload) };
}

export function openNoteComposer(
  _current: ReaderForeground,
  draft: NoteComposerDraft,
): ReaderForeground {
  return { kind: "modal", modal: "note-composer", draft };
}

export function closeReaderForeground(): ReaderForeground {
  return noneForeground();
}
