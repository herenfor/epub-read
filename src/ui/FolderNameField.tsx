import { useId, type RefObject } from "react";
import { codePointCount, MAX_FOLDER_NAME_CODE_POINTS } from "./libraryOrganization";
import { folderNameDraftError } from "./folderNameDraft";
import { useUiText } from "./localization/UiLanguageProvider";

/** Keep the complete draft, including IME/paste input; never truncate a user's name. */
export function FolderNameField(props: {
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  error: string | null;
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const { t } = useUiText();
  const hintId = useId();
  const count = codePointCount(props.value.trim());
  const overflow = count > MAX_FOLDER_NAME_CODE_POINTS;
  const error = overflow ? folderNameDraftError("too-long") : props.error;
  return <>
    <input
      ref={props.inputRef}
      className="shelf-dialog-input"
      type="text"
      aria-label={t("folder.name.label")}
      aria-describedby={hintId}
      aria-invalid={!!error}
      placeholder={props.placeholder}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    />
    <div id={hintId} className="shelf-folder-name-hint">
      <span>{t("folder.name.count", { count, limit: MAX_FOLDER_NAME_CODE_POINTS })}</span>
      {error && <span className="shelf-dialog-error" role="alert">{error}</span>}
    </div>
  </>;
}
