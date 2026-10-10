import { useEffect, useRef } from "react";
import { useUiText } from "./localization/UiLanguageProvider";
import type { SaveFailurePrompt } from "./saveFailureExit";

export interface SaveFailureDialogProps {
  prompt: SaveFailurePrompt;
  onRetry(): void;
  onLeave(): void;
  /** Esc or a click outside: stay where the user was. */
  onDismiss(): void;
}

/**
 * Shown when leaving the reader or closing the window could not save progress.
 * Retry is the default; leaving anyway is always available so a persistent
 * storage error can never trap the user.
 */
export function SaveFailureDialog(props: SaveFailureDialogProps) {
  const { t } = useUiText();
  const retryRef = useRef<HTMLButtonElement>(null);
  const { onDismiss } = props;

  useEffect(() => {
    retryRef.current?.focus();
  }, []);

  useEffect(() => {
    // Capture on window so reader shortcuts (page turns, Esc handling) never
    // act underneath the dialog; button activation is a default action and
    // still happens.
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDismiss]);

  const leaveLabel = props.prompt.kind === "window"
    ? t("notice.saveExit.closeWindow")
    : t("notice.saveExit.leaveShelf");
  const hint = props.prompt.kind === "window"
    ? t("notice.saveExit.window.hint")
    : t("notice.saveExit.shelf.hint");

  return (
    <div className="shelf-confirm-backdrop" onClick={onDismiss}>
      <div
        className="shelf-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="save-failure-title"
        aria-describedby="save-failure-hint"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shelf-confirm-title" id="save-failure-title">{t("notice.saveExit.title")}</div>
        <div className="shelf-confirm-hint save-failure-reason">{t("notice.saveExit.reason", { error: props.prompt.error })}</div>
        <div className="shelf-confirm-hint" id="save-failure-hint">{hint}</div>
        <div className="shelf-confirm-actions">
          <button className="shelf-selection-cancel" type="button" onClick={props.onLeave}>
            {leaveLabel}
          </button>
          <button ref={retryRef} className="shelf-confirm-primary" type="button" onClick={props.onRetry}>
            {t("notice.saveExit.retry")}
          </button>
        </div>
      </div>
    </div>
  );
}
