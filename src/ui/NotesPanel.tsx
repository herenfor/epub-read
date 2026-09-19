import { useMemo, useState } from "react";
import { CloseIcon } from "./readerIcons";

export interface NoteViewModel {
  id: string;
  content: string;
  selectedText: string;
  chapterTitle: string;
  chapterPath?: string;
  createdAtMs: number;
  updatedAtMs?: number;
}

export interface NotesPanelProps {
  notes: readonly NoteViewModel[];
  onClose(): void;
  onNavigate(note: NoteViewModel): void;
  onEdit?(note: NoteViewModel): void;
  onDelete?(note: NoteViewModel): void;
}

export const NOTES_RENDER_LIMIT = 200;

export function sortNotesNewestFirst(notes: readonly NoteViewModel[]): NoteViewModel[] {
  return [...notes].sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
}

export function limitNotesForPanel(notes: readonly NoteViewModel[]): { items: NoteViewModel[]; limited: boolean } {
  return limitNotes(notes, NOTES_RENDER_LIMIT);
}

export function limitNotes(
  notes: readonly NoteViewModel[],
  limit: number,
): { items: NoteViewModel[]; limited: boolean } {
  const sorted = sortNotesNewestFirst(notes);
  const safeLimit = Math.max(0, Math.floor(limit));
  return { items: sorted.slice(0, safeLimit), limited: sorted.length > safeLimit };
}

function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "未知时间";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(timestamp));
}

export function NotesPanel(props: NotesPanelProps) {
  const [visibleLimit, setVisibleLimit] = useState(NOTES_RENDER_LIMIT);
  const rendered = useMemo(() => limitNotes(props.notes, visibleLimit), [props.notes, visibleLimit]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  return (
    <>
      <div className="notes-backdrop" aria-hidden="true" onClick={props.onClose} />
      <aside className="notes-panel" role="dialog" aria-modal="true" aria-label="笔记">
        <div className="drawer-drag-handle" aria-hidden="true" />
        <div className="notes-head">
          <div className="drawer-title-wrap">
            <span>笔记</span>
            <span className="notes-count">{props.notes.length} 条</span>
          </div>
          <button type="button" className="tb-btn tb-close" onClick={props.onClose} aria-label="关闭笔记" title="关闭笔记">
            <CloseIcon size={14} />
          </button>
        </div>
        {rendered.items.length === 0 ? <div className="notes-empty">本书还没有笔记</div> : (
          <div className="notes-list" role="list" aria-label="笔记列表">
            {rendered.items.map((note) => (
              <article className="note-card" role="listitem" key={note.id}>
                <button type="button" className="note-card-main" onClick={() => props.onNavigate(note)}>
                  <span className="note-card-content">{note.content}</span>
                  <span className="note-card-meta">{note.chapterTitle} · {formatDate(note.createdAtMs)}</span>
                  <span className="note-card-selection" title={note.selectedText}>“{note.selectedText}”</span>
                </button>
                <div className="note-card-actions">
                  {props.onEdit && <button type="button" className="note-action" onClick={() => props.onEdit?.(note)}>编辑</button>}
                  {props.onDelete && (deletingId === note.id ? <><span className="note-delete-question">确认删除？</span><button type="button" className="note-action danger" onClick={() => { props.onDelete?.(note); setDeletingId(null); }}>删除</button><button type="button" className="note-action" onClick={() => setDeletingId(null)}>取消</button></> : <button type="button" className="note-action danger" onClick={() => setDeletingId(note.id)}>删除</button>)}
                </div>
              </article>
            ))}
          </div>
        )}
        {rendered.limited && <div className="notes-limited">
          <span>已显示最近 {rendered.items.length} 条</span>
          <button type="button" className="note-show-more" onClick={() => setVisibleLimit((limit) => limit + NOTES_RENDER_LIMIT)}>显示更多</button>
        </div>}
      </aside>
    </>
  );
}
