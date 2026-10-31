import { useEffect, useRef } from "react";
import { useUiText } from "./localization/UiLanguageProvider";

export interface ExternalOpenFailureDialogProps {
  fileName: string;
  onRetry(): void;
  /** Gives up on this file; the next one the system handed over goes ahead. */
  onClose(): void;
}

/**
 * A book opened from outside the app (open-with, file association) could not
 * be imported or opened. The reason was already shown (notice or prompt); this only
 * holds the request until the user retries or lets it go.
 */
export function ExternalOpenFailureDialog(props: ExternalOpenFailureDialogProps) {
  const { t } = useUiText();
  const retryRef = useRef<HTMLButtonElement>(null);
  const { onClose } = props;

  useEffect(() => {
    retryRef.current?.focus();
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
        aria-labelledby="external-open-failure-title"
        aria-describedby="external-open-failure-hint"
      >
        <div className="shelf-confirm-title" id="external-open-failure-title">{t("notice.externalOpen.title")}</div>
        <div className="shelf-confirm-hint save-failure-reason">{props.fileName}</div>
        <div className="shelf-confirm-hint" id="external-open-failure-hint">{t("notice.externalOpen.hint")}</div>
        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={onClose}>
            {t("notice.externalOpen.close")}
          </button>
          <button ref={retryRef} className="shelf-confirm-primary" type="button" onClick={props.onRetry}>
            {t("notice.saveExit.retry")}
          </button>
        </div>
      </div>
    </div>
  );
}
