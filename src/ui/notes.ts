import {
  codePointLength,
  normalizeAnchorText,
  sanitizePersistedTextAnchor,
} from "../render/textAnchor";

/** Maximum size of the selected source text kept in a portable note. */
export const MAX_NOTE_SELECTED_CODE_POINTS = 4096;
/** Maximum size of user-authored note content kept in a portable note. */
export const MAX_NOTE_CONTENT_CODE_POINTS = 10000;

/**
 * A note is anchored to normalized Unicode text, not to a page or percentage.
 * Offsets are code-point offsets in the chapter's whitespace-normalized text.
 */
export interface ReaderNote {
  id: string;
  spineIndex: number;
  chapterPath: string;
  startTextOffset: number;
  endTextOffset: number;
  startTextSnippet: string;
  endTextSnippet: string;
  selectedText: string;
  content: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ReaderNoteValidation {
  valid: boolean;
  field?: string;
  reason?: string;
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validStartSnippet(offset: unknown, snippet: unknown): boolean {
  if (!safeOffset(offset) || typeof snippet !== "string") return false;
  const normalized = sanitizePersistedTextAnchor({
    textOffset: offset,
    textSnippet: snippet,
  });
  return normalized.textOffset === offset && normalized.textSnippet === snippet;
}

function validEndSnippet(snippet: unknown): boolean {
  return (
    typeof snippet === "string" &&
    snippet.length > 0 &&
    codePointLength(snippet) <= 32 &&
    normalizeAnchorText(snippet) === snippet
  );
}

/** Validate the persisted note contract at every storage boundary. */
export function validateReaderNote(value: unknown): ReaderNoteValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "expected a note object" };
  }
  const note = value as Record<string, unknown>;
  if (!requiredString(note.id)) return { valid: false, field: "id", reason: "must be non-empty" };
  if (!safeOffset(note.spineIndex)) {
    return { valid: false, field: "spineIndex", reason: "must be a non-negative safe integer" };
  }
  if (!requiredString(note.chapterPath)) {
    return { valid: false, field: "chapterPath", reason: "must be non-empty" };
  }
  if (!safeOffset(note.startTextOffset)) {
    return { valid: false, field: "startTextOffset", reason: "must be a non-negative safe integer" };
  }
  if (!safeOffset(note.endTextOffset) || (note.endTextOffset as number) <= (note.startTextOffset as number)) {
    return { valid: false, field: "endTextOffset", reason: "must be greater than startTextOffset" };
  }
  if (!validStartSnippet(note.startTextOffset, note.startTextSnippet)) {
    return { valid: false, field: "startTextSnippet", reason: "must be a non-whitespace snippet of at most 32 code points" };
  }
  if (!validEndSnippet(note.endTextSnippet)) {
    return { valid: false, field: "endTextSnippet", reason: "must be a non-whitespace snippet of at most 32 code points" };
  }
  const selectedText = note.selectedText as string;
  const selectedNormalizedLength = requiredString(selectedText)
    ? codePointLength(normalizeAnchorText(selectedText))
    : 0;
  if (
    !requiredString(selectedText) ||
    codePointLength(selectedText) > MAX_NOTE_SELECTED_CODE_POINTS ||
    selectedNormalizedLength !== (note.endTextOffset as number) - (note.startTextOffset as number)
  ) {
    return { valid: false, field: "selectedText", reason: `must be non-empty and at most ${MAX_NOTE_SELECTED_CODE_POINTS} code points` };
  }
  if (!requiredString(note.content) || codePointLength(note.content as string) > MAX_NOTE_CONTENT_CODE_POINTS) {
    return { valid: false, field: "content", reason: `must be non-empty and at most ${MAX_NOTE_CONTENT_CODE_POINTS} code points` };
  }
  if (!validTime(note.createdAtMs)) {
    return { valid: false, field: "createdAtMs", reason: "must be a non-negative safe integer" };
  }
  if (!validTime(note.updatedAtMs)) {
    return { valid: false, field: "updatedAtMs", reason: "must be a non-negative safe integer" };
  }
  // CP-I: v3 stores modification time in Version.updatedAtMs and explicitly
  // allows device wall-clock rollback relative to the preserved creation time.
  return { valid: true };
}

/** Return a defensive, typed copy or null for legacy/corrupt persisted data. */
export function normalizeReaderNote(value: unknown): ReaderNote | null {
  if (!validateReaderNote(value).valid) return null;
  const note = value as ReaderNote;
  return { ...note };
}

export function normalizeReaderNotes(values: unknown): ReaderNote[] {
  if (!Array.isArray(values)) return [];
  return values.map(normalizeReaderNote).filter((note): note is ReaderNote => note !== null);
}

export function hasDuplicateReaderNoteIds(notes: readonly ReaderNote[]): boolean {
  const ids = new Set<string>();
  for (const note of notes) {
    if (ids.has(note.id)) return true;
    ids.add(note.id);
  }
  return false;
}
