import { useEffect, useRef, useState, type CSSProperties } from "react";
import "./undoPill.css";

export interface UndoPillProps {
  /** What happened, e.g. "已删除笔记". */
  message: string;
  /** Faint hint naming the item, e.g. the first words of the note. */
  detail?: string;
  undoLabel: string;
  onUndo(): void;
  /** The drain line runs out over this time; the owner removes the pill. */
  durationMs: number;
  /** When the window began; a pill shown late starts its drain part-way. */
  startedAtMs?: number;
  /** Take focus on mount (the control that was used has just gone away). */
  autoFocus?: boolean;
  className?: string;
}

/**
 * "Deleted · Undo" shown while a delete can still be undone (ER-0105). The
 * owner places it: in the sidebar it replaces the deleted card in place;
 * the highlight menu can float the same pill over the page.
 */
export function UndoPill({ message, detail, undoLabel, onUndo, durationMs, startedAtMs, autoFocus, className }: UndoPillProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Read once at mount: the drain is one CSS animation, a negative delay skips the part already spent.
  const [delayMs] = useState(() => (startedAtMs === undefined ? 0 : Math.min(0, Math.max(-durationMs, startedAtMs - Date.now()))));
  useEffect(() => {
    if (autoFocus) buttonRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <div className={`ui-undo-pill${className ? ` ${className}` : ""}`} role="status" aria-live="polite"
      style={{ "--ui-undo-ms": `${durationMs}ms`, "--ui-undo-delay": `${delayMs}ms` } as CSSProperties}>
      <span className="ui-undo-pill-text">
        {message}
        {detail ? <span className="ui-undo-pill-detail"> · {detail}</span> : null}
      </span>
      <button ref={buttonRef} type="button" className="ui-undo-pill-button" onClick={onUndo}>{undoLabel}</button>
      <span className="ui-undo-pill-drain" aria-hidden="true" />
    </div>
  );
}

/** First characters of a text for the pill's detail, never splitting a surrogate pair. */
export function undoDetail(text: string, chars = 10): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const head = Array.from(flat);
  return head.length > chars ? `${head.slice(0, chars).join("")}…` : flat;
}
