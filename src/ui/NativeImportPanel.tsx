import type { AndroidImportPhase } from "../platform/androidNativeBridge";
import "./nativeImportPanel.css";
import { uiText, useUiText } from "./localization/UiLanguageProvider";

export type NativeImportCancelState = "idle" | "requesting" | "too_late";

export interface NativeImportPanelProps {
  phase: "starting" | AndroidImportPhase;
  completed: number;
  total: number;
  fileNameSummary: string;
  cancelState: NativeImportCancelState;
  collapsed: boolean;
  onToggleCollapsed(): void;
  onCancel(): void;
}

function phaseText(phase: NativeImportPanelProps["phase"], completed: number, total: number): string {
  if (phase === "starting") return uiText("importProgress.starting");
  if (phase === "committing") return uiText("importProgress.committing");
  return total > 0 ? uiText("importProgress.processed", { completed, total }) : uiText("importProgress.preparing");
}

export function NativeImportPanel(props: NativeImportPanelProps) {
  const { t } = useUiText();
  const status = phaseText(props.phase, props.completed, props.total);
  const cancelDisabled = props.phase !== "preparing" || props.cancelState !== "idle";

  if (props.collapsed) {
    return (
      <button
        type="button"
        className="native-import-pill"
        onClick={props.onToggleCollapsed}
        aria-label={t("importProgress.expand", { status })}
        aria-expanded={false}
      >
        <span className="native-import-pill-dot" aria-hidden="true" />
        <span>{status}</span>
      </button>
    );
  }

  return (
    <section className="native-import-panel" role="status" aria-live="polite" aria-label={t("importProgress.region")}>
      <div className="native-import-head">
        <div className="native-import-title">
          <span>{t("importProgress.title")}</span>
          {props.fileNameSummary && <span className="native-import-file">{props.fileNameSummary}</span>}
        </div>
        <button
          type="button"
          className="native-import-collapse"
          onClick={props.onToggleCollapsed}
          aria-label={t("importProgress.collapse")}
          aria-expanded
        >
          −
        </button>
      </div>
      <div className="native-import-body">
        <span>{status}</span>
        {props.cancelState === "requesting" && <span className="native-import-cancel-state">{t("importProgress.cancelRequested")}</span>}
        {props.cancelState === "too_late" && <span className="native-import-cancel-state">{t("importProgress.tooLate")}</span>}
      </div>
      <div className="native-import-actions">
        <button
          type="button"
          className="native-import-cancel"
          onClick={props.onCancel}
          disabled={cancelDisabled}
        >
          {props.cancelState === "idle" ? t("importProgress.cancel") : t("importProgress.canceling")}
        </button>
      </div>
    </section>
  );
}
