import { useEffect, useRef } from "react";
import { useUiText } from "./localization/UiLanguageProvider";

export interface OriginalImportRetryDialogProps {
  /** One line per book: its name and why it could not stay at its original place. */
  reasons: readonly string[];
  onCopy(): void;
  onClose(): void;
}

/**
 * Keeping the original failed for some books (no persistent permission, no
 * random access, …). Copying them is offered, never done on the user's behalf.
 */
export function OriginalImportRetryDialog(props: OriginalImportRetryDialogProps) {
  const { t } = useUiText();
  const copyRef = useRef<HTMLButtonElement>(null);
  const { onClose } = props;

  useEffect(() => {
    copyRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="shelf-confirm-backdrop">
      <div
        className="shelf-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="original-retry-title"
        aria-describedby="original-retry-hint"
      >
        <div className="shelf-confirm-title" id="original-retry-title">{t("notice.originalRetry.title")}</div>
        {props.reasons.map((reason, i) => <div key={i} className="shelf-confirm-hint save-failure-reason">{reason}</div>)}
        <div className="shelf-confirm-hint" id="original-retry-hint">{t("notice.originalRetry.hint")}</div>
        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={onClose}>
            {t("notice.originalRetry.close")}
          </button>
          <button ref={copyRef} className="shelf-confirm-primary" type="button" onClick={props.onCopy}>
            {t("notice.originalRetry.copy")}
          </button>
        </div>
      </div>
    </div>
  );
}
