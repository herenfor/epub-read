import { useUiText } from "./localization/UiLanguageProvider";
import "./readerReturn.css";

export interface ReaderReturnControlProps {
  /** Where "back" returns to: a chapter name, "" for the current chapter, null when there is nothing to return to. */
  back: string | null;
  forward: string | null;
  onBack(): void;
  onForward(): void;
  /** Phone: centred above the bottom bar (`raised` while the bar is shown). Desktop: bottom-left corner. */
  placement: "phone" | "desktop";
  raised?: boolean;
}

/**
 * Return to where a jump (footnote/link, search result, contents, note,
 * bookmark) started, and forward again after returning. Shown by the app
 * right after such a jump and, on phones, whenever the reading tools are out.
 */
export function ReaderReturnControl(props: ReaderReturnControlProps) {
  const { t } = useUiText();
  if (props.back === null && props.forward === null) return null;
  return (
    <div
      className={`reader-return is-${props.placement}${props.raised ? " is-raised" : ""}`}
      role="group"
      aria-label={t("readerMisc.return.group")}
    >
      {props.back !== null && (
        <button
          type="button"
          className="reader-return-btn is-back"
          onClick={props.onBack}
          title={t("readerMisc.return.back.tip")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 12L6 8l4-4" />
          </svg>
          <span className="reader-return-label">
            {props.back ? t("readerMisc.return.backTo", { place: props.back }) : t("readerMisc.return.back")}
          </span>
        </button>
      )}
      {props.forward !== null && (
        <button
          type="button"
          className="reader-return-btn is-forward"
          onClick={props.onForward}
          title={t("readerMisc.return.forward.tip")}
        >
          <span className="reader-return-label">
            {props.forward ? t("readerMisc.return.forwardTo", { place: props.forward }) : t("readerMisc.return.forward")}
          </span>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
      )}
    </div>
  );
}
