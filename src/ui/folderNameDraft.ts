import { codePointCount, MAX_FOLDER_NAME_CODE_POINTS } from "./libraryOrganization";
import { uiText } from "./localization/UiLanguageProvider";

export type FolderNameDraft =
  | { readonly ok: true; readonly name: string; readonly count: number; readonly unchanged: boolean }
  | { readonly ok: false; readonly code: "empty" | "too-long" | "duplicate"; readonly count: number; readonly limit: number };

/** Form validation returns a visible error choice; persisted organization validation stays strict. */
export function validateFolderNameDraft(
  raw: string,
  existingNames: readonly string[],
  currentName?: string,
): FolderNameDraft {
  const name = raw.trim();
  const count = codePointCount(name);
  const limit = MAX_FOLDER_NAME_CODE_POINTS;
  if (count === 0) return { ok: false, code: "empty", count, limit };
  if (count > limit) return { ok: false, code: "too-long", count, limit };
  if (name !== currentName && existingNames.includes(name)) {
    return { ok: false, code: "duplicate", count, limit };
  }
  return { ok: true, name, count, unchanged: name === currentName };
}

export function folderNameDraftError(code: "empty" | "too-long" | "duplicate"): string {
  switch (code) {
    case "empty": return uiText("folder.name.empty");
    case "too-long": return uiText("folder.name.too-long", { limit: MAX_FOLDER_NAME_CODE_POINTS });
    case "duplicate": return uiText("folder.name.duplicate");
  }
}
