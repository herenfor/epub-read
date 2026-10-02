import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

export const NOTE_CONTENT_MAX_CODE_POINTS = 10_000;

export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function isNoteContentSavable(value: string): boolean {
  return value.trim().length > 0 && countCodePoints(value) <= NOTE_CONTENT_MAX_CODE_POINTS;
}

export function getNoteContentError(value: string): "empty" | "too-long" | null {
  if (countCodePoints(value) > NOTE_CONTENT_MAX_CODE_POINTS) return "too-long";
  if (value.trim().length === 0) return "empty";
  return null;
}

export interface NoteComposerProps {
  selectedText: string;
  initialContent?: string;
  mode?: "create" | "edit";
  title?: string;
  onSave(content: string): void;
  onCancel(): void;
  /** 报告未保存编辑，供根 Back 协调者确认后再关闭。 */
  onDirtyChange?(dirty: boolean): void;
}

export function NoteComposer(props: NoteComposerProps) {
  const [content, setContent] = useState(() => props.initialContent ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const count = countCodePoints(content);
  const valid = isNoteContentSavable(content);
  const editing = props.mode === "edit" || (props.mode === undefined && props.initialContent !== undefined);
  const title = props.title ?? (editing ? "编辑笔记" : "添加笔记");
  const contentError = getNoteContentError(content);
  const dirty = content !== (props.initialContent ?? "");

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    props.onDirtyChange?.(dirty);
  }, [dirty, props.onDirtyChange]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    if (countCodePoints(next) <= NOTE_CONTENT_MAX_CODE_POINTS) setContent(next);
  };
  const save = () => {
    if (valid) props.onSave(content.trim());
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  };

  return (
    <div className="note-composer" role="dialog" aria-modal="true" aria-label={title}>
      <div className="note-composer-head"><span>{title}</span><button type="button" className="tb-btn" onClick={props.onCancel} aria-label={`关闭${title}`}>✕</button></div>
      <div className="note-selected-text" title={props.selectedText}>{props.selectedText}</div>
      <textarea
        ref={textareaRef}
        className="note-composer-input"
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="写下此刻的想法…"
        aria-label="笔记内容"
      />
      <div className={`note-composer-count${count >= NOTE_CONTENT_MAX_CODE_POINTS ? " is-limit" : ""}`}>
        {count}/{NOTE_CONTENT_MAX_CODE_POINTS}
      </div>
      {contentError === "empty" && content.length > 0 && <div className="note-composer-error">笔记内容不能为空</div>}
      {contentError === "too-long" && <div className="note-composer-error">笔记内容不能超过 {NOTE_CONTENT_MAX_CODE_POINTS} 个字符</div>}
      <div className="note-composer-actions">
        <button type="button" className="tb-btn" onClick={props.onCancel}>取消</button>
        <button type="button" className="tb-btn active" disabled={!valid} onClick={save}>保存</button>
      </div>
    </div>
  );
}
