import { useState } from "react";
import type {
  SaveFilePrepareResult,
  SaveFileProgress,
} from "../platform/saveFileNativeBridge";
import type { SaveFileJobState } from "./useSaveFileJob";
import "./saveFileDialogs.css";
import { uiText, useUiText } from "./localization/UiLanguageProvider";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "preparing": return uiText("saveFile.phase.preparing");
    case "reading": return uiText("saveFile.phase.reading");
    case "extracting": return uiText("saveFile.phase.extracting");
    case "writing": return uiText("saveFile.phase.writing");
    case "finalizing": return uiText("saveFile.phase.finalizing");
    case "copying": return uiText("saveFile.phase.copying");
    case "committing": return uiText("saveFile.phase.committing");
    default: return phase || uiText("saveFile.phase.working");
  }
}

function progressText(progress: SaveFileProgress): string {
  const label = phaseLabel(progress.phase);
  if (progress.totalBytes !== null && progress.totalBytes > 0) {
    const pct = Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100));
    return uiText("saveFile.progress.bytes", { phase: label, percent: pct, done: formatBytes(progress.processedBytes), total: formatBytes(progress.totalBytes) });
  }
  if (progress.processedBytes > 0) return uiText("saveFile.progress.processed", { phase: label, done: formatBytes(progress.processedBytes) });
  return uiText("saveFile.progress.pending", { phase: label });
}

export interface SaveFileExportDialogProps {
  selectedCount: number;
  onCancel(): void;
  onConfirm(scope: "all" | "selected", includeBooks: boolean): void;
}

export function SaveFileExportDialog(props: SaveFileExportDialogProps) {
  const { t, tn } = useUiText();
  const [scope, setScope] = useState<"all" | "selected">(props.selectedCount > 0 ? "selected" : "all");
  const [includeBooks, setIncludeBooks] = useState(false);
  return (
    <div className="save-file-backdrop" role="presentation">
      <section className="save-file-dialog" role="dialog" aria-modal="true" aria-label={t("saveFile.export.dialog")}>
        <header className="save-file-dialog-head">
          <h2>{t("saveFile.export.title")}</h2>
          <p>{t("saveFile.export.subtitle")}</p>
        </header>
        <div className="save-file-dialog-body">
          <fieldset className="save-file-fieldset">
            <legend>{t("saveFile.export.scope")}</legend>
            <label className="save-file-radio">
              <input
                type="radio"
                name="save-file-export-scope"
                checked={scope === "all"}
                onChange={() => setScope("all")}
              />
              <span>{t("saveFile.export.all")}</span>
            </label>
            <label className={`save-file-radio${props.selectedCount === 0 ? " disabled" : ""}`}>
              <input
                type="radio"
                name="save-file-export-scope"
                disabled={props.selectedCount === 0}
                checked={scope === "selected"}
                onChange={() => setScope("selected")}
              />
              <span>{props.selectedCount > 0 ? tn("saveFile.export.selectedCount", props.selectedCount, { count: props.selectedCount }) : t("saveFile.export.selectedNone")}</span>
            </label>
          </fieldset>
          <p className="save-file-muted">
            {t("saveFile.export.explain")}
          </p>
          <label className="save-file-check">
            <input
              type="checkbox"
              checked={includeBooks}
              onChange={(event) => setIncludeBooks(event.target.checked)}
            />
            <span>{t("saveFile.export.includeBooks")}</span>
          </label>
        </div>
        <footer className="save-file-dialog-actions">
          <button type="button" onClick={props.onCancel}>{t("saveFile.cancel")}</button>
          <button
            type="button"
            className="primary"
            disabled={scope === "selected" && props.selectedCount === 0}
            onClick={() => props.onConfirm(scope, includeBooks)}
          >
            {t("saveFile.export.confirm")}
          </button>
        </footer>
      </section>
    </div>
  );
}

export interface SaveFileImportPreviewProps {
  preview: SaveFilePrepareResult;
  sourceLabel: string;
  canceling: boolean;
  onCancel(): void;
  onConfirm(applyPreferences: boolean): void;
}

export function SaveFileImportPreview(props: SaveFileImportPreviewProps) {
  const { t, tn } = useUiText();
  const [applyPreferences, setApplyPreferences] = useState(false);
  const visibleMissing = props.preview.missingBooks.slice(0, 3);
  return (
    <div className="save-file-backdrop" role="presentation">
      <section className="save-file-dialog save-file-import-preview" role="dialog" aria-modal="true" aria-label={t("saveFile.import.dialog")}>
        <header className="save-file-dialog-head">
          <h2>{t("saveFile.import.title")}</h2>
          <p>{t("saveFile.import.subtitle", { source: props.sourceLabel || t("saveFile.import.selected") })}</p>
        </header>
        <div className="save-file-dialog-body">
          <dl className="save-file-summary">
            <div><dt>{t("saveFile.import.bookCount")}</dt><dd>{props.preview.bookCount}</dd></div>
            <div><dt>{t("saveFile.import.newBooks")}</dt><dd>{props.preview.newBookCount}</dd></div>
            <div><dt>{t("saveFile.import.attached")}</dt><dd>{props.preview.attachedBooks.length}</dd></div>
            <div><dt>{t("saveFile.import.missing")}</dt><dd>{props.preview.missingBooks.length}</dd></div>
            <div><dt>{t("saveFile.import.conflicts")}</dt><dd>{props.preview.progressConflictCount}</dd></div>
          </dl>
          {visibleMissing.length > 0 && (
            <p className="save-file-muted">
              {t("saveFile.import.missingList", { titles: visibleMissing.map((book) => book.title || book.contentHash.slice(0, 8)).join(t("saveFile.listSeparator")) })}
              {props.preview.missingBooks.length > visibleMissing.length ? tn("saveFile.import.more", props.preview.missingBooks.length, { count: props.preview.missingBooks.length }) : ""}
            </p>
          )}
          {props.preview.hasPreferences && (
            <label className="save-file-check">
              <input
                type="checkbox"
                checked={applyPreferences}
                onChange={(event) => setApplyPreferences(event.target.checked)}
              />
              <span>{t("saveFile.import.applyPreferences")}</span>
            </label>
          )}
          <p className="save-file-muted">
            {t("saveFile.import.explain")}
          </p>
        </div>
        <footer className="save-file-dialog-actions">
          <button type="button" onClick={props.onCancel} disabled={props.canceling}>
            {props.canceling ? t("saveFile.canceling") : t("saveFile.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={props.canceling}
            onClick={() => props.onConfirm(props.preview.hasPreferences && applyPreferences)}
          >
            {t("saveFile.import.confirm")}
          </button>
        </footer>
      </section>
    </div>
  );
}

export interface SaveFileProgressPanelProps {
  state: SaveFileJobState;
  onCancel(): void;
}

export function SaveFileProgressPanel(props: SaveFileProgressPanelProps) {
  const { t } = useUiText();
  const { state } = props;
  if (state.kind === "idle" || state.kind === "prepared") return null;
  let title = t("saveFile.progress.exporting");
  let cancellable = true;
  let cancelText = t("saveFile.cancel");
  let cancelDisabled = false;
  if (state.kind === "preparing") {
    title = t("saveFile.progress.reading");
    cancelText = state.canceling ? t("saveFile.progress.cancelingShort") : t("saveFile.cancel");
    cancelDisabled = state.canceling || state.cancelTooLate;
  } else if (state.kind === "committing") {
    title = t("saveFile.progress.committing");
    cancelText = t("saveFile.progress.noCancel");
    cancellable = false;
    cancelDisabled = true;
  } else if (state.kind === "exporting") {
    cancelText = state.canceling ? t("saveFile.progress.cancelingShort") : t("saveFile.cancel");
    cancelDisabled = state.canceling || state.cancelTooLate;
  }
  const tooLate = state.kind !== "committing" && state.cancelTooLate;
  return (
    <section className="save-file-progress" role="status" aria-live="polite" aria-label={title}>
      <div className="save-file-progress-title">{title}</div>
      <div className="save-file-progress-text">{progressText(state.progress)}</div>
      {tooLate && <div className="save-file-progress-note">{t("saveFile.progress.tooLate")}</div>}
      {state.kind === "committing" && <div className="save-file-progress-note">{t("saveFile.progress.committed")}</div>}
      {cancellable && (
        <button type="button" onClick={props.onCancel} disabled={cancelDisabled}>
          {cancelText}
        </button>
      )}
    </section>
  );
}
